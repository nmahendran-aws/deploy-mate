import { Request, Response, Router } from 'express';
import { authService } from '../services/authService';
import { DeploymentJobQueue, deploymentJobQueue } from '../services/deploymentJobQueue';
import { DeploymentManager, deploymentManager } from '../services/deploymentManager';
import { repositoryAnalyzer } from '../services/repositoryAnalyzer';
import { securityGuardrails } from '../services/securityGuardrails';
import { selfHealingEngine } from '../services/selfHealingEngine';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import { EnvironmentType } from '../types/tenant';
import {
  getConfiguredDomains,
  resolveServerControlledDomain,
  validateGitHubRepoUrl,
  validateSubdomain,
} from '../utils/validation';

const VALID_ENVIRONMENTS = new Set<EnvironmentType>([
  'production',
  'staging',
  'preview',
]);

export function createDeployRouter(
  store: DeploymentStore = deploymentStore,
  manager: DeploymentManager = deploymentManager,
  queue: DeploymentJobQueue = deploymentJobQueue
): Router {
  const router = Router();

  /**
   * GET /api/clouds
   * DM-901: Multi-cloud provider & workload archetype capability catalog.
   */
  router.get('/clouds', (_req: Request, res: Response) => {
    return res.json({
      providers: [
        {
          provider: 'AWS',
          name: 'Amazon Web Services',
          status: 'LIVE',
          phase: 'Phase 1–9',
          supportedTenancies: ['DEPLOYMATE_MANAGED', 'CUSTOMER_BYOC'],
          targets: [
            { archetype: 'STATIC_EDGE', target: 'S3_CLOUDFRONT', label: 'S3 + CloudFront (OAC)' },
            { archetype: 'CONTAINER_SERVICE', target: 'ECS_FARGATE', label: 'ECS Fargate + ALB' },
            { archetype: 'SERVERLESS_FUNC', target: 'LAMBDA_API_GATEWAY', label: 'Lambda + API Gateway v2' },
            { archetype: 'SSR_WEB', target: 'AMPLIFY', label: 'AWS Amplify Hosting' },
          ],
        },
        {
          provider: 'GCP',
          name: 'Google Cloud Platform',
          status: 'COMING_SOON',
          phase: 'Phase 10',
          supportedTenancies: ['DEPLOYMATE_MANAGED', 'CUSTOMER_BYOC'],
          targets: [
            { archetype: 'STATIC_EDGE', target: 'GCP_STORAGE_CDN', label: 'Cloud Storage + Cloud CDN' },
            { archetype: 'CONTAINER_SERVICE', target: 'GCP_CLOUD_RUN', label: 'Cloud Run Serverless Containers' },
            { archetype: 'SERVERLESS_FUNC', target: 'GCP_CLOUD_FUNCTIONS', label: 'Cloud Functions Gen2' },
            { archetype: 'SSR_WEB', target: 'GCP_CLOUD_RUN', label: 'Cloud Run Next.js SSR' },
          ],
        },
        {
          provider: 'AZURE',
          name: 'Microsoft Azure',
          status: 'COMING_SOON',
          phase: 'Phase 11',
          supportedTenancies: ['DEPLOYMATE_MANAGED', 'CUSTOMER_BYOC'],
          targets: [
            { archetype: 'STATIC_EDGE', target: 'AZURE_STATIC_FRONTDOOR', label: 'Azure Blob + Front Door CDN' },
            { archetype: 'CONTAINER_SERVICE', target: 'AZURE_CONTAINER_APPS', label: 'Azure Container Apps + ACR' },
            { archetype: 'SERVERLESS_FUNC', target: 'AZURE_FUNCTIONS', label: 'Azure Functions Flex' },
            { archetype: 'SSR_WEB', target: 'AZURE_CONTAINER_APPS', label: 'Azure Container Apps SSR' },
          ],
        },
      ],
    });
  });

  /**
   * GET /api/queue/status
   * DM-903: Real-time worker queue concurrency, backlog depth, and timeout watchdog status.
   */
  router.get('/queue/status', (_req: Request, res: Response) => {
    return res.json(queue.getSnapshot());
  });

  /**
   * GET /api/security/status
   * Phase 7: Returns active build isolation flags, command/path guardrail status,
   * concurrent build usage, and AWS active deployment cost caps.
   */
  router.get('/security/status', (_req: Request, res: Response) => {
    return res.json(securityGuardrails.getStatus(store));
  });

  /**
   * GET /api/observability/metrics
   * Phase 8: Returns real-time platform observability metrics, success rate,
   * average duration, self-healing recovery count, and active AWS resource breakdown.
   */
  router.get('/observability/metrics', (_req: Request, res: Response) => {
    return res.json(selfHealingEngine.computeMetrics(store));
  });

  /**
   * POST /api/analyze
   * Phase 3: Pre-deployment repository inspection & multi-target recommendation engine.
   */
  router.post('/analyze', async (req: Request, res: Response) => {
    const rateCheck = securityGuardrails.checkRateLimit(req.ip || 'analyze-client');
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: rateCheck.error });
    }

    const { repoUrl, branch } = req.body || {};
    const repoCheck = validateGitHubRepoUrl(repoUrl);
    if (!repoCheck.valid || !repoCheck.data) {
      return res.status(400).json({
        error: repoCheck.error || 'Invalid GitHub repository URL.',
      });
    }

    const effectiveBranch =
      typeof branch === 'string' && branch.trim()
        ? branch.trim()
        : repoCheck.data.branch || 'main';

    const analysis = await repositoryAnalyzer.analyzeRemoteGitHubRepo(
      repoCheck.data.owner,
      repoCheck.data.repo,
      effectiveBranch
    );

    return res.json({
      repoUrl: repoCheck.data.normalizedUrl,
      owner: repoCheck.data.owner,
      repo: repoCheck.data.repo,
      branch: effectiveBranch,
      analysis,
    });
  });

  /**
   * GET /api/domains
   * Phase 2: Returns the server-controlled domain list and optionally checks
   * whether a requested subdomain is valid and available in the reservation store.
   */
  router.get('/domains', (req: Request, res: Response) => {
    const configured = getConfiguredDomains().map((d) => ({
      domain: d.domain,
      hasWildcardCert: Boolean(d.acmCertificateArn),
    }));

    const rawSubdomain = req.query.subdomain;
    const rawDomain = req.query.domain;

    if (typeof rawSubdomain === 'string' && rawSubdomain.trim()) {
      const subCheck = validateSubdomain(rawSubdomain);
      const domCheck = resolveServerControlledDomain(rawDomain);

      if (!subCheck.valid) {
        return res.json({
          domains: configured,
          subdomainCheck: {
            valid: false,
            available: false,
            error: subCheck.error,
          },
        });
      }

      if (!domCheck.valid || !domCheck.domainConfig) {
        return res.json({
          domains: configured,
          subdomainCheck: {
            valid: false,
            available: false,
            error: domCheck.error,
          },
        });
      }

      const customHostname = `${subCheck.subdomain}.${domCheck.domainConfig.domain}`;
      const available = store.isHostnameAvailable(customHostname);

      return res.json({
        domains: configured,
        subdomainCheck: {
          valid: true,
          available,
          customHostname,
          error: available
            ? undefined
            : `Hostname "${customHostname}" is already reserved by an active deployment.`,
        },
      });
    }

    return res.json({ domains: configured });
  });

  /**
   * POST /api/deploy
   * Phases 1–9 API Contract: Multi-Cloud, Multi-Tenant, RBAC-Protected, Queue-Backed Deployments.
   */
  router.post('/deploy', async (req: Request, res: Response) => {
    const rateCheck = securityGuardrails.checkRateLimit(req.ip || 'deploy-client');
    if (!rateCheck.allowed) {
      return res.status(429).json({ error: rateCheck.error });
    }

    const body = req.body || {};
    const requestedEnv: EnvironmentType =
      typeof body.environment === 'string' &&
      VALID_ENVIRONMENTS.has(body.environment as EnvironmentType)
        ? (body.environment as EnvironmentType)
        : 'production';

    if (req.auth) {
      if (!req.auth.activeOrgId || !req.auth.activeRole) {
        return res.status(403).json({
          error: 'Forbidden: you do not have access to the specified organization.',
          code: 'FORBIDDEN_RBAC',
        });
      }

      const perm = authService.evaluatePermission(
        req.auth.activeRole,
        'DEPLOY',
        requestedEnv
      );
      if (!perm.allowed) {
        return res.status(403).json({
          error: perm.reason || 'Forbidden: insufficient role permissions to deploy.',
          code: 'FORBIDDEN_RBAC',
        });
      }

      if (typeof body.projectId === 'string' && body.projectId.trim()) {
        const proj = store.getProjectForOrg(body.projectId.trim(), req.auth.activeOrgId);
        if (!proj) {
          return res.status(404).json({
            error: `Project "${body.projectId}" not found in organization.`,
          });
        }
      }
    }

    const result = await manager.startDeployment({
      ...body,
      environment: requestedEnv,
      orgId: req.auth?.activeOrgId || body.orgId,
      createdByUserId: req.auth?.user.userId,
    });

    if (!result.ok || !result.deployment) {
      return res.status(result.statusCode).json({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.remediation ? { remediation: result.remediation } : {}),
        ...(result.plannedTarget ? { plannedTarget: result.plannedTarget } : {}),
      });
    }

    const dep = result.deployment;
    return res.status(result.statusCode).json({
      deploymentId: dep.deploymentId,
      status: dep.status,
      queuePosition: dep.queuePosition ?? null,
      cloudProvider: dep.cloudProvider,
      archetype: dep.archetype,
      tenancy: dep.tenancy,
      target: dep.target,
      url: dep.url, // Always null until deployment and HTTPS checks pass
      customHostname: dep.customHostname || null,
      deployment: dep,
    });
  });

  /**
   * GET /api/deploy/:id
   * Polls deployment status with strict tenant isolation (404 on cross-org IDOR).
   */
  router.get('/deploy/:id', (req: Request, res: Response) => {
    let record;
    if (req.auth) {
      if (!req.auth.activeOrgId || !req.auth.activeRole) {
        return res.status(404).json({
          error: `Deployment "${req.params.id}" not found.`,
        });
      }
      record = store.getForOrg(req.params.id, req.auth.activeOrgId);
    } else {
      record = store.get(req.params.id);
    }

    if (!record) {
      return res.status(404).json({
        error: `Deployment "${req.params.id}" not found.`,
      });
    }

    return res.json({
      deploymentId: record.deploymentId,
      status: record.status,
      queuePosition: record.queuePosition ?? null,
      cloudProvider: record.cloudProvider,
      archetype: record.archetype,
      tenancy: record.tenancy,
      target: record.target,
      url: record.status === 'LIVE' ? record.url : null,
      customHostname: record.customHostname || null,
      deployment: record,
    });
  });

  /**
   * GET /api/deployments
   * Lists deployments strictly scoped to the caller's active organization when authenticated.
   */
  router.get('/deployments', (req: Request, res: Response) => {
    if (req.auth) {
      if (!req.auth.activeOrgId || !req.auth.activeRole) {
        return res.status(403).json({
          error: 'Forbidden: you are not a member of the requested organization.',
          code: 'FORBIDDEN_RBAC',
        });
      }
      return res.json({
        deployments: store.listByOrg(req.auth.activeOrgId),
      });
    }

    const deployments = store.listAll();
    return res.json({ deployments });
  });

  /**
   * DELETE /api/deploy/:id
   * Deletes all provisioned cloud resources and releases the reserved hostname.
   * Enforces cross-tenant IDOR protection (404) before RBAC environment checks (403).
   */
  router.delete('/deploy/:id', async (req: Request, res: Response) => {
    if (req.auth) {
      if (!req.auth.activeOrgId || !req.auth.activeRole) {
        return res.status(404).json({
          error: `Deployment "${req.params.id}" not found.`,
        });
      }

      const existing = store.getForOrg(req.params.id, req.auth.activeOrgId);
      if (!existing) {
        return res.status(404).json({
          error: `Deployment "${req.params.id}" not found.`,
        });
      }

      const perm = authService.evaluatePermission(
        req.auth.activeRole,
        'DELETE_DEPLOYMENT',
        existing.environment || 'production'
      );
      if (!perm.allowed) {
        return res.status(403).json({
          error: perm.reason || 'Forbidden: insufficient permissions to delete deployment.',
          code: 'FORBIDDEN_RBAC',
        });
      }
    }

    const result = await manager.deleteDeployment(req.params.id);
    if (!result.ok || !result.deployment) {
      return res.status(result.statusCode).json({ error: result.error });
    }
    return res.status(result.statusCode).json({
      deploymentId: result.deployment.deploymentId,
      status: result.deployment.status,
      deployment: result.deployment,
    });
  });

  /**
   * POST /api/deploy/:id/retry
   * Phase 8 & 9: 1-Click Self-Healing Retry with tenant isolation and RBAC verification.
   */
  router.post('/deploy/:id/retry', async (req: Request, res: Response) => {
    if (req.auth) {
      if (!req.auth.activeOrgId || !req.auth.activeRole) {
        return res.status(404).json({
          error: `Deployment "${req.params.id}" not found.`,
        });
      }

      const existing = store.getForOrg(req.params.id, req.auth.activeOrgId);
      if (!existing) {
        return res.status(404).json({
          error: `Deployment "${req.params.id}" not found.`,
        });
      }

      const perm = authService.evaluatePermission(
        req.auth.activeRole,
        'DEPLOY',
        existing.environment || 'production'
      );
      if (!perm.allowed) {
        return res.status(403).json({
          error: perm.reason || 'Forbidden: insufficient permissions to retry deployment.',
          code: 'FORBIDDEN_RBAC',
        });
      }
    }

    const result = await manager.retryDeployment(req.params.id);
    if (!result.ok || !result.deployment) {
      return res.status(result.statusCode).json({ error: result.error });
    }
    return res.status(result.statusCode).json({
      deploymentId: result.deployment.deploymentId,
      status: result.deployment.status,
      deployment: result.deployment,
    });
  });

  /**
   * GET /api/deploy/:id/stream
   * Phase 8 & DM-903: Event-driven Server-Sent Events (SSE) real-time audit log & status stream.
   */
  router.get('/deploy/:id/stream', (req: Request, res: Response) => {
    const record = req.auth
      ? req.auth.activeOrgId && req.auth.activeRole
        ? store.getForOrg(req.params.id, req.auth.activeOrgId)
        : undefined
      : store.get(req.params.id);

    if (!record) {
      return res.status(404).json({ error: `Deployment "${req.params.id}" not found.` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;
    let lastSignature = '';

    const cleanup = () => {
      if (closed) return;
      closed = true;
      store.events.off(`deployment:${req.params.id}`, onStoreEvent);
      clearInterval(heartbeatTimer);
    };

    const sendSnapshot = (latest?: typeof record): boolean => {
      if (closed) return true;
      const dep = latest || store.get(req.params.id);
      if (!dep) return true;

      const sig = `${dep.status}:${dep.queuePosition ?? ''}:${dep.auditLogs.length}:${dep.url ?? ''}`;
      if (sig !== lastSignature) {
        lastSignature = sig;
        res.write(`data: ${JSON.stringify({ deployment: dep })}\n\n`);
      }

      return (
        dep.status === 'LIVE' ||
        dep.status === 'FAILED' ||
        dep.status === 'DELETED'
      );
    };

    const onStoreEvent = (updatedRecord: NonNullable<typeof record>) => {
      if (sendSnapshot(updatedRecord)) {
        cleanup();
        res.end();
      }
    };

    if (sendSnapshot(record)) {
      res.end();
      return;
    }

    store.events.on(`deployment:${req.params.id}`, onStoreEvent);

    const heartbeatTimer = setInterval(() => {
      if (sendSnapshot()) {
        cleanup();
        res.end();
      }
    }, 500);

    req.on('close', () => {
      cleanup();
    });
  });

  return router;
}

export const deployRouter = createDeployRouter();
