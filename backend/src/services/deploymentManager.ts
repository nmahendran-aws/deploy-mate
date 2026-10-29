import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import {
  inferArchetypeFromTarget,
  inferProviderFromTarget,
  mapProviderAndArchetypeToTarget,
  resolveDeployer,
} from '../deployers';
import { CloudProviderNotAvailableError } from '../deployers/baseDeployer';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import {
  CloudProvider,
  ConfiguredDomain,
  CreateDeploymentRequest,
  DeploymentRecord,
  DeploymentStatus,
  DeploymentTarget,
  ExecutionTenancy,
  WorkloadArchetype,
} from '../types/deployment';
import {
  mapDeploymentTypeToTarget,
  resolveServerControlledDomain,
  sanitizeUserEnvVars,
  validateBuildOverrides,
  validateGitHubRepoUrl,
  validateSubdomain,
} from '../utils/validation';
import { DeploymentJobQueue, deploymentJobQueue } from './deploymentJobQueue';
import { sharedDomainManager } from './domainManager';
import { isolatedBuildRunner } from './isolatedBuilder';
import { repositoryAnalyzer } from './repositoryAnalyzer';
import { securityGuardrails } from './securityGuardrails';
import { selfHealingEngine } from './selfHealingEngine';

export interface StartDeploymentResponse {
  ok: boolean;
  statusCode: number;
  deployment?: DeploymentRecord;
  error?: string;
  code?: string;
  remediation?: string;
  plannedTarget?: DeploymentTarget;
}

export class DeploymentManager {
  private readonly store: DeploymentStore;
  private readonly queue: DeploymentJobQueue;

  constructor(
    store: DeploymentStore = deploymentStore,
    queue: DeploymentJobQueue = deploymentJobQueue
  ) {
    this.store = store;
    this.queue = queue;
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
   * Phases 1–9:
   * - Validates GitHub URL, command/path guardrails, subdomain & domain
   * - Resolves (CloudProvider, WorkloadArchetype, ExecutionTenancy) via multi-cloud registry (DM-901)
   * - Atomically reserves hostname before deployment starts (DM-902)
   * - Enqueues job in durable bounded asynchronous worker queue with timeout watchdog (DM-903)
   */
  public async startDeployment(
    req: CreateDeploymentRequest
  ): Promise<StartDeploymentResponse> {
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

    // DM-901: Resolve CloudProvider, WorkloadArchetype, ExecutionTenancy & DeploymentTarget
    const cloudProvider: CloudProvider =
      req.cloudProvider || inferProviderFromTarget(req.target);

    const baseAwsTarget = mapDeploymentTypeToTarget(
      req.deploymentType,
      req.target,
      'S3_CLOUDFRONT'
    );

    const archetype: WorkloadArchetype =
      req.archetype || inferArchetypeFromTarget(req.target || baseAwsTarget, req.deploymentType);

    const target: DeploymentTarget =
      req.target && inferProviderFromTarget(req.target) === cloudProvider
        ? req.target
        : cloudProvider === 'AWS'
        ? baseAwsTarget
        : mapProviderAndArchetypeToTarget(cloudProvider, archetype);

    const tenancy: ExecutionTenancy = req.tenancy || 'DEPLOYMATE_MANAGED';

    // Validate provider/target availability in multi-cloud registry BEFORE reserving hostnames (DM-901 AC2)
    try {
      resolveDeployer(cloudProvider, target);
    } catch (err: unknown) {
      if (err instanceof CloudProviderNotAvailableError) {
        return {
          ok: false,
          statusCode: err.statusCode,
          code: err.code,
          error: err.message,
          remediation: err.remediation,
          plannedTarget: err.plannedTarget,
        };
      }
      return {
        ok: false,
        statusCode: 400,
        error: err instanceof Error ? err.message : 'Unsupported deployment target.',
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

    // Phase 7 & 9: Enforce queue backlog and active live deployment cost cap
    const quotaCheck = securityGuardrails.checkDeploymentQuotas(this.store);
    if (!quotaCheck.allowed || !this.queue.canAcceptMore()) {
      return {
        ok: false,
        statusCode: quotaCheck.statusCode || 429,
        error:
          quotaCheck.error ||
          'Deployment worker queue is currently at maximum capacity. Please retry shortly.',
      };
    }

    // Phase 2 Task 3 & DM-902: Reserve hostname atomically BEFORE deployment starts
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
      (archetype === 'CONTAINER_SERVICE'
        ? 'container'
        : archetype === 'SERVERLESS_FUNC'
        ? 'serverless'
        : archetype === 'SSR_WEB'
        ? 'amplify'
        : 'static');

    const snapshotBeforeEnqueue = this.queue.getSnapshot();
    const willQueueWait =
      snapshotBeforeEnqueue.activeWorkers >= snapshotBeforeEnqueue.maxConcurrency;
    const initialStatus: DeploymentStatus = willQueueWait ? 'QUEUED' : 'BUILDING';
    const initialQueuePosition = willQueueWait
      ? snapshotBeforeEnqueue.queuedJobs + 1
      : null;

    const record: DeploymentRecord = {
      deploymentId,
      orgId: req.orgId,
      projectId: req.projectId,
      environment: req.environment || 'production',
      createdByUserId: req.createdByUserId,
      cloudProvider,
      archetype,
      tenancy,
      repoUrl: repoCheck.data.normalizedUrl,
      repoOwner: repoCheck.data.owner,
      repoName: repoCheck.data.repo,
      branch: req.branch || repoCheck.data.branch || 'main',
      deploymentType: resolvedDeploymentType,
      target,
      status: initialStatus,
      queuePosition: initialQueuePosition,
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
      resources: {
        provider: cloudProvider,
      },
      auditLogs: [
        {
          timestamp: now,
          phase: initialStatus,
          level: 'INFO',
          message: willQueueWait
            ? `Deployment ${deploymentId} queued at position #${initialQueuePosition} for ${repoCheck.data.normalizedUrl} [provider=${cloudProvider}, target=${target}].`
            : `Deployment ${deploymentId} started for ${repoCheck.data.normalizedUrl} [provider=${cloudProvider}, target=${target}]${
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

    this.enqueuePipelineExecution(
      deploymentId,
      repoCheck.data.cloneUrl,
      domainConfig,
      envCheck.sanitized
    );

    return {
      ok: true,
      statusCode: 202,
      deployment: this.store.get(deploymentId) || record,
    };
  }

  private enqueuePipelineExecution(
    deploymentId: string,
    cloneUrl: string,
    domainConfig?: ConfiguredDomain,
    userEnvVars?: Record<string, string>
  ): void {
    this.queue.enqueue({
      payload: {
        deploymentId,
        cloneUrl,
        domainConfig,
        userEnvVars,
      },
      onStartBuilding: (id) => {
        const cur = this.store.get(id);
        if (cur && cur.status === 'QUEUED') {
          this.store.update(id, { status: 'BUILDING', queuePosition: null });
          this.store.addLog(
            id,
            'BUILDING',
            'INFO',
            `Worker slot acquired — transitioning ${id} from QUEUED to BUILDING.`
          );
        } else if (cur) {
          this.store.update(id, { queuePosition: null });
        }
      },
      onQueuePositionChanged: (id, pos) => {
        const cur = this.store.get(id);
        if (cur && cur.status === 'QUEUED') {
          this.store.update(id, { queuePosition: pos });
        }
      },
      onTimeout: (payload, timeoutMs) => {
        const cur = this.store.get(payload.deploymentId);
        if (!cur || cur.status === 'LIVE' || cur.status === 'DELETED') return;
        const wsPath = path.join(
          process.env.ISOLATED_BUILD_ROOT ||
            path.join(require('os').tmpdir(), 'repo2cloud-isolated-builds'),
          payload.deploymentId
        );
        isolatedBuildRunner.cleanupWorkspace(wsPath);
        const message = `Worker execution exceeded maximum duration (${timeoutMs}ms) and was terminated safely.`;
        this.store.addLog(payload.deploymentId, cur.status, 'ERROR', message);
        this.store.update(payload.deploymentId, {
          status: 'FAILED',
          queuePosition: null,
          url: null,
          error: {
            code: 'BUILD_TIMEOUT',
            message,
            phase: cur.status,
            remediation:
              'Optimize dependency installation / build scripts or upgrade workspace plan for extended build timeouts.',
          },
        });
      },
      processor: async (payload) => {
        await this.executePipeline(
          payload.deploymentId,
          payload.cloneUrl,
          payload.domainConfig,
          payload.userEnvVars
        );
      },
    });
  }

  private async executePipeline(
    deploymentId: string,
    cloneUrl: string,
    domainConfig?: ConfiguredDomain,
    userEnvVars?: Record<string, string>
  ): Promise<void> {
    let workspaceDir: string | undefined;
    let currentPhase: DeploymentStatus = 'BUILDING';

    const isAbortedOrTimedOut = (): boolean => {
      const latest = this.store.get(deploymentId);
      return !latest || latest.status === 'FAILED' || latest.status === 'DELETED';
    };

    const setStatus = (status: DeploymentStatus, message?: string) => {
      if (isAbortedOrTimedOut()) return;
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
      if (!record || record.status === 'FAILED' || record.status === 'DELETED') return;

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

      if (isAbortedOrTimedOut()) return;

      const analysis = prep.clonedFromRemote
        ? repositoryAnalyzer.analyzeDirectory(prep.repoDir)
        : await repositoryAnalyzer.analyzeRemoteGitHubRepo(
            record.repoOwner,
            record.repoName,
            record.branch
          );

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

      const deployer = resolveDeployer(record.cloudProvider, record.target);
      const compatibility = deployer.validateCompatibility(analysis);
      if (!compatibility.compatible) {
        const err = new Error(
          compatibility.reason || 'Repository is not compatible with selected target.'
        );
        (err as Error & { code?: string; remediation?: string }).code =
          'INCOMPATIBLE_STATIC_REPO';
        (err as Error & { code?: string; remediation?: string }).remediation =
          compatibility.remediation;
        throw err;
      }

      this.store.updateChecklist(deploymentId, { repositoryAnalyzed: true });
      await stepDelay(record.dryRun ? 200 : 50);

      if (isAbortedOrTimedOut()) return;

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

      if (isAbortedOrTimedOut()) return;

      this.store.updateChecklist(deploymentId, { buildCompleted: true });
      this.store.addLog(
        deploymentId,
        'BUILDING',
        'SUCCESS',
        `Isolated build completed in ${buildResult.durationMs}ms.`
      );
      await stepDelay(record.dryRun ? 200 : 50);

      // Phase 2 Task 4: Request or configure ACM TLS certificate if custom subdomain requested
      let acmCertificateArn: string | undefined;
      const latestRecord = this.store.get(deploymentId);
      if (!latestRecord || isAbortedOrTimedOut()) return;

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

      if (isAbortedOrTimedOut()) return;

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

      if (isAbortedOrTimedOut()) return;

      this.store.update(deploymentId, {
        infrastructureUrl: deployOutput.infrastructureUrl,
      });
      this.store.updateChecklist(deploymentId, { cloudResourcesConfigured: true });
      await stepDelay(latestRecord.dryRun ? 200 : 50);

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
        await stepDelay(latestRecord.dryRun ? 200 : 50);
      }

      if (isAbortedOrTimedOut()) return;

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

      if (isAbortedOrTimedOut()) return;

      this.store.updateChecklist(deploymentId, { httpsAndDomainVerified: true });

      const completedAt = new Date().toISOString();
      this.store.update(deploymentId, {
        status: 'LIVE',
        queuePosition: null,
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
      if (isAbortedOrTimedOut()) return;
      const errorObj = err as Error & { code?: string; remediation?: string };
      const message = errorObj?.message || 'Deployment failed.';
      const diagnosis = selfHealingEngine.diagnoseFailure(message, currentPhase);
      const code = errorObj?.code || diagnosis.errorCode || 'DEPLOYMENT_FAILED';

      this.store.addLog(deploymentId, currentPhase, 'ERROR', message);
      this.store.update(deploymentId, {
        status: 'FAILED',
        queuePosition: null,
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
   * Phase 8 & 9: Manual 1-Click Self-Healing Retry for a FAILED deployment via worker queue.
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

    const snap = this.queue.getSnapshot();
    const willQueue = snap.activeWorkers >= snap.maxConcurrency;
    const nextRetryCount = (existing.retryCount || 0) + 1;

    const updated = this.store.update(deploymentId, {
      status: willQueue ? 'QUEUED' : 'BUILDING',
      queuePosition: willQueue ? snap.queuedJobs + 1 : null,
      error: null,
      url: null,
      retryCount: nextRetryCount,
    });

    this.store.addLog(
      deploymentId,
      willQueue ? 'QUEUED' : 'BUILDING',
      'INFO',
      `[Phase 8 Self-Healing] Initiating manual retry #${nextRetryCount} for ${existing.repoUrl}...`
    );

    this.enqueuePipelineExecution(deploymentId, `${existing.repoUrl}.git`, domainConfig);

    return {
      ok: true,
      statusCode: 202,
      deployment: updated,
    };
  }

  /**
   * Deletes all cloud infrastructure and releases the reserved custom hostname in the database.
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

    const deployer = resolveDeployer(existing.cloudProvider || 'AWS', existing.target);
    this.store.addLog(
      deploymentId,
      existing.status,
      'INFO',
      `Initiating ${existing.cloudProvider || 'AWS'} infrastructure & DNS cleanup for ${deploymentId}...`
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
      queuePosition: null,
      url: null,
      infrastructureUrl: null,
    });

    this.store.addLog(
      deploymentId,
      'DELETED',
      'SUCCESS',
      `All cloud resources deleted and hostname ${existing.customHostname || '(none)'} released.`
    );

    return {
      ok: true,
      statusCode: 200,
      deployment: updated,
    };
  }
}

export const deploymentManager = new DeploymentManager();
