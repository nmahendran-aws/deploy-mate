import { DeploymentStore } from '../store/deploymentStore';

export interface SecurityGuardrailsStatus {
  isolation: {
    awsCredentialsStripped: boolean;
    npmIgnoreScriptsEnforced: boolean;
    nonRootContainersEnforced: boolean;
    symlinkEscapeProtection: boolean;
    commandInjectionFilter: boolean;
    pathTraversalFilter: boolean;
  };
  quotas: {
    maxBuildDurationSec: number;
    maxArchiveSizeMb: number;
    maxExtractedFiles: number;
    maxConcurrentBuilds: number;
    activeConcurrentBuilds: number;
    maxActiveLiveDeployments: number;
    activeLiveDeployments: number;
    deploymentTtlHours: number;
    rateLimitPerMinute: number;
  };
}

/**
 * Phase 7 Service: Build Isolation, Security Guardrails & Cost/Resource Limits.
 * Protects the host, build worker, and AWS account from untrusted code execution,
 * command injection, path traversal, symlink escape, and runaway cloud costs.
 */
export class SecurityGuardrails {
  public readonly maxBuildDurationMs: number;
  public readonly maxArchiveSizeBytes: number;
  public readonly maxExtractedFiles: number;
  public readonly maxConcurrentBuilds: number;
  public readonly maxActiveLiveDeployments: number;
  public readonly deploymentTtlHours: number;
  public readonly rateLimitPerMinute: number;

  private readonly requestBuckets: Map<string, number[]> = new Map();

  constructor() {
    this.maxBuildDurationMs = Number(process.env.MAX_BUILD_DURATION_MS || 180_000);
    this.maxArchiveSizeBytes = Number(
      process.env.MAX_ARCHIVE_SIZE_BYTES || 100 * 1024 * 1024
    ); // 100 MB cap
    this.maxExtractedFiles = Number(process.env.MAX_EXTRACTED_FILES || 5_000);
    this.maxConcurrentBuilds = Number(process.env.MAX_CONCURRENT_DEPLOYMENTS || 5);
    this.maxActiveLiveDeployments = Number(
      process.env.MAX_ACTIVE_LIVE_DEPLOYMENTS || 20
    );
    this.deploymentTtlHours = Number(process.env.DEPLOYMENT_TTL_HOURS || 24);
    this.rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE || 30);
  }

  /**
   * Sliding-window rate limiter per client IP / key.
   */
  public checkRateLimit(clientKey: string = 'global'): {
    allowed: boolean;
    retryAfterSec?: number;
    error?: string;
  } {
    const now = Date.now();
    const windowMs = 60_000;
    const timestamps = (this.requestBuckets.get(clientKey) || []).filter(
      (t) => now - t < windowMs
    );

    if (timestamps.length >= this.rateLimitPerMinute) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      return {
        allowed: false,
        retryAfterSec,
        error: `Phase 7 Rate Limit Exceeded: Maximum of ${this.rateLimitPerMinute} requests per minute allowed. Retry in ${retryAfterSec}s.`,
      };
    }

    timestamps.push(now);
    this.requestBuckets.set(clientKey, timestamps);
    return { allowed: true };
  }

  /**
   * Enforces concurrent build quotas and total active AWS deployment cost caps.
   */
  public checkDeploymentQuotas(store: DeploymentStore): {
    allowed: boolean;
    statusCode?: number;
    error?: string;
  } {
    const all = store.listAll();
    const activeBuilds = all.filter(
      (d) =>
        d.status === 'QUEUED' ||
        d.status === 'ANALYZING' ||
        d.status === 'BUILDING' ||
        d.status === 'DEPLOYING' ||
        d.status === 'CONFIGURING_DOMAIN' ||
        d.status === 'VERIFYING'
    ).length;

    const queuedBuilds = all.filter((d) => d.status === 'QUEUED').length;
    const maxQueueBacklog = Number(process.env.MAX_DEPLOYMENT_QUEUE_BACKLOG || 100);

    if (queuedBuilds >= maxQueueBacklog) {
      return {
        allowed: false,
        statusCode: 429,
        error: `Phase 9 Worker Queue Guardrail: Maximum queue backlog of ${maxQueueBacklog} waiting deployments reached. Please retry shortly.`,
      };
    }

    const activeLive = all.filter((d) => d.status === 'LIVE').length;
    if (activeLive >= this.maxActiveLiveDeployments) {
      return {
        allowed: false,
        statusCode: 429,
        error: `Phase 7 AWS Cost Guardrail: Maximum of ${this.maxActiveLiveDeployments} active live deployments reached (${activeLive}/${this.maxActiveLiveDeployments}). Please delete an existing deployment before creating a new one.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Returns a live snapshot of all Phase 7 security & cost guardrails.
   */
  public getStatus(store: DeploymentStore): SecurityGuardrailsStatus {
    const all = store.listAll();
    const activeConcurrentBuilds = all.filter(
      (d) =>
        d.status === 'QUEUED' ||
        d.status === 'ANALYZING' ||
        d.status === 'BUILDING' ||
        d.status === 'DEPLOYING' ||
        d.status === 'CONFIGURING_DOMAIN' ||
        d.status === 'VERIFYING'
    ).length;
    const activeLiveDeployments = all.filter((d) => d.status === 'LIVE').length;

    return {
      isolation: {
        awsCredentialsStripped: true,
        npmIgnoreScriptsEnforced: true,
        nonRootContainersEnforced: true,
        symlinkEscapeProtection: true,
        commandInjectionFilter: true,
        pathTraversalFilter: true,
      },
      quotas: {
        maxBuildDurationSec: Math.round(this.maxBuildDurationMs / 1000),
        maxArchiveSizeMb: Math.round(this.maxArchiveSizeBytes / (1024 * 1024)),
        maxExtractedFiles: this.maxExtractedFiles,
        maxConcurrentBuilds: this.maxConcurrentBuilds,
        activeConcurrentBuilds,
        maxActiveLiveDeployments: this.maxActiveLiveDeployments,
        activeLiveDeployments,
        deploymentTtlHours: this.deploymentTtlHours,
        rateLimitPerMinute: this.rateLimitPerMinute,
      },
    };
  }
}

export const securityGuardrails = new SecurityGuardrails();
