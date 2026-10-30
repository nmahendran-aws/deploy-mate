export type CloudProvider = 'AWS' | 'GCP' | 'AZURE';

export type WorkloadArchetype =
  | 'STATIC_EDGE'
  | 'SSR_WEB'
  | 'CONTAINER_SERVICE'
  | 'SERVERLESS_FUNC';

export type ExecutionTenancy = 'DEPLOYMATE_MANAGED' | 'CUSTOMER_BYOC';

export type EnvironmentType = 'production' | 'staging' | 'preview';

export type PlanTier =
  | 'CAMPUS_FREE'
  | 'PRO_BUILDER'
  | 'GROWTH_TEAM'
  | 'SCALE_AGENCY'
  | 'ENTERPRISE';

export type OrgRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';

export type DeploymentTarget =
  | 'S3_CLOUDFRONT'
  | 'ECS_FARGATE'
  | 'LAMBDA_API_GATEWAY'
  | 'AMPLIFY'
  | 'GCP_STORAGE_CDN'
  | 'GCP_CLOUD_RUN'
  | 'GCP_CLOUD_FUNCTIONS'
  | 'AZURE_STATIC_FRONTDOOR'
  | 'AZURE_CONTAINER_APPS'
  | 'AZURE_FUNCTIONS';

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

export interface UserRecord {
  userId: string;
  email: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  authProvider: 'github' | 'google' | 'email';
  studentVerified: boolean;
  academicDomain?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRecord {
  orgId: string;
  name: string;
  slug: string;
  planTier: PlanTier;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipRecord {
  membershipId: string;
  orgId: string;
  userId: string;
  userEmail: string;
  role: OrgRole;
  createdAt: string;
}

export interface ProjectRecord {
  projectId: string;
  orgId: string;
  name: string;
  slug: string;
  repoUrl: string;
  defaultBranch: string;
  cloudProvider?: CloudProvider;
  defaultProvider?: CloudProvider;
  defaultArchetype: WorkloadArchetype;
  defaultTenancy: ExecutionTenancy;
  environments: EnvironmentType[];
  activeProductionDeploymentId?: string;
  activeProductionUrl?: string | null;
  createdAt: string;
}

export interface GitHubConnectedRepo {
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  branches: string[];
  cloneUrl: string;
}

export interface MaskedSecretSummary {
  secretId: string;
  projectId: string;
  environment: EnvironmentType;
  key: string;
  maskedPreview: string;
  updatedAt: string;
}

export interface QueueSnapshot {
  maxConcurrency: number;
  maxQueueBacklog?: number;
  jobTimeoutMs: number;
  activeWorkers: number;
  queuedJobs: number;
  activeDeploymentIds?: string[];
  queuedDeploymentIds: string[];
}

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
  applicationType: string;
  buildCommand: string | null;
  outputDirectory: string | null;
  recommendedTarget: DeploymentTarget;
  recommendedArchetype?: WorkloadArchetype;
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
  orgId?: string;
  projectId?: string;
  environment?: EnvironmentType;
  createdByUserId?: string;
  cloudProvider?: CloudProvider;
  archetype?: WorkloadArchetype;
  tenancy?: ExecutionTenancy;
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
    provider?: CloudProvider;
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
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

const TOKEN_STORAGE_KEY = 'deploymate_session_token';
const ORG_STORAGE_KEY = 'deploymate_active_org_id';

export function getStoredSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredSession(token: string | null, orgId?: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  if (orgId) {
    window.localStorage.setItem(ORG_STORAGE_KEY, orgId);
  } else if (token === null) {
    window.localStorage.removeItem(ORG_STORAGE_KEY);
  }
}

export function getStoredActiveOrgId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ORG_STORAGE_KEY);
}

export function setStoredActiveOrgId(orgId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ORG_STORAGE_KEY, orgId);
}

function buildHeaders(includeJson = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getStoredSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const orgId = getStoredActiveOrgId();
  if (orgId) {
    headers['X-Org-Id'] = orgId;
  }
  return headers;
}

/**
 * POST /api/auth/session
 * DM-904: OAuth / Email sign-in with automatic .edu student verification & Personal Workspace provisioning.
 */
export async function signInSession(params: {
  email: string;
  displayName?: string;
  username?: string;
  authProvider?: 'github' | 'google' | 'email';
}): Promise<{
  token: string;
  user: UserRecord;
  defaultOrganization: OrganizationRecord;
  organizations: Array<{ organization: OrganizationRecord; role: OrgRole }>;
}> {
  const res = await fetch(`${API_BASE}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to sign in');
  }
  setStoredSession(data.token, data.defaultOrganization?.orgId);
  return data;
}

/**
 * GET /api/auth/me
 */
export async function fetchCurrentSession(): Promise<{
  user: UserRecord;
  activeOrgId: string;
  activeRole: OrgRole | null;
  organizations: Array<{ organization: OrganizationRecord; role: OrgRole }>;
} | null> {
  const token = getStoredSessionToken();
  if (!token) return null;
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: buildHeaders(),
    credentials: 'include',
  });
  if (!res.ok) {
    setStoredSession(null);
    return null;
  }
  return res.json();
}

/**
 * POST /api/auth/logout
 */
export async function signOutSession(): Promise<void> {
  setStoredSession(null);
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Ignore network error during logout
  }
}

/**
 * POST /api/orgs
 * DM-905: Creates a new Team Organization with OWNER role.
 */
export async function createTeamOrganization(params: {
  name: string;
  slug?: string;
  planTier?: PlanTier;
}): Promise<{
  organization: OrganizationRecord;
  membership: MembershipRecord;
}> {
  const res = await fetch(`${API_BASE}/orgs`, {
    method: 'POST',
    headers: buildHeaders(true),
    credentials: 'include',
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to create organization');
  }
  return data;
}

/**
 * GET /api/orgs/:orgId/members
 */
export async function listOrganizationMembers(orgId: string): Promise<{
  members: MembershipRecord[];
}> {
  const res = await fetch(`${API_BASE}/orgs/${encodeURIComponent(orgId)}/members`, {
    headers: buildHeaders(),
    credentials: 'include',
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to list members');
  }
  return data;
}

/**
 * POST /api/orgs/:orgId/members
 */
export async function inviteOrganizationMember(
  orgId: string,
  params: { email: string; role: OrgRole; displayName?: string }
): Promise<{
  membership: MembershipRecord;
  user: UserRecord;
}> {
  const res = await fetch(`${API_BASE}/orgs/${encodeURIComponent(orgId)}/members`, {
    method: 'POST',
    headers: buildHeaders(true),
    credentials: 'include',
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to invite member');
  }
  return data;
}

/**
 * GET /api/queue/status
 * DM-903: Fetches live worker queue concurrency and backlog metrics.
 */
export async function fetchQueueStatus(): Promise<QueueSnapshot> {
  const res = await fetch(`${API_BASE}/queue/status`, {
    headers: buildHeaders(),
  });
  if (!res.ok) {
    throw new Error('Failed to fetch worker queue status');
  }
  return res.json();
}

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
    headers: buildHeaders(true),
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

  const res = await fetch(`${API_BASE}/domains${query}`, {
    headers: buildHeaders(),
  });
  if (!res.ok) {
    throw new Error('Failed to load server-controlled domains');
  }
  return res.json();
}

/**
 * POST /api/deploy
 * Phases 1–9 API Contract: Multi-cloud, multi-tenant, RBAC-protected deployment.
 */
export async function createStaticDeployment(payload: {
  repoUrl: string;
  cloudProvider?: CloudProvider;
  archetype?: WorkloadArchetype;
  tenancy?: ExecutionTenancy;
  environment?: EnvironmentType;
  projectId?: string;
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
  queuePosition?: number | null;
  cloudProvider: CloudProvider;
  archetype: WorkloadArchetype;
  tenancy: ExecutionTenancy;
  target: DeploymentTarget;
  url: string | null;
  customHostname: string | null;
  deployment: DeploymentRecord;
}> {
  const res = await fetch(`${API_BASE}/deploy`, {
    method: 'POST',
    headers: buildHeaders(true),
    credentials: 'include',
    body: JSON.stringify({
      repoUrl: payload.repoUrl,
      cloudProvider: payload.cloudProvider || 'AWS',
      archetype: payload.archetype,
      tenancy: payload.tenancy || 'DEPLOYMATE_MANAGED',
      environment: payload.environment || 'production',
      projectId: payload.projectId,
      target:
        payload.cloudProvider && payload.cloudProvider !== 'AWS'
          ? undefined
          : payload.target || 'S3_CLOUDFRONT',
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
    const detail = data.remediation ? ` — ${data.remediation}` : '';
    throw new Error(`${data.error || 'Failed to start deployment'}${detail}`);
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
  const res = await fetch(`${API_BASE}/deploy/${encodeURIComponent(deploymentId)}`, {
    headers: buildHeaders(),
    credentials: 'include',
  });
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
  const res = await fetch(`${API_BASE}/deployments`, {
    headers: buildHeaders(),
    credentials: 'include',
  });
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
    headers: buildHeaders(),
    credentials: 'include',
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
 */
export async function fetchSecurityStatus(): Promise<SecurityGuardrailsStatus> {
  const res = await fetch(`${API_BASE}/security/status`, {
    headers: buildHeaders(),
  });
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
 */
export async function fetchObservabilityMetrics(): Promise<ObservabilityMetrics> {
  const res = await fetch(`${API_BASE}/observability/metrics`, {
    headers: buildHeaders(),
  });
  if (!res.ok) {
    throw new Error('Failed to fetch Phase 8 observability metrics');
  }
  return res.json();
}

/**
 * POST /api/deploy/:id/retry
 */
export async function retryFailedDeployment(deploymentId: string): Promise<{
  deploymentId: string;
  status: DeploymentStatus;
  deployment: DeploymentRecord;
}> {
  const res = await fetch(
    `${API_BASE}/deploy/${encodeURIComponent(deploymentId)}/retry`,
    {
      method: 'POST',
      headers: buildHeaders(),
      credentials: 'include',
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to retry deployment');
  }
  return data;
}

/**
 * POST /api/github/installations (DM-906)
 */
export async function connectGitHubInstallation(params: {
  accountLogin: string;
  accountType?: 'User' | 'Organization';
  accessToken?: string;
  installationId?: string;
}): Promise<{
  installation: {
    installationId: string;
    accountLogin: string;
    authMode?: 'github_app' | 'token_authenticated' | 'public_unauthenticated' | 'mock';
    hasEncryptedToken?: boolean;
    maskedTokenPreview?: string;
    repositories: GitHubConnectedRepo[];
  };
}> {
  const res = await fetch(`${API_BASE}/github/installations`, {
    method: 'POST',
    headers: buildHeaders(true),
    credentials: 'include',
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to connect GitHub App installation');
  }
  return data;
}

/**
 * GET /api/github/repos (DM-906)
 */
export async function fetchGitHubRepos(
  page = 1,
  perPage = 20
): Promise<{
  repositories: GitHubConnectedRepo[];
  page: number;
  perPage: number;
  totalCount: number;
  totalPages: number;
  installationsCount: number;
}> {
  const res = await fetch(
    `${API_BASE}/github/repos?page=${page}&perPage=${perPage}`,
    {
      headers: buildHeaders(),
      credentials: 'include',
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to load GitHub App repositories');
  }
  return data;
}

/**
 * POST /api/secrets/parse-dotenv (DM-913 AC2)
 */
export async function parseDotEnvPreview(dotEnvText: string): Promise<{
  valid: boolean;
  count: number;
  entries: Array<{ key: string; value: string; maskedPreview: string }>;
}> {
  const res = await fetch(`${API_BASE}/secrets/parse-dotenv`, {
    method: 'POST',
    headers: buildHeaders(true),
    credentials: 'include',
    body: JSON.stringify({ dotEnvText }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to parse .env content');
  }
  return data;
}

/**
 * POST /api/projects/:projectId/rollback/:deploymentId (DM-907 AC2)
 */
export async function rollbackProjectDeployment(
  projectId: string,
  deploymentId: string
): Promise<{
  ok: boolean;
  project: ProjectRecord;
  activeDeployment: DeploymentRecord;
  previousDeploymentId: string | null;
}> {
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(
      projectId
    )}/rollback/${encodeURIComponent(deploymentId)}`,
    {
      method: 'POST',
      headers: buildHeaders(),
      credentials: 'include',
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to execute instant rollback');
  }
  return data;
}
