import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { getDeployerForTarget } from '../deployers';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import {
  ConfiguredDomain,
  CreateDeploymentRequest,
  DeploymentRecord,
  DeploymentStatus,
  DeploymentTarget,
} from '../types/deployment';
import {
  mapDeploymentTypeToTarget,
  resolveServerControlledDomain,
  sanitizeUserEnvVars,
  validateGitHubRepoUrl,
  validateSubdomain,
} from '../utils/validation';
import { sharedDomainManager } from './domainManager';
import { isolatedBuildRunner } from './isolatedBuilder';
import { repositoryAnalyzer } from './repositoryAnalyzer';

export class DeploymentManager {
  private readonly store: DeploymentStore;

  constructor(store: DeploymentStore = deploymentStore) {
    this.store = store;
  }

  public isDryRunMode(): boolean {
    if (process.env.FORCE_DRY_RUN_TEST === 'true') {
      return true;
    }
    dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });
    dotenv.config({ override: true });
    if (process.env.AWS_DRY_RUN === 'false' && process.env.AWS_ACCESS_KEY_ID) {
      return false;
    }
    return true;
  }

  /**
   * Phase 1, Phase 2 & Phase 3:
   * - Validates GitHub URL
   * - Validates optional subdomain & server-controlled Route 53 domain
   * - Atomically reserves the hostname in database before deployment starts
   * - Applies Phase 3 target selection & dynamic target-specific configuration overrides
   * - Executes isolated build -> ACM us-east-1 cert -> Target Deployer -> Route 53 Alias -> HTTPS verification
   */
  public async startDeployment(req: CreateDeploymentRequest): Promise<{
    ok: boolean;
    statusCode: number;
    deployment?: DeploymentRecord;
    error?: string;
  }> {
    // Phase 1 Task 2: Validate the submitted GitHub URL
    const repoCheck = validateGitHubRepoUrl(req.repoUrl);
    if (!repoCheck.valid || !repoCheck.data) {
      return {
        ok: false,
        statusCode: 400,
        error: repoCheck.error || 'Invalid GitHub repository URL.',
      };
    }

    const target = mapDeploymentTypeToTarget(req.deploymentType, req.target, 'S3_CLOUDFRONT');
    if (target !== 'S3_CLOUDFRONT') {
      return {
        ok: false,
        statusCode: 400,
        error: `Target "${target}" was selected in the Phase 3 recommendation engine; its live AWS provisioner will be unlocked in ${
          target === 'ECS_FARGATE'
            ? 'Phase 4 (ECS Fargate + ALB)'
            : target === 'LAMBDA_API_GATEWAY'
            ? 'Phase 5 (Lambda + API Gateway)'
            : 'Phase 6 (AWS Amplify Hosting)'
        }. Currently active provisioner: S3_CLOUDFRONT.`,
      };
    }

    // Phase 2 Task 2: Validate the requested subdomain against strict hostname format
    const subdomainCheck = validateSubdomain(req.subdomain);
    if (!subdomainCheck.valid) {
      return {
        ok: false,
        statusCode: 400,
        error: subdomainCheck.error,
      };
    }

    // Phase 2 Task 1: Resolve server-controlled Route 53 domain
    let domainConfig: ConfiguredDomain | undefined;
    let customHostname: string | undefined;

    if (subdomainCheck.subdomain) {
      const domainCheck = resolveServerControlledDomain(req.domain);
      if (!domainCheck.valid || !domainCheck.domainConfig) {
        return {
          ok: false,
          statusCode: 400,
          error: domainCheck.error,
        };
      }
      domainConfig = domainCheck.domainConfig;
      customHostname = `${subdomainCheck.subdomain}.${domainConfig.domain}`;
    }

    const envCheck = sanitizeUserEnvVars(req.envVars);
    if (!envCheck.valid) {
      return {
        ok: false,
        statusCode: 400,
        error: envCheck.error,
      };
    }

    // Phase 2 Task 3: Reserve hostname in database BEFORE deployment starts, preventing duplicates
    const deploymentId = `dep_${crypto.randomBytes(4).toString('hex')}`;
    if (customHostname) {
      const reservation = this.store.reserveHostname(customHostname, deploymentId);
      if (!reservation.reserved) {
        return {
          ok: false,
          statusCode: 409,
          error: `Hostname "${customHostname}" is already reserved by deployment ${reservation.existingDeploymentId}. Please choose a different subdomain.`,
        };
      }
    }

    const now = new Date().toISOString();
    const dryRun = this.isDryRunMode();

    const record: DeploymentRecord = {
      deploymentId,
      repoUrl: repoCheck.data.normalizedUrl,
      repoOwner: repoCheck.data.owner,
      repoName: repoCheck.data.repo,
      branch: req.branch || repoCheck.data.branch || 'main',
      deploymentType: req.deploymentType || 'static',
      target,
      status: 'BUILDING',
      subdomain: subdomainCheck.subdomain,
      domain: domainConfig?.domain,
      customHostname,
      url: null, // Populated ONLY after deployment & HTTPS verification pass
      infrastructureUrl: null,
      targetConfig: {
        buildCommand: req.buildCommandOverride?.trim() || undefined,
        outputDirectory: req.outputDirOverride?.trim() || undefined,
        containerPort: req.containerPort,
        healthCheckPath: req.healthCheckPath,
        lambdaHandler: req.lambdaHandler,
        runtime: req.runtime,
        envVarKeys: Object.keys(envCheck.sanitized),
      },
      checklist: {
        repositoryAnalyzed: false,
        buildCompleted: false,
        cloudResourcesConfigured: false,
        httpsAndDomainVerified: false,
      },
      resources: {},
      auditLogs: [
        {
          timestamp: now,
          phase: 'BUILDING',
          level: 'INFO',
          message: `Deployment ${deploymentId} started for ${repoCheck.data.normalizedUrl} [target=${target}]${
            customHostname ? ` with reserved hostname https://${customHostname}` : ''
          }.`,
        },
      ],
      error: null,
      dryRun,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.store.create(record);

    void this.executePipeline(deploymentId, repoCheck.data.cloneUrl, domainConfig, envCheck.sanitized);

    return {
      ok: true,
      statusCode: 202,
      deployment: record,
    };
  }

  private async executePipeline(
    deploymentId: string,
    cloneUrl: string,
    domainConfig?: ConfiguredDomain,
    userEnvVars?: Record<string, string>
  ): Promise<void> {
    let workspaceDir: string | undefined;
    let currentPhase: DeploymentStatus = 'BUILDING';

    const setStatus = (status: DeploymentStatus, message?: string) => {
      currentPhase = status;
      this.store.update(deploymentId, { status });
      if (message) {
        this.store.addLog(deploymentId, status, 'INFO', message);
      }
    };

    const stepDelay = async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
    };

    try {
      const record = this.store.get(deploymentId);
      if (!record) return;

      // Phase 1 Tasks 2 & 3: Inspect package.json and identify buildCommand & outputDirectory
      this.store.addLog(
        deploymentId,
        'BUILDING',
        'INFO',
        `Inspecting repository ${record.repoUrl} and preparing isolated build workspace...`
      );

      const prep = await isolatedBuildRunner.prepareWorkspace(
        deploymentId,
        cloneUrl,
        record.branch,
        record.dryRun,
        (msg) => this.store.addLog(deploymentId, 'BUILDING', 'INFO', msg)
      );
      workspaceDir = prep.workspaceDir;

      const analysis = prep.clonedFromRemote
        ? repositoryAnalyzer.analyzeDirectory(prep.repoDir)
        : await repositoryAnalyzer.analyzeRemoteGitHubRepo(
            record.repoOwner,
            record.repoName,
            record.branch
          );

      // Apply Phase 3 dynamic form overrides if supplied by the user
      if (record.targetConfig?.buildCommand) {
        analysis.buildCommand = record.targetConfig.buildCommand;
      }
      if (record.targetConfig?.outputDirectory) {
        analysis.outputDirectory = record.targetConfig.outputDirectory;
      }

      this.store.update(deploymentId, { analysis });
      this.store.addLog(
        deploymentId,
        'BUILDING',
        'INFO',
        `Detected ${analysis.framework} (buildCommand="${
          analysis.buildCommand || 'none'
        }", outputDirectory="${analysis.outputDirectory || './'}").`
      );

      const deployer = getDeployerForTarget(record.target);
      const compatibility = deployer.validateCompatibility(analysis);
      if (!compatibility.compatible) {
        const err = new Error(compatibility.reason || 'Repository is not compatible with selected target.');
        (err as Error & { code?: string; remediation?: string }).code = 'INCOMPATIBLE_STATIC_REPO';
        (err as Error & { code?: string; remediation?: string }).remediation =
          compatibility.remediation;
        throw err;
      }

      this.store.updateChecklist(deploymentId, { repositoryAnalyzed: true });
      await stepDelay(record.dryRun ? 300 : 50);

      // Phase 1 Task 4: Build application in isolated build environment
      const buildResult = await isolatedBuildRunner.runIsolatedBuild({
        deploymentId,
        workspaceDir: prep.workspaceDir,
        repoDir: prep.repoDir,
        clonedFromRemote: prep.clonedFromRemote,
        repoUrl: record.repoUrl,
        analysis,
        userEnvVars,
        dryRun: record.dryRun,
        onLog: (msg) => this.store.addLog(deploymentId, 'BUILDING', 'INFO', msg),
      });

      this.store.updateChecklist(deploymentId, { buildCompleted: true });
      this.store.addLog(
        deploymentId,
        'BUILDING',
        'SUCCESS',
        `Isolated build completed in ${buildResult.durationMs}ms.`
      );
      await stepDelay(record.dryRun ? 300 : 50);

      // Phase 2 Task 4: Request or configure ACM TLS certificate in us-east-1 if custom subdomain requested
      let acmCertificateArn: string | undefined;
      const latestRecord = this.store.get(deploymentId)!;

      if (latestRecord.subdomain && domainConfig) {
        setStatus(
          'CONFIGURING_DOMAIN',
          `Phase 2 Task 4: Ensuring ACM TLS certificate in us-east-1 for ${latestRecord.customHostname}...`
        );
        acmCertificateArn = await sharedDomainManager.ensureTlsCertificate({
          subdomain: latestRecord.subdomain,
          domainConfig,
          target: 'S3_CLOUDFRONT',
          dryRun: latestRecord.dryRun,
          onLog: (msg) =>
            this.store.addLog(deploymentId, 'CONFIGURING_DOMAIN', 'INFO', msg),
        });
        this.store.updateResources(deploymentId, { acmCertificateArn });
      }

      // Phase 1 Tasks 5 & 6 + Phase 2 Task 5: Upload to private S3 & create CloudFront distribution (with custom alias if configured)
      setStatus(
        'DEPLOYING',
        'Uploading static assets to private S3 bucket and creating CloudFront OAC distribution...'
      );

      const deployOutput = await deployer.deploy({
        deployment: this.store.get(deploymentId)!,
        analysis,
        buildResult,
        domainConfig,
        acmCertificateArn,
        userEnvVars,
        dryRun: latestRecord.dryRun,
        onLog: (msg) => this.store.addLog(deploymentId, 'DEPLOYING', 'INFO', msg),
        onResourceCreated: (resPatch) =>
          this.store.updateResources(deploymentId, resPatch),
      });

      this.store.update(deploymentId, {
        infrastructureUrl: deployOutput.infrastructureUrl,
      });
      this.store.updateChecklist(deploymentId, { cloudResourcesConfigured: true });
      await stepDelay(latestRecord.dryRun ? 300 : 50);

      // Phase 2 Tasks 6 & 7: Create Route 53 Alias record pointing to CloudFront & poll for DNS readiness
      let finalVerifiedUrl = deployOutput.infrastructureUrl;
      const isPlaceholderZone = sharedDomainManager.isPlaceholderDomainConfig(domainConfig);

      if (latestRecord.subdomain && domainConfig && acmCertificateArn) {
        setStatus(
          'CONFIGURING_DOMAIN',
          `Phase 2 Task 6: Creating Route 53 Alias record for ${latestRecord.customHostname} -> ${deployOutput.targetDnsName}...`
        );

        const domainRes = await sharedDomainManager.configureRoute53AliasRecord({
          subdomain: latestRecord.subdomain,
          domainConfig,
          targetDnsName: deployOutput.targetDnsName,
          targetHostedZoneId: deployOutput.targetHostedZoneId,
          acmCertificateArn,
          dryRun: latestRecord.dryRun,
          onLog: (msg) =>
            this.store.addLog(deploymentId, 'CONFIGURING_DOMAIN', 'INFO', msg),
        });

        this.store.updateResources(deploymentId, {
          route53HostedZoneId: domainRes.route53HostedZoneId,
          route53RecordName: domainRes.route53RecordName,
          route53TargetDnsName: domainRes.route53TargetDnsName,
          route53TargetHostedZoneId: domainRes.route53TargetHostedZoneId,
        });

        finalVerifiedUrl = domainRes.httpsUrl;
        await stepDelay(latestRecord.dryRun ? 300 : 50);
      }

      // Phase 1 Task 7 & Phase 2 Task 8: Verify HTTPS reachability before marking URL live
      setStatus(
        'VERIFYING',
        `Phase 2 Task 8: Verifying HTTPS & TLS readiness for ${finalVerifiedUrl}...`
      );

      await sharedDomainManager.verifyHttpsEndpoint(
        finalVerifiedUrl,
        latestRecord.dryRun,
        isPlaceholderZone,
        deployOutput.infrastructureUrl,
        (msg) => this.store.addLog(deploymentId, 'VERIFYING', 'INFO', msg)
      );

      this.store.updateChecklist(deploymentId, { httpsAndDomainVerified: true });

      const completedAt = new Date().toISOString();
      this.store.update(deploymentId, {
        status: 'LIVE',
        url: finalVerifiedUrl,
        completedAt,
        error: null,
      });
      this.store.addLog(
        deploymentId,
        'LIVE',
        'SUCCESS',
        `Deployment verified and LIVE at ${finalVerifiedUrl}`
      );
    } catch (err: unknown) {
      const errorObj = err as Error & { code?: string; remediation?: string };
      const message = errorObj?.message || 'Deployment failed.';
      const code = errorObj?.code || 'DEPLOYMENT_FAILED';

      this.store.addLog(deploymentId, currentPhase, 'ERROR', message);
      this.store.update(deploymentId, {
        status: 'FAILED',
        url: null,
        error: {
          code,
          message,
          phase: currentPhase,
          remediation: errorObj?.remediation,
        },
      });
    } finally {
      isolatedBuildRunner.cleanupWorkspace(workspaceDir);
    }
  }

  /**
   * Deletes all AWS infrastructure (S3 bucket, CloudFront OAC & distribution, Route 53 Alias record)
   * and releases the reserved custom hostname in the database.
   */
  public async deleteDeployment(deploymentId: string): Promise<{
    ok: boolean;
    statusCode: number;
    deployment?: DeploymentRecord;
    error?: string;
  }> {
    const existing = this.store.get(deploymentId);
    if (!existing) {
      return { ok: false, statusCode: 404, error: `Deployment "${deploymentId}" not found.` };
    }

    const deployer = getDeployerForTarget(existing.target);
    this.store.addLog(
      deploymentId,
      existing.status,
      'INFO',
      `Initiating AWS infrastructure & Route 53 cleanup for ${deploymentId}...`
    );

    await deployer.cleanup(existing, existing.dryRun, (msg) =>
      this.store.addLog(deploymentId, 'DELETED', 'INFO', msg)
    );

    if (existing.resources.route53RecordName && existing.resources.route53HostedZoneId) {
      await sharedDomainManager.deleteRoute53AliasRecord({
        hostedZoneId: existing.resources.route53HostedZoneId,
        recordName: existing.resources.route53RecordName,
        targetDnsName: existing.resources.route53TargetDnsName,
        targetHostedZoneId: existing.resources.route53TargetHostedZoneId,
        dryRun: existing.dryRun,
        onLog: (msg) => this.store.addLog(deploymentId, 'DELETED', 'INFO', msg),
      });
    }

    this.store.releaseHostname(existing.customHostname, deploymentId);

    const updated = this.store.update(deploymentId, {
      status: 'DELETED',
      url: null,
      infrastructureUrl: null,
    });

    this.store.addLog(
      deploymentId,
      'DELETED',
      'SUCCESS',
      `All AWS resources deleted and hostname ${existing.customHostname || '(none)'} released.`
    );

    return {
      ok: true,
      statusCode: 200,
      deployment: updated,
    };
  }
}

export const deploymentManager = new DeploymentManager();
