import { ConfiguredDomain, DeploymentTarget, DeploymentTypeInput } from '../types/deployment';

export interface ValidatedGitHubRepo {
  normalizedUrl: string;
  cloneUrl: string;
  owner: string;
  repo: string;
  branch?: string;
}

const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'admin',
  'administrator',
  'root',
  'mail',
  'email',
  'smtp',
  'pop',
  'imap',
  'ftp',
  'ssh',
  'ns1',
  'ns2',
  'dns',
  'aws',
  'console',
  'billing',
  'status',
  'auth',
  'login',
  'oauth',
  'internal',
  'metadata',
  'localhost',
]);

const BLOCKED_ENV_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
]);

/**
 * Strictly validates a GitHub repository URL to prevent SSRF, command injection,
 * or non-GitHub repository submissions.
 */
export function validateGitHubRepoUrl(rawUrl: unknown): {
  valid: boolean;
  data?: ValidatedGitHubRepo;
  error?: string;
} {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { valid: false, error: 'Repository URL is required.' };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 300) {
    return { valid: false, error: 'Repository URL exceeds maximum allowed length.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format. Expected https://github.com/<owner>/<repo>.',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: 'Only HTTPS GitHub URLs (https://github.com/...) are supported.',
    };
  }

  if (parsed.hostname.toLowerCase() !== 'github.com' && parsed.hostname.toLowerCase() !== 'www.github.com') {
    return {
      valid: false,
      error: 'Only public repositories hosted on github.com are allowed.',
    };
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return {
      valid: false,
      error: 'Repository URL must not include credentials, query parameters, or fragments.',
    };
  }

  const segments = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    return {
      valid: false,
      error: 'GitHub URL must include both owner and repository name (https://github.com/<owner>/<repo>).',
    };
  }

  const owner = segments[0];
  const rawRepo = segments[1].replace(/\.git$/i, '');

  const ownerRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
  const repoRegex = /^[a-zA-Z0-9._-]{1,100}$/;

  if (!ownerRegex.test(owner)) {
    return { valid: false, error: `Invalid GitHub owner or organization name: "${owner}".` };
  }

  if (!repoRegex.test(rawRepo) || rawRepo === '.' || rawRepo === '..') {
    return { valid: false, error: `Invalid GitHub repository name: "${rawRepo}".` };
  }

  let branch: string | undefined;
  if (segments.length >= 4 && segments[2] === 'tree') {
    const candidateBranch = segments.slice(3).join('/');
    if (!/^[a-zA-Z0-9._/-]{1,100}$/.test(candidateBranch) || candidateBranch.includes('..')) {
      return { valid: false, error: 'Invalid branch name in GitHub URL.' };
    }
    branch = candidateBranch;
  } else if (segments.length > 2) {
    return {
      valid: false,
      error: 'Please provide the root repository URL (https://github.com/<owner>/<repo>) or a /tree/<branch> URL.',
    };
  }

  const normalizedUrl = `https://github.com/${owner}/${rawRepo}`;
  const cloneUrl = `${normalizedUrl}.git`;

  return {
    valid: true,
    data: {
      normalizedUrl,
      cloneUrl,
      owner,
      repo: rawRepo,
      branch,
    },
  };
}

/**
 * Validates a requested custom subdomain against strict RFC-1123 hostname label rules
 * and reserved subdomain blocklists (Phase 2).
 */
export function validateSubdomain(rawSubdomain: unknown): {
  valid: boolean;
  subdomain?: string;
  error?: string;
} {
  if (rawSubdomain === undefined || rawSubdomain === null || rawSubdomain === '') {
    return { valid: true, subdomain: undefined };
  }

  if (typeof rawSubdomain !== 'string') {
    return { valid: false, error: 'Subdomain must be a string.' };
  }

  const normalized = rawSubdomain.trim().toLowerCase();
  if (!normalized) {
    return { valid: true, subdomain: undefined };
  }

  if (normalized.length < 2 || normalized.length > 63) {
    return {
      valid: false,
      error: 'Subdomain must be between 2 and 63 characters long.',
    };
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    return {
      valid: false,
      error:
        'Subdomain may only contain lowercase letters (a-z), digits (0-9), and hyphens (-), and cannot start or end with a hyphen.',
    };
  }

  if (normalized.includes('--')) {
    return {
      valid: false,
      error: 'Subdomain cannot contain consecutive hyphens (--).',
    };
  }

  if (RESERVED_SUBDOMAINS.has(normalized)) {
    return {
      valid: false,
      error: `Subdomain "${normalized}" is reserved and cannot be assigned.`,
    };
  }

  return { valid: true, subdomain: normalized };
}

/**
 * Parses the server-controlled list of Route 53 domains from CONFIGURED_DOMAINS.
 * Format: domainName:hostedZoneId[:acmCertArn],...
 */
export function getConfiguredDomains(): ConfiguredDomain[] {
  const raw =
    process.env.CONFIGURED_DOMAINS ||
    'repo2cloud.dev:Z0123456789ABCDEF:arn:aws:acm:us-east-1:123456789012:certificate/demo-cert,technica2026.cloud:Z9876543210FEDCBA';

  const entries = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const domains: ConfiguredDomain[] = [];
  for (const entry of entries) {
    const firstColon = entry.indexOf(':');
    if (firstColon === -1) {
      domains.push({
        domain: entry.toLowerCase(),
        hostedZoneId: 'Z0000000000DEMO',
      });
      continue;
    }

    const domain = entry.slice(0, firstColon).trim().toLowerCase();
    const rest = entry.slice(firstColon + 1).trim();
    const secondColon = rest.indexOf(':');

    if (secondColon === -1) {
      domains.push({
        domain,
        hostedZoneId: rest || 'Z0000000000DEMO',
      });
    } else {
      const hostedZoneId = rest.slice(0, secondColon).trim();
      const acmCertificateArn = rest.slice(secondColon + 1).trim();
      domains.push({
        domain,
        hostedZoneId: hostedZoneId || 'Z0000000000DEMO',
        acmCertificateArn: acmCertificateArn || undefined,
      });
    }
  }

  return domains;
}

/**
 * Validates that a requested domain is in the server-controlled domain list.
 * Users cannot supply arbitrary domains or Route 53 zone IDs.
 */
export function resolveServerControlledDomain(requestedDomain?: unknown): {
  valid: boolean;
  domainConfig?: ConfiguredDomain;
  error?: string;
} {
  const configured = getConfiguredDomains();
  if (configured.length === 0) {
    return {
      valid: false,
      error: 'No server-controlled Route 53 domains are configured.',
    };
  }

  if (requestedDomain === undefined || requestedDomain === null || requestedDomain === '') {
    return { valid: true, domainConfig: configured[0] };
  }

  if (typeof requestedDomain !== 'string') {
    return { valid: false, error: 'Domain must be a string.' };
  }

  const normalized = requestedDomain.trim().toLowerCase();
  const match = configured.find((d) => d.domain === normalized);
  if (!match) {
    return {
      valid: false,
      error: `Domain "${normalized}" is not in the server-controlled domain list. Allowed domains: ${configured
        .map((d) => d.domain)
        .join(', ')}.`,
    };
  }

  return { valid: true, domainConfig: match };
}

/**
 * Maps deploymentType or target input to a canonical DeploymentTarget.
 */
export function mapDeploymentTypeToTarget(
  deploymentType?: DeploymentTypeInput,
  explicitTarget?: DeploymentTarget,
  recommendedTarget?: DeploymentTarget
): DeploymentTarget {
  if (explicitTarget) {
    return explicitTarget;
  }

  switch (deploymentType) {
    case 'static':
      return 'S3_CLOUDFRONT';
    case 'container':
      return 'ECS_FARGATE';
    case 'serverless':
      return 'LAMBDA_API_GATEWAY';
    case 'amplify':
      return 'AMPLIFY';
    case 'auto':
    default:
      return recommendedTarget || 'S3_CLOUDFRONT';
  }
}

/**
 * Sanitizes user-supplied environment variables to block dangerous overrides.
 */
export function sanitizeUserEnvVars(
  envVars?: Record<string, string>
): { valid: boolean; sanitized: Record<string, string>; error?: string } {
  if (!envVars || typeof envVars !== 'object') {
    return { valid: true, sanitized: {} };
  }

  const sanitized: Record<string, string> = {};
  const entries = Object.entries(envVars);

  if (entries.length > 50) {
    return { valid: false, sanitized: {}, error: 'Maximum of 50 environment variables allowed.' };
  }

  for (const [key, value] of entries) {
    const trimmedKey = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(trimmedKey)) {
      return {
        valid: false,
        sanitized: {},
        error: `Invalid environment variable name: "${trimmedKey}".`,
      };
    }

    if (BLOCKED_ENV_KEYS.has(trimmedKey.toUpperCase())) {
      return {
        valid: false,
        sanitized: {},
        error: `Environment variable "${trimmedKey}" is restricted for security reasons.`,
      };
    }

    sanitized[trimmedKey] = String(value ?? '').slice(0, 4096);
  }

  return { valid: true, sanitized };
}
