import { DeploymentTarget } from '../types/deployment';
import { IDeployer } from './baseDeployer';
import { s3CloudFrontDeployer } from './s3CloudFrontDeployer';

/**
 * Phase 1 implements S3_CLOUDFRONT completely behind the common IDeployer interface.
 * Additional targets (ECS_FARGATE, LAMBDA_API_GATEWAY, AMPLIFY) plug into this registry in Phases 4–6.
 */
const DEPLOYER_REGISTRY: Partial<Record<DeploymentTarget, IDeployer>> = {
  S3_CLOUDFRONT: s3CloudFrontDeployer,
};

export function getDeployerForTarget(target: DeploymentTarget): IDeployer {
  const deployer = DEPLOYER_REGISTRY[target];
  if (!deployer) {
    throw new Error(
      `Deployer target "${target}" is not enabled in Phase 1. Currently supported target: S3_CLOUDFRONT.`
    );
  }
  return deployer;
}
