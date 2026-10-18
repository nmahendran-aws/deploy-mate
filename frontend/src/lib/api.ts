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

export interface SignalDetection {
  signal: string;
  description: string;
  file?: string;
}

export interface TargetOptionAssessment {
  target: DeploymentTarget;
  title: string;
  subtitle: string;
  fitScore: number;
  recommended: boolean;
  reason: string;
}

export interface AnalysisResult {
  framework: string;
  applicationType: string;
  buildCommand: string | null;
  outputDirectory: string | null;
  recommendedTarget: DeploymentTarget;
  confidence: number;
  warnings: string[];
  reasons: string[];
  signalsDetected?: SignalDetection[];
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

export interface AuditLogEntry {
  timestamp: string;
  phase: DeploymentStatus;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  message: string;
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
  url: string | null;
  infrastructureUrl?: string | null;
  analysis?: AnalysisResult;
  targetConfig?: {
    buildCommand?: string | null;
    outputDirectory?: string | null;
    containerPort?: number;
    healthCheckPath?: string;
    lambdaHandler?: string;
    runtime?: string;
    envVarKeys?: string[];
  };
  checklist: {
    repositoryAnalyzed: boolean;
    buildCompleted: boolean;
    cloudResourcesConfigured: boolean;
    httpsAndDomainVerified: boolean;
  };
  resources: {
    s3BucketName?: string;
    cloudFrontOacId?: string;
    cloudFrontDistributionId?: string;
    cloudFrontDomainName?: string;
    acmCertificateArn?: string;
    route53HostedZoneId?: string;
    route53RecordName?: string;
    ecrRepositoryUri?: string;
    ecsClusterName?: string;
    ecsServiceName?: string;
    ecsTaskDefinitionArn?: string;
    albTargetGroupArn?: string;
    albListenerRuleArn?: string;
    lambdaFunctionName?: string;
    lambdaRoleArn?: string;
    apiGatewayId?: string;
    apiGatewayEndpoint?: string;
    amplifyAppId?: string;
    amplifyBranchName?: string;
  };
  auditLogs: AuditLogEntry[];
  error?: {
    code: string;
    message: string;
    phase: DeploymentStatus;
    remediation?: string;
  } | null;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

/**
 * POST /api/analyze
 * Phase 3: Pre-deployment repository inspection & multi-target recommendation engine.
 */
export async function analyzeRepository(
  repoUrl: string,
  branch?: string
): Promise<{
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  analysis: AnalysisResult;
}> {
  const res = await fetch(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl, branch }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to analyze repository');
  }
  return data;
}

/**
 * GET /api/domains
 * Phase 2: Loads server-controlled domain list and checks subdomain availability.
 */
export async function fetchDomainsAndCheckSubdomain(
  subdomain?: string,
  domain?: string
): Promise<{
  domains: Array<{ domain: string; hasWildcardCert: boolean }>;
  subdomainCheck?: {
    valid: boolean;
    available: boolean;
    customHostname?: string;
    error?: string;
  };
}> {
  const params = new URLSearchParams();
  if (subdomain) params.set('subdomain', subdomain);
  if (domain) params.set('domain', domain);
  const query = params.toString() ? `?${params.toString()}` : '';

  const res = await fetch(`${API_BASE}/domains${query}`);
  if (!res.ok) {
    throw new Error('Failed to load server-controlled domains');
  }
  return res.json();
}

/**
 * POST /api/deploy
 * Phase 1, Phase 2 & Phase 3 API Contract:
 */
export async function createStaticDeployment(payload: {
  repoUrl: string;
  target?: DeploymentTarget;
  deploymentType?: DeploymentTypeInput;
  branch?: string;
  subdomain?: string;
  domain?: string;
  buildCommandOverride?: string;
  outputDirOverride?: string;
  containerPort?: number;
  healthCheckPath?: string;
  lambdaHandler?: string;
  runtime?: string;
  envVars?: Record<string, string>;
}): Promise<{
  deploymentId: string;
  status: DeploymentStatus;
  target: DeploymentTarget;
  url: string | null;
  customHostname: string | null;
  deployment: DeploymentRecord;
}> {
  const res = await fetch(`${API_BASE}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoUrl: payload.repoUrl,
      target: payload.target || 'S3_CLOUDFRONT',
      deploymentType: payload.deploymentType || 'static',
      branch: payload.branch,
      subdomain: payload.subdomain,
      domain: payload.domain,
      buildCommandOverride: payload.buildCommandOverride,
      outputDirOverride: payload.outputDirOverride,
      containerPort: payload.containerPort,
      healthCheckPath: payload.healthCheckPath,
      lambdaHandler: payload.lambdaHandler,
      runtime: payload.runtime,
      envVars: payload.envVars,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to start deployment');
  }
  return data;
}

/**
 * GET /api/deploy/:id
 */
export async function getDeploymentStatus(deploymentId: string): Promise<{
  deploymentId: string;
  status: DeploymentStatus;
  target: DeploymentTarget;
  url: string | null;
  customHostname: string | null;
  deployment: DeploymentRecord;
}> {
  const res = await fetch(`${API_BASE}/deploy/${encodeURIComponent(deploymentId)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to fetch deployment status');
  }
  return data;
}

/**
 * GET /api/deployments
 */
export async function listDeployments(): Promise<{
  deployments: DeploymentRecord[];
}> {
  const res = await fetch(`${API_BASE}/deployments`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to fetch deployments');
  }
  return data;
}

/**
 * DELETE /api/deploy/:id
 */
export async function deleteDeploymentInfrastructure(
  deploymentId: string
): Promise<{
  deploymentId: string;
  status: DeploymentStatus;
  deployment: DeploymentRecord;
}> {
  const res = await fetch(`${API_BASE}/deploy/${encodeURIComponent(deploymentId)}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to delete deployment infrastructure');
  }
  return data;
}

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
 * GET /api/security/status
 * Phase 7: Fetches active build isolation flags and AWS cost/resource quotas.
 */
export async function fetchSecurityStatus(): Promise<SecurityGuardrailsStatus> {
  const res = await fetch(`${API_BASE}/security/status`);
  if (!res.ok) {
    throw new Error('Failed to fetch Phase 7 security guardrails status');
  }
  return res.json();
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
 * GET /api/observability/metrics
 * Phase 8: Fetches real-time platform observability metrics and AWS resource counts.
 */
export async function fetchObservabilityMetrics(): Promise<ObservabilityMetrics> {
  const res = await fetch(`${API_BASE}/observability/metrics`);
  if (!res.ok) {
    throw new Error('Failed to fetch Phase 8 observability metrics');
  }
  return res.json();
}

/**
 * POST /api/deploy/:id/retry
 * Phase 8: Triggers a 1-click self-healing retry for a FAILED deployment.
 */
export async function retryFailedDeployment(deploymentId: string): Promise<{
  deploymentId: string;
  status: DeploymentStatus;
  deployment: DeploymentRecord;
}> {
  const res = await fetch(
    `${API_BASE}/deploy/${encodeURIComponent(deploymentId)}/retry`,
    { method: 'POST' }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to retry deployment');
  }
  return data;
}


