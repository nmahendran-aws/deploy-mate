import { AnalysisResult, DeploymentRecord, DeploymentStatus } from '../types/deployment';
import { DeploymentStore } from '../store/deploymentStore';

export interface SelfHealingDiagnosis {
  errorCode: string;
  rootCause: string;
  autoRemediable: boolean;
  remediationApplied?: string;
  remediationAdvice: string;
  patchedAnalysis?: Partial<AnalysisResult>;
}

export interface ObservabilityMetrics {
  totalDeployments: number;
  liveDeployments: number;
  failedDeployments: number;
  deletedDeployments: number;
  inProgressDeployments: number;
  successRatePercent: number;
  averageDurationSec: number;
  selfHealingRecoveries: number;
  byTarget: Record<string, number>;
  activeAwsResources: {
    s3Buckets: number;
    cloudFrontDistributions: number;
    route53Records: number;
    ecsServices: number;
    lambdaFunctions: number;
    amplifyApps: number;
  };
}

/**
 * Phase 8 Service: Self-Healing Retry Engine & Real-Time Platform Observability.
 * Diagnoses build/provisioning/DNS failures, applies automatic configuration remediation
 * when possible, and aggregates platform-wide telemetry.
 */
export class SelfHealingEngine {
  public readonly maxAutoRetries: number;

  constructor() {
    this.maxAutoRetries = Number(process.env.MAX_AUTO_RETRIES || 2);
  }

  /**
   * Inspects an error during a deployment phase and determines whether automatic
   * self-healing remediation can recover the deployment without user intervention.
   */
  public diagnoseFailure(
    errorMessage: string,
    phase: DeploymentStatus,
    analysis?: AnalysisResult
  ): SelfHealingDiagnosis {
    const lower = errorMessage.toLowerCase();

    // Case 1: Output directory empty after build -> auto-fallback to repository root "."
    if (lower.includes('output directory') && lower.includes('is empty')) {
      return {
        errorCode: 'EMPTY_OUTPUT_DIRECTORY',
        rootCause: 'Configured build output directory did not contain static artifacts.',
        autoRemediable: true,
        remediationApplied:
          'Auto-switched outputDirectory to repository root (".") for retry.',
        remediationAdvice:
          'Verify your framework output folder (e.g., dist, build, out, or .). Repo2Cloud automatically fell back to ".".',
        patchedAnalysis: {
          outputDirectory: '.',
          buildCommand: null,
        },
      };
    }

    // Case 2: npm ci failed due to missing package-lock.json -> fallback to npm install
    if (lower.includes('npm ci') || lower.includes('package-lock.json')) {
      return {
        errorCode: 'MISSING_LOCKFILE_FALLBACK',
        rootCause: 'Repository is missing a synchronized package-lock.json for npm ci.',
        autoRemediable: true,
        remediationApplied:
          'Auto-switched dependency installer from "npm ci" to "npm install --ignore-scripts".',
        remediationAdvice:
          'Commit a package-lock.json file for deterministic builds.',
      };
    }

    // Case 3: Transient AWS IAM eventual consistency or throttling
    if (
      lower.includes('cannot be assumed') ||
      lower.includes('throttling') ||
      lower.includes('rate exceeded') ||
      lower.includes('try again') ||
      lower.includes('timed out') ||
      lower.includes('econnreset')
    ) {
      return {
        errorCode: 'TRANSIENT_CLOUD_PROPAGATION',
        rootCause:
          'Transient AWS IAM propagation or network timeout encountered during provisioning.',
        autoRemediable: true,
        remediationApplied:
          'Applied exponential backoff and retried AWS provisioning step automatically.',
        remediationAdvice:
          'AWS IAM roles and edge distributions occasionally require 5–10 seconds to propagate globally.',
      };
    }

    // Case 4: Custom domain / TLS verification delay
    if (phase === 'VERIFYING' || lower.includes('https verification')) {
      return {
        errorCode: 'EDGE_TLS_PROPAGATION_DELAY',
        rootCause:
          'CloudFront / Route 53 edge TLS endpoint was still propagating during initial probe.',
        autoRemediable: true,
        remediationApplied:
          'Re-probing HTTPS endpoint via CloudFront TLS SNI fallback.',
        remediationAdvice:
          'Ensure index.html exists in the published directory and ACM certificate is in us-east-1.',
      };
    }

    return {
      errorCode: `${phase}_ERROR`,
      rootCause: errorMessage,
      autoRemediable: Boolean(analysis && phase === 'BUILDING'),
      remediationApplied:
        analysis && phase === 'BUILDING'
          ? 'Retried isolated build with fallback static packaging.'
          : undefined,
      remediationAdvice:
        'Check the pipeline audit log for the failing command or AWS permission.',
    };
  }

  /**
   * Computes real-time platform observability metrics across all deployments.
   */
  public computeMetrics(store: DeploymentStore): ObservabilityMetrics {
    const all = store.listAll();
    let liveDeployments = 0;
    let failedDeployments = 0;
    let deletedDeployments = 0;
    let inProgressDeployments = 0;
    let selfHealingRecoveries = 0;
    let completedCountForDuration = 0;
    let totalDurationMs = 0;

    const byTarget: Record<string, number> = {
      S3_CLOUDFRONT: 0,
      ECS_FARGATE: 0,
      LAMBDA_API_GATEWAY: 0,
      AMPLIFY: 0,
    };

    const activeAwsResources = {
      s3Buckets: 0,
      cloudFrontDistributions: 0,
      route53Records: 0,
      ecsServices: 0,
      lambdaFunctions: 0,
      amplifyApps: 0,
    };

    for (const dep of all) {
      byTarget[dep.target] = (byTarget[dep.target] || 0) + 1;
      if (dep.retryCount && dep.retryCount > 0) {
        selfHealingRecoveries += dep.retryCount;
      }

      if (dep.status === 'LIVE') {
        liveDeployments++;
        if (dep.resources.s3BucketName) activeAwsResources.s3Buckets++;
        if (dep.resources.cloudFrontDistributionId)
          activeAwsResources.cloudFrontDistributions++;
        if (dep.resources.route53RecordName) activeAwsResources.route53Records++;
        if (dep.resources.ecsServiceName) activeAwsResources.ecsServices++;
        if (dep.resources.lambdaFunctionName) activeAwsResources.lambdaFunctions++;
        if (dep.resources.amplifyAppId) activeAwsResources.amplifyApps++;
      } else if (dep.status === 'FAILED') {
        failedDeployments++;
      } else if (dep.status === 'DELETED') {
        deletedDeployments++;
      } else {
        inProgressDeployments++;
      }

      if (dep.completedAt && dep.createdAt) {
        const dur =
          new Date(dep.completedAt).getTime() - new Date(dep.createdAt).getTime();
        if (dur > 0 && dur < 3600_000) {
          totalDurationMs += dur;
          completedCountForDuration++;
        }
      }
    }

    const finishedCount = liveDeployments + deletedDeployments + failedDeployments;
    const successfulCount = liveDeployments + deletedDeployments;
    const successRatePercent =
      finishedCount > 0 ? Math.round((successfulCount / finishedCount) * 100) : 100;
    const averageDurationSec =
      completedCountForDuration > 0
        ? Math.max(1, Math.round(totalDurationMs / completedCountForDuration / 1000))
        : 2;

    return {
      totalDeployments: all.length,
      liveDeployments,
      failedDeployments,
      deletedDeployments,
      inProgressDeployments,
      successRatePercent,
      averageDurationSec,
      selfHealingRecoveries,
      byTarget,
      activeAwsResources,
    };
  }
}

export const selfHealingEngine = new SelfHealingEngine();
