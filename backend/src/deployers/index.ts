import { DeploymentTarget } from '../types/deployment';
import { IDeployer } from './baseDeployer';
import { ecsFargateDeployer } from './ecsFargateDeployer';
import { lambdaApiGatewayDeployer } from './lambdaApiGatewayDeployer';
import { s3CloudFrontDeployer } from './s3CloudFrontDeployer';

/**
 * Phase 1, Phase 4 & Phase 5 implement S3_CLOUDFRONT, ECS_FARGATE, and LAMBDA_API_GATEWAY
 * behind the common IDeployer interface.
 */
const DEPLOYER_REGISTRY: Partial<Record<DeploymentTarget, IDeployer>> = {
  S3_CLOUDFRONT: s3CloudFrontDeployer,
  ECS_FARGATE: ecsFargateDeployer,
  LAMBDA_API_GATEWAY: lambdaApiGatewayDeployer,
};

export function getDeployerForTarget(target: DeploymentTarget): IDeployer {
  const deployer = DEPLOYER_REGISTRY[target];
  if (!deployer) {
    throw new Error(
      `Deployer target "${target}" is not enabled yet. Currently supported targets: S3_CLOUDFRONT, ECS_FARGATE, LAMBDA_API_GATEWAY.`
    );
  }
  return deployer;
}
