import { EnvironmentType } from './tenant';

/**
 * DM-901 (#1): Cloud-agnostic provider, workload archetype, and execution tenancy models.
 */
export type CloudProvider = 'AWS' | 'GCP' | 'AZURE';

export type WorkloadArchetype =
  | 'STATIC_EDGE'
  | 'SSR_WEB'
  | 'CONTAINER_SERVICE'
  | 'SERVERLESS_FUNC';

export type ExecutionTenancy =
  | 'DEPLOYMATE_MANAGED'
  | 'CUSTOMER_BYOC';

export type AwsDeploymentTarget =
  | 'S3_CLOUDFRONT'
  | 'ECS_FARGATE'
  | 'LAMBDA_API_GATEWAY'
  | 'AMPLIFY'
  | 'FULLSTACK_SERVERLESS';

export type GcpDeploymentTarget =
  | 'GCP_STORAGE_CDN'
  | 'GCP_CLOUD_RUN'
  | 'GCP_CLOUD_FUNCTIONS';

export type AzureDeploymentTarget =
  | 'AZURE_STATIC_FRONTDOOR'
  | 'AZURE_CONTAINER_APPS'
  | 'AZURE_FUNCTIONS';

export type DeploymentTarget =
  | AwsDeploymentTarget
  | GcpDeploymentTarget
  | AzureDeploymentTarget;

export type DeploymentTypeInput =
  | 'static'
  | 'container'
  | 'serverless'
  | 'amplify'
  | 'ssr'
  | 'auto';

export type DeploymentStatus =
  | 'QUEUED'
  | 'ANALYZING'
  | 'BUILDING'
  | 'DEPLOYING'
  | 'CONFIGURING_DOMAIN'
  | 'VERIFYING'
  | 'LIVE'
  | 'FAILED'
  | 'DELETED';

export type ApplicationType =
  | 'static-frontend'
  | 'ssr-frontend'
  | 'containerized-service'
  | 'node-server'
  | 'serverless-api'
  | 'python-service'
  | 'monorepo'
  | 'unknown';

export interface SignalDetection {
  signal: string;
  description: string;
  file?: string;
}

export interface TargetOptionAssessment {
  target: DeploymentTarget;
  cloudProvider?: CloudProvider;
  archetype?: WorkloadArchetype;
  title: string;
  subtitle: string;
  fitScore: number;
  recommended: boolean;
  reason: string;
}

export interface AnalysisResult {
  framework: string;
  applicationType: ApplicationType;
  buildCommand: string | null;
  outputDirectory: string | null;
  recommendedTarget: DeploymentTarget;
  recommendedArchetype?: WorkloadArchetype;
  confidence: number;
  warnings: string[];
  reasons: string[];
  signalsDetected: SignalDetection[];
  runtime?: string;
  entryPoint?: string;
  hasDockerfile?: boolean;
  isMonorepo?: boolean;
  suggestedContainerPort?: number;
  suggestedHealthCheckPath?: string;
  suggestedLambdaHandler?: string;
  targetOptions?: TargetOptionAssessment[];
  aiExplanation?: string;
}

export interface ConfiguredDomain {
  domain: string;
  hostedZoneId: string;
  acmCertificateArn?: string;
}

export interface TrackedAwsResources {
  s3BucketName?: string;
  s3KeyPrefix?: string;
  cloudFrontDistributionId?: string;
  cloudFrontDomainName?: string;
  cloudFrontOacId?: string;
  ecrRepositoryUri?: string;
  ecsClusterName?: string;
  ecsTaskDefinitionArn?: string;
  ecsServiceName?: string;
  albTargetGroupArn?: string;
  albListenerRuleArn?: string;
  lambdaFunctionName?: string;
  lambdaRoleArn?: string;
  apiGatewayId?: string;
  apiGatewayEndpoint?: string;
  amplifyAppId?: string;
  amplifyBranchName?: string;
  acmCertificateArn?: string;
  route53HostedZoneId?: string;
  route53RecordName?: string;
  route53TargetDnsName?: string;
  route53TargetHostedZoneId?: string;
}

export interface TrackedGcpResources {
  gcsBucketName?: string;
  cloudCdnBackendName?: string;
  artifactRegistryImage?: string;
  cloudRunServiceName?: string;
  cloudRunRegion?: string;
  cloudFunctionName?: string;
  cloudDnsManagedZone?: string;
}

export interface TrackedAzureResources {
  resourceGroupName?: string;
  storageAccountName?: string;
  frontDoorEndpointName?: string;
  acrImageUri?: string;
  containerAppName?: string;
  functionAppName?: string;
  azureDnsZoneName?: string;
}

/**
 * Polymorphic cloud resource tracking manifest preserving 100% compatibility
 * with top-level AWS keys while supporting GCP (Phase 10) and Azure (Phase 11).
 */
export interface TrackedCloudResources extends TrackedAwsResources {
  provider?: CloudProvider;
  gcp?: TrackedGcpResources;
  azure?: TrackedAzureResources;
}

export interface AuditLogEntry {
  timestamp: string;
  phase: DeploymentStatus;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  message: string;
}

export interface DeploymentChecklist {
  repositoryAnalyzed: boolean;
  buildCompleted: boolean;
  cloudResourcesConfigured: boolean;
  httpsAndDomainVerified: boolean;
}

export interface DeploymentRecord {
  deploymentId: string;
  /** Multi-tenant ownership fields (DM-902 / DM-905) */
  orgId?: string;
  projectId?: string;
  environment?: EnvironmentType;
  createdByUserId?: string;
  /** Cloud-agnostic orchestration fields (DM-901) */
  cloudProvider: CloudProvider;
  archetype: WorkloadArchetype;
  tenancy: ExecutionTenancy;
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  branch?: string;
  deploymentType: DeploymentTypeInput;
  target: DeploymentTarget;
  status: DeploymentStatus;
  queuePosition?: number | null;
  subdomain?: string;
  domain?: string;
  customHostname?: string;
  /**
   * Populated ONLY after the deployment and HTTPS/domain checks pass (Phase 1 & 2 requirement).
   */
  url: string | null;
  /**
   * Internal infrastructure endpoint (e.g., d111111abcdef8.cloudfront.net or ALB DNS) prior to or alongside custom domain.
   */
  infrastructureUrl?: string | null;
  analysis?: AnalysisResult;
  checklist: DeploymentChecklist;
  resources: TrackedCloudResources;
  auditLogs: AuditLogEntry[];
  error?: {
    code: string;
    message: string;
    phase: DeploymentStatus;
    remediation?: string;
  } | null;
  targetConfig?: {
    buildCommand?: string | null;
    outputDirectory?: string | null;
    containerPort?: number;
    healthCheckPath?: string;
    lambdaHandler?: string;
    runtime?: string;
    envVarKeys?: string[];
  };
  dryRun: boolean;
  retryCount: number;
  /** DM-907 & DM-908: Git CI/CD metadata, immutable artifact URI, rollback & PR preview tracking */
  triggerSource?: 'manual' | 'github_push' | 'github_pr' | 'rollback';
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
  artifactUri?: string;
  prNumber?: number;
  prCommentId?: string;
  rolledBackFromDeploymentId?: string;
  isProductionActive?: boolean;
  githubCheckStatus?: 'pending' | 'success' | 'failure';
  githubInstallationId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface CreateDeploymentRequest {
  repoUrl: string;
  cloudProvider?: CloudProvider;
  archetype?: WorkloadArchetype;
  tenancy?: ExecutionTenancy;
  orgId?: string;
  projectId?: string;
  environment?: EnvironmentType;
  createdByUserId?: string;
  triggerSource?: 'manual' | 'github_push' | 'github_pr' | 'rollback';
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
  prNumber?: number;
  githubInstallationId?: string;
  deploymentType?: DeploymentTypeInput;
  target?: DeploymentTarget;
  subdomain?: string;
  domain?: string;
  branch?: string;
  buildCommandOverride?: string;
  outputDirOverride?: string;
  containerPort?: number;
  healthCheckPath?: string;
  lambdaHandler?: string;
  runtime?: string;
  envVars?: Record<string, string>;
}
