import {
  AnalysisResult,
  ConfiguredDomain,
  DeploymentRecord,
  DeploymentTarget,
  TrackedAwsResources,
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
  onResourceCreated: (resources: Partial<TrackedAwsResources>) => void;
}

export interface DeployerOutput {
  infrastructureUrl: string;
  targetDnsName: string;
  targetHostedZoneId?: string;
  resources: Partial<TrackedAwsResources>;
}

/**
 * Common deployer contract implemented by S3CloudFrontDeployer, EcsFargateDeployer,
 * LambdaApiGatewayDeployer, and AmplifyDeployer.
 */
export interface IDeployer {
  readonly target: DeploymentTarget;

  /**
   * Validates whether the repository analysis is compatible with this deployer target.
   */
  validateCompatibility(analysis: AnalysisResult): {
    compatible: boolean;
    reason?: string;
    remediation?: string;
  };

  /**
   * Provisions AWS infrastructure and deploys the built application artifacts.
   */
  deploy(ctx: DeployContext): Promise<DeployerOutput>;

  /**
   * Cleans up all AWS resources provisioned for a deployment (Phase 7).
   */
  cleanup(
    record: DeploymentRecord,
    dryRun: boolean,
    onLog: (message: string) => void
  ): Promise<void>;
}
