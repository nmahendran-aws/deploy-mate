export type DeploymentTarget = 'S3_CLOUDFRONT';
export type DeploymentTypeInput = 'static';
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

export interface AnalysisResult {
  framework: string;
  applicationType: string;
  buildCommand: string | null;
  outputDirectory: string | null;
  recommendedTarget: DeploymentTarget;
  confidence: number;
  warnings: string[];
  reasons: string[];
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
  deploymentType: DeploymentTypeInput;
  target: DeploymentTarget;
  status: DeploymentStatus;
  subdomain?: string;
  domain?: string;
  customHostname?: string;
  url: string | null;
  infrastructureUrl?: string | null;
  analysis?: AnalysisResult;
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
 * Phase 1 & Phase 2 API Contract:
 * { "repoUrl": "...", "deploymentType": "static", "subdomain": "demo", "domain": "..." }
 */
export async function createStaticDeployment(payload: {
  repoUrl: string;
  subdomain?: string;
  domain?: string;
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
      deploymentType: 'static',
      subdomain: payload.subdomain,
      domain: payload.domain,
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
