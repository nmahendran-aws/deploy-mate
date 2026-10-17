export type DeploymentTarget =
  | 'S3_CLOUDFRONT'
  | 'ECS_FARGATE'
  | 'LAMBDA_API_GATEWAY'
  | 'AMPLIFY';

export type DeploymentTypeInput =
  | 'static'
  | 'container'
  | 'serverless'
  | 'amplify'
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

export interface AnalysisResult {
  framework: string;
  applicationType: ApplicationType;
  buildCommand: string | null;
  outputDirectory: string | null;
  recommendedTarget: DeploymentTarget;
  confidence: number;
  warnings: string[];
  reasons: string[];
  signalsDetected: SignalDetection[];
  runtime?: string;
  entryPoint?: string;
  hasDockerfile?: boolean;
  isMonorepo?: boolean;
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
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  branch?: string;
  deploymentType: DeploymentTypeInput;
  target: DeploymentTarget;
  status: DeploymentStatus;
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
  resources: TrackedAwsResources;
  auditLogs: AuditLogEntry[];
  error?: {
    code: string;
    message: string;
    phase: DeploymentStatus;
    remediation?: string;
  } | null;
  dryRun: boolean;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface CreateDeploymentRequest {
  repoUrl: string;
  deploymentType?: DeploymentTypeInput;
  target?: DeploymentTarget;
  subdomain?: string;
  domain?: string;
  branch?: string;
  envVars?: Record<string, string>;
}
