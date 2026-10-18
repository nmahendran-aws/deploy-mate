import { DeploymentTarget } from '../types/deployment';
import { amplifyDeployer } from './amplifyDeployer';
import { IDeployer } from './baseDeployer';
import { ecsFargateDeployer } from './ecsFargateDeployer';
import { lambdaApiGatewayDeployer } from './lambdaApiGatewayDeployer';
import { s3CloudFrontDeployer } from './s3CloudFrontDeployer';

/**
 * Phases 1–6 implement all 4 AWS targets (S3_CLOUDFRONT, ECS_FARGATE, LAMBDA_API_GATEWAY, AMPLIFY)
 * behind the common IDeployer interface.
 */
const DEPLOYER_REGISTRY: Record<DeploymentTarget, IDeployer> = {
  S3_CLOUDFRONT: s3CloudFrontDeployer,
  ECS_FARGATE: ecsFargateDeployer,
  LAMBDA_API_GATEWAY: lambdaApiGatewayDeployer,
  AMPLIFY: amplifyDeployer,
};

export function getDeployerForTarget(target: DeploymentTarget): IDeployer {
  const deployer = DEPLOYER_REGISTRY[target];
  if (!deployer) {
    throw new Error(
      `Unsupported deployer target "${target}". Supported targets: S3_CLOUDFRONT, ECS_FARGATE, LAMBDA_API_GATEWAY, AMPLIFY.`
    );
  }
  return deployer;
}
