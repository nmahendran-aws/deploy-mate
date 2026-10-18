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
  validateBuildOverrides,
  validateGitHubRepoUrl,
  validateSubdomain,
} from '../utils/validation';
import { sharedDomainManager } from './domainManager';
import { isolatedBuildRunner } from './isolatedBuilder';
import { repositoryAnalyzer } from './repositoryAnalyzer';
import { securityGuardrails } from './securityGuardrails';
import { selfHealingEngine } from './selfHealingEngine';

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
   * Phase 1–7:
   * - Validates GitHub URL
   * - Enforces Phase 7 command injection, path traversal, and env var guardrails
   * - Enforces Phase 7 concurrent build quota and AWS active deployment cost cap
   * - Validates optional subdomain & server-controlled Route 53 domain
   * - Atomically reserves the hostname in database before deployment starts
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

    // Phase 7 Task 1: Validate build overrides against command injection & path traversal
    const overridesCheck = validateBuildOverrides({
      buildCommandOverride: req.buildCommandOverride,
      outputDirOverride: req.outputDirOverride,
      healthCheckPath: req.healthCheckPath,
      lambdaHandler: req.lambdaHandler,
      containerPort: req.containerPort,
    });
    if (!overridesCheck.valid) {
      return {
        ok: false,
        statusCode: 400,
        error: overridesCheck.error,
      };
    }

    const target = mapDeploymentTypeToTarget(req.deploymentType, req.target, 'S3_CLOUDFRONT');

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

    // Phase 7 Task 3: Enforce concurrent build quota and AWS active deployment cost cap
    const quotaCheck = securityGuardrails.checkDeploymentQuotas(this.store);
    if (!quotaCheck.allowed) {
      return {
        ok: false,
        statusCode: quotaCheck.statusCode || 429,
        error: quotaCheck.error,
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

    const resolvedDeploymentType =
      req.deploymentType ||
      (target === 'ECS_FARGATE'
        ? 'container'
        : target === 'LAMBDA_API_GATEWAY'
        ? 'serverless'
        : target === 'AMPLIFY'
        ? 'amplify'
        : 'static');

    const record: DeploymentRecord = {
      deploymentId,
      repoUrl: repoCheck.data.normalizedUrl,
      repoOwner: repoCheck.data.owner,
      repoName: repoCheck.data.repo,
      branch: req.branch || repoCheck.data.branch || 'main',
      deploymentType: resolvedDeploymentType,
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

      // Phase 1 Task 4 & Phase 8 Self-Healing Build Loop
      let buildResult;
      try {
        buildResult = await isolatedBuildRunner.runIsolatedBuild({
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
      } catch (buildErr: unknown) {
        const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
        const diagnosis = selfHealingEngine.diagnoseFailure(msg, 'BUILDING', analysis);
        if (diagnosis.autoRemediable) {
          const nextRetry = (this.store.get(deploymentId)?.retryCount || 0) + 1;
          if (diagnosis.patchedAnalysis) {
            Object.assign(analysis, diagnosis.patchedAnalysis);
          }
          this.store.update(deploymentId, { retryCount: nextRetry, analysis });
          this.store.addLog(
            deploymentId,
            'BUILDING',
            'WARN',
            `[Phase 8 Self-Healing] Detected ${diagnosis.errorCode}: ${
              diagnosis.remediationApplied || 'Applying automatic build fallback...'
            } (Attempt #${nextRetry + 1})`
          );
          buildResult = await isolatedBuildRunner.runIsolatedBuild({
            deploymentId,
            workspaceDir: prep.workspaceDir,
            repoDir: prep.repoDir,
            clonedFromRemote: prep.clonedFromRemote,
            repoUrl: record.repoUrl,
            analysis: {
              ...analysis,
              outputDirectory: diagnosis.patchedAnalysis?.outputDirectory || '.',
              buildCommand: null,
            },
            userEnvVars,
            dryRun: record.dryRun,
            onLog: (m) => this.store.addLog(deploymentId, 'BUILDING', 'INFO', m),
          });
        } else {
          throw buildErr;
        }
      }

      this.store.updateChecklist(deploymentId, { buildCompleted: true });
      this.store.addLog(
        deploymentId,
        'BUILDING',
        'SUCCESS',
        `Isolated build completed in ${buildResult.durationMs}ms.`
      );
      await stepDelay(record.dryRun ? 300 : 50);

      // Phase 2 Task 4: Request or configure ACM TLS certificate if custom subdomain requested
      let acmCertificateArn: string | undefined;
      const latestRecord = this.store.get(deploymentId)!;

      if (latestRecord.subdomain && domainConfig) {
        setStatus(
          'CONFIGURING_DOMAIN',
          `Phase 2 Task 4: Ensuring ACM TLS certificate for ${latestRecord.customHostname}...`
        );
        acmCertificateArn = await sharedDomainManager.ensureTlsCertificate({
          subdomain: latestRecord.subdomain,
          domainConfig,
          target: latestRecord.target,
          dryRun: latestRecord.dryRun,
          onLog: (msg) =>
            this.store.addLog(deploymentId, 'CONFIGURING_DOMAIN', 'INFO', msg),
        });
        this.store.updateResources(deploymentId, { acmCertificateArn });
      }

      // Phase 1–6: Deploy to target AWS architecture
      const deployStatusMsg =
        latestRecord.target === 'ECS_FARGATE'
          ? 'Provisioning Amazon ECR repository, ECS Cluster, Fargate Task Definition, and ALB routing...'
          : latestRecord.target === 'LAMBDA_API_GATEWAY'
          ? 'Packaging PKZIP archive, provisioning AWS Lambda Function, and configuring API Gateway v2 HTTP API...'
          : latestRecord.target === 'AMPLIFY'
          ? 'Provisioning AWS Amplify Hosting App (WEB_COMPUTE) and production branch...'
          : 'Uploading static assets to private S3 bucket and creating CloudFront OAC distribution...';

      setStatus('DEPLOYING', deployStatusMsg);

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

      // Phase 2 Tasks 6 & 7: Create Route 53 Alias record pointing to CloudFront/ALB & poll for DNS readiness
      let finalVerifiedUrl = deployOutput.infrastructureUrl;
      const isPlaceholderZone = sharedDomainManager.isPlaceholderDomainConfig(domainConfig);
      const isSimulatedAlb =
        latestRecord.target === 'ECS_FARGATE' && !process.env.ECS_ALB_DNS_NAME;

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
          dryRun: latestRecord.dryRun || isSimulatedAlb,
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
        latestRecord.dryRun || isSimulatedAlb,
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
      const diagnosis = selfHealingEngine.diagnoseFailure(message, currentPhase);
      const code = errorObj?.code || diagnosis.errorCode || 'DEPLOYMENT_FAILED';

      this.store.addLog(deploymentId, currentPhase, 'ERROR', message);
      this.store.update(deploymentId, {
        status: 'FAILED',
        url: null,
        error: {
          code,
          message,
          phase: currentPhase,
          remediation: errorObj?.remediation || diagnosis.remediationAdvice,
        },
      });
    } finally {
      isolatedBuildRunner.cleanupWorkspace(workspaceDir);
    }
  }

  /**
   * Phase 8: Manual 1-Click Self-Healing Retry for a FAILED deployment.
   */
  public async retryDeployment(deploymentId: string): Promise<{
    ok: boolean;
    statusCode: number;
    deployment?: DeploymentRecord;
    error?: string;
  }> {
    const existing = this.store.get(deploymentId);
    if (!existing) {
      return { ok: false, statusCode: 404, error: `Deployment "${deploymentId}" not found.` };
    }
    if (existing.status !== 'FAILED') {
      return {
        ok: false,
        statusCode: 400,
        error: `Only FAILED deployments can be retried (current status: ${existing.status}).`,
      };
    }

    let domainConfig: ConfiguredDomain | undefined;
    if (existing.subdomain) {
      const domCheck = resolveServerControlledDomain(existing.domain);
      if (domCheck.valid && domCheck.domainConfig) {
        domainConfig = domCheck.domainConfig;
      }
    }

    const nextRetryCount = (existing.retryCount || 0) + 1;
    const updated = this.store.update(deploymentId, {
      status: 'BUILDING',
      error: null,
      url: null,
      retryCount: nextRetryCount,
    });

    this.store.addLog(
      deploymentId,
      'BUILDING',
      'INFO',
      `[Phase 8 Self-Healing] Initiating manual retry #${nextRetryCount} for ${existing.repoUrl}...`
    );

    void this.executePipeline(deploymentId, `${existing.repoUrl}.git`, domainConfig);

    return {
      ok: true,
      statusCode: 202,
      deployment: updated,
    };
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
