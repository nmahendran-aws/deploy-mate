import {
  AnalysisResult,
  CloudProvider,
  ConfiguredDomain,
  DeploymentRecord,
  DeploymentTarget,
  TrackedCloudResources,
  WorkloadArchetype,
} from '../types/deployment';
import { IsolatedBuildResult } from '../services/isolatedBuilder';

export interface DeployContext {
  deployment: DeploymentRecord;
  analysis: AnalysisResult;
  buildResult: IsolatedBuildResult;
  domainConfig?: ConfiguredDomain;
  acmCertificateArn?: string;
  userEnvVars?: Record<string, string>;
  dryRun: boolean;
  onLog: (message: string) => void;
  onResourceCreated: (resources: Partial<TrackedCloudResources>) => void;
}

export interface DeployerOutput {
  infrastructureUrl: string;
  targetDnsName: string;
  targetHostedZoneId?: string;
  resources: Partial<TrackedCloudResources>;
}

/**
 * Structured error returned when a cloud provider / workload archetype is not yet enabled (DM-901 AC2).
 */
export class CloudProviderNotAvailableError extends Error {
  public readonly statusCode: number = 501;
  public readonly code: string = 'CLOUD_PROVIDER_COMING_SOON';
  public readonly provider: CloudProvider;
  public readonly archetype: WorkloadArchetype;
  public readonly plannedTarget: DeploymentTarget;
  public readonly remediation: string;

  constructor(params: {
    provider: CloudProvider;
    archetype: WorkloadArchetype;
    plannedTarget: DeploymentTarget;
    remediation: string;
  }) {
    super(
      `Cloud provider "${params.provider}" (${params.plannedTarget} for ${params.archetype}) is registered in the multi-cloud catalog and scheduled for upcoming rollout.`
    );
    this.name = 'CloudProviderNotAvailableError';
    this.provider = params.provider;
    this.archetype = params.archetype;
    this.plannedTarget = params.plannedTarget;
    this.remediation = params.remediation;
  }
}

/**
 * Common cloud-agnostic deployer contract implemented by AWS, GCP, and Azure deployers.
 */
export interface IDeployer {
  readonly target: DeploymentTarget;
  readonly cloudProvider?: CloudProvider;
  readonly archetype?: WorkloadArchetype;

  /**
   * Validates whether the repository analysis is compatible with this deployer target.
   */
  validateCompatibility(analysis: AnalysisResult): {
    compatible: boolean;
    reason?: string;
    remediation?: string;
  };

  /**
   * Provisions cloud infrastructure and deploys the built application artifacts.
   */
  deploy(ctx: DeployContext): Promise<DeployerOutput>;

  /**
   * Cleans up all cloud resources provisioned for a deployment.
   */
  cleanup(
    record: DeploymentRecord,
    dryRun: boolean,
    onLog: (message: string) => void
  ): Promise<void>;
}
