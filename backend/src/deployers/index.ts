import {
  AwsDeploymentTarget,
  CloudProvider,
  DeploymentTarget,
  DeploymentTypeInput,
  WorkloadArchetype,
} from '../types/deployment';
import { amplifyDeployer } from './amplifyDeployer';
import { CloudProviderNotAvailableError, IDeployer } from './baseDeployer';
import { ecsFargateDeployer } from './ecsFargateDeployer';
import { lambdaApiGatewayDeployer } from './lambdaApiGatewayDeployer';
import { s3CloudFrontDeployer } from './s3CloudFrontDeployer';

/**
 * DM-901 (#1): Two-dimensional Multi-Cloud Deployer Registry indexed by (CloudProvider, DeploymentTarget).
 * AWS targets are active today; GCP (Phase 10) and Azure (Phase 11) plug into the exact same registry.
 */
const AWS_DEPLOYER_REGISTRY: Record<AwsDeploymentTarget, IDeployer> = {
  S3_CLOUDFRONT: s3CloudFrontDeployer,
  ECS_FARGATE: ecsFargateDeployer,
  LAMBDA_API_GATEWAY: lambdaApiGatewayDeployer,
  AMPLIFY: amplifyDeployer,
};

const MULTI_CLOUD_ARCHETYPE_TARGETS: Record<
  CloudProvider,
  Record<WorkloadArchetype, DeploymentTarget>
> = {
  AWS: {
    STATIC_EDGE: 'S3_CLOUDFRONT',
    SSR_WEB: 'AMPLIFY',
    CONTAINER_SERVICE: 'ECS_FARGATE',
    SERVERLESS_FUNC: 'LAMBDA_API_GATEWAY',
  },
  GCP: {
    STATIC_EDGE: 'GCP_STORAGE_CDN',
    SSR_WEB: 'GCP_CLOUD_RUN',
    CONTAINER_SERVICE: 'GCP_CLOUD_RUN',
    SERVERLESS_FUNC: 'GCP_CLOUD_FUNCTIONS',
  },
  AZURE: {
    STATIC_EDGE: 'AZURE_STATIC_FRONTDOOR',
    SSR_WEB: 'AZURE_CONTAINER_APPS',
    CONTAINER_SERVICE: 'AZURE_CONTAINER_APPS',
    SERVERLESS_FUNC: 'AZURE_FUNCTIONS',
  },
};

export function inferProviderFromTarget(target?: DeploymentTarget): CloudProvider {
  if (!target) return 'AWS';
  if (target.startsWith('GCP_')) return 'GCP';
  if (target.startsWith('AZURE_')) return 'AZURE';
  return 'AWS';
}

export function inferArchetypeFromTarget(
  target?: DeploymentTarget,
  deploymentType?: DeploymentTypeInput
): WorkloadArchetype {
  switch (target) {
    case 'S3_CLOUDFRONT':
    case 'GCP_STORAGE_CDN':
    case 'AZURE_STATIC_FRONTDOOR':
      return 'STATIC_EDGE';
    case 'AMPLIFY':
      return 'SSR_WEB';
    case 'ECS_FARGATE':
    case 'GCP_CLOUD_RUN':
    case 'AZURE_CONTAINER_APPS':
      return deploymentType === 'ssr' ? 'SSR_WEB' : 'CONTAINER_SERVICE';
    case 'LAMBDA_API_GATEWAY':
    case 'GCP_CLOUD_FUNCTIONS':
    case 'AZURE_FUNCTIONS':
      return 'SERVERLESS_FUNC';
    default:
      if (deploymentType === 'container') return 'CONTAINER_SERVICE';
      if (deploymentType === 'serverless') return 'SERVERLESS_FUNC';
      if (deploymentType === 'amplify' || deploymentType === 'ssr') return 'SSR_WEB';
      return 'STATIC_EDGE';
  }
}

export function mapProviderAndArchetypeToTarget(
  provider: CloudProvider,
  archetype: WorkloadArchetype
): DeploymentTarget {
  return MULTI_CLOUD_ARCHETYPE_TARGETS[provider][archetype];
}

/**
 * Resolves a cloud deployer by `(CloudProvider, WorkloadArchetype | DeploymentTarget)`.
 * Throws a structured `501 CLOUD_PROVIDER_COMING_SOON` error when GCP or Azure is requested
 * prior to Phase 10 / Phase 11 activation (DM-901 AC2).
 */
export function resolveDeployer(
  provider: CloudProvider,
  archetypeOrTarget: WorkloadArchetype | DeploymentTarget
): IDeployer {
  const isArchetype =
    archetypeOrTarget === 'STATIC_EDGE' ||
    archetypeOrTarget === 'SSR_WEB' ||
    archetypeOrTarget === 'CONTAINER_SERVICE' ||
    archetypeOrTarget === 'SERVERLESS_FUNC';

  const archetype: WorkloadArchetype = isArchetype
    ? archetypeOrTarget
    : inferArchetypeFromTarget(archetypeOrTarget);

  const resolvedTarget: DeploymentTarget = isArchetype
    ? mapProviderAndArchetypeToTarget(provider, archetype)
    : archetypeOrTarget;

  if (provider === 'AWS' && resolvedTarget in AWS_DEPLOYER_REGISTRY) {
    return AWS_DEPLOYER_REGISTRY[resolvedTarget as AwsDeploymentTarget];
  }

  if (provider === 'GCP' || resolvedTarget.startsWith('GCP_')) {
    const plannedTarget = mapProviderAndArchetypeToTarget('GCP', archetype);
    throw new CloudProviderNotAvailableError({
      provider: 'GCP',
      archetype,
      plannedTarget,
      remediation:
        'Select cloudProvider="AWS" now, or enable GCP native deployers (Cloud Storage CDN, Cloud Run v2, Cloud Functions Gen 2) in Phase 10 (DM-E7).',
    });
  }

  if (provider === 'AZURE' || resolvedTarget.startsWith('AZURE_')) {
    const plannedTarget = mapProviderAndArchetypeToTarget('AZURE', archetype);
    throw new CloudProviderNotAvailableError({
      provider: 'AZURE',
      archetype,
      plannedTarget,
      remediation:
        'Select cloudProvider="AWS" now, or enable Microsoft Azure native deployers (Front Door, Container Apps, Functions) in Phase 11 (DM-E10).',
    });
  }

  throw new Error(
    `Unsupported deployer target "${resolvedTarget}" for provider "${provider}".`
  );
}

/**
 * Backward-compatible helper used by Phase 1–8 callers.
 */
export function getDeployerForTarget(target: DeploymentTarget): IDeployer {
  const provider = inferProviderFromTarget(target);
  return resolveDeployer(provider, target);
}
