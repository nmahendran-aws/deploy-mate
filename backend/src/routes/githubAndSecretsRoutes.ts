import { Request, Response, Router } from 'express';
import { createAuthMiddlewares } from '../middleware/authMiddleware';
import { authService } from '../services/authService';
import { DeploymentManager, deploymentManager } from '../services/deploymentManager';
import { githubAppService } from '../services/githubAppService';
import {
  githubWebhookService,
  verifyGitHubWebhookSignature,
} from '../services/githubWebhookService';
import {
  maskSecretValue,
  parseDotEnvContent,
  secretsVault,
} from '../services/secretsVault';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import { EnvironmentType } from '../types/tenant';

const VALID_ENVIRONMENTS = new Set<EnvironmentType>([
  'production',
  'staging',
  'preview',
]);

/**
 * Phase 9 · Sprint 2 Routes:
 * - DM-906 (#6): GitHub App Installation Connection & Paginated Private/Public Repo Listing
 * - DM-907 (#7): HMAC-SHA256 GitHub Push Webhooks (with replay deduplication) & 1-Click Instant Rollback
 * - DM-908 (#8): Ephemeral Pull Request Preview Webhooks & Single Upserted PR Bot Comment Lookup
 * - DM-913 (#13): AES-256-GCM Encrypted Secrets Vault (Environment-Scoped) & Multi-Line .env Parser
 */
export function createGitHubAndSecretsRouter(
  store: DeploymentStore = deploymentStore,
  manager: DeploymentManager = deploymentManager
): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddlewares(store);

  // ==========================================================================
  // DM-907 & DM-908: GitHub Webhooks (HMAC-SHA256 Verified) & PR Bot Comments
  // ==========================================================================

  router.post('/webhooks/github', async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const sigHeader = req.headers['x-hub-signature-256'];
    const eventHeader = req.headers['x-github-event'];
    const deliveryHeader = req.headers['x-github-delivery'];

    const signature = typeof sigHeader === 'string' ? sigHeader : undefined;
    if (!verifyGitHubWebhookSignature(rawBody, signature)) {
      return res.status(401).json({
        error: 'Invalid or missing GitHub webhook X-Hub-Signature-256 HMAC signature.',
        code: 'INVALID_WEBHOOK_SIGNATURE',
      });
    }

    const event = typeof eventHeader === 'string' && eventHeader.trim() ? eventHeader.trim() : 'ping';
    const deliveryId =
      typeof deliveryHeader === 'string' && deliveryHeader.trim()
        ? deliveryHeader.trim()
        : undefined;

    const result = await githubWebhookService.processEvent({
      event,
      deliveryId,
      payload: req.body || {},
      store,
      manager,
    });

    return res.status(result.statusCode).json(result.body);
  });

  router.get(
    '/webhooks/pr-comments/:owner/:repo/:prNumber',
    (req: Request, res: Response) => {
      const { owner, repo, prNumber } = req.params;
      const parsedPr = Number(prNumber);
      if (!Number.isInteger(parsedPr) || parsedPr <= 0) {
        return res.status(400).json({ error: 'Invalid PR number.' });
      }
      const comment = store.getPrPreviewComment(`${owner}/${repo}`, parsedPr);
      if (!comment) {
        return res.status(404).json({
          error: `No PR preview comment found for ${owner}/${repo}#${parsedPr}.`,
        });
      }
      return res.json({ comment });
    }
  );

  // ==========================================================================
  // DM-906: Official GitHub App Installation & Private Repository Picker API
  // ==========================================================================

  router.post('/github/installations', requireAuth, (req: Request, res: Response) => {
    const auth = req.auth!;
    if (!auth.activeOrgId || !auth.activeRole) {
      return res.status(404).json({ error: 'Organization not found.' });
    }

    const perm = authService.evaluatePermission(auth.activeRole, 'MANAGE_MEMBERS');
    if (!perm.allowed) {
      return res.status(403).json({
        error:
          perm.reason ||
          'Forbidden: ADMIN or OWNER role is required to connect a GitHub App installation.',
        code: 'FORBIDDEN_RBAC',
      });
    }

    const { installationId, accountLogin, accountType, repositories } = req.body || {};
    if (typeof accountLogin !== 'string' || !accountLogin.trim()) {
      return res.status(400).json({
        error: 'GitHub accountLogin (organization or username) is required.',
      });
    }

    const installation = githubAppService.connectInstallation(
      {
        orgId: auth.activeOrgId,
        installationId: typeof installationId === 'string' ? installationId : undefined,
        accountLogin,
        accountType: accountType === 'User' ? 'User' : 'Organization',
        repositories: Array.isArray(repositories) ? repositories : undefined,
      },
      store
    );

    return res.status(201).json({ installation });
  });

  router.get('/github/repos', requireAuth, (req: Request, res: Response) => {
    const auth = req.auth!;
    if (!auth.activeOrgId || !auth.activeRole) {
      return res.status(404).json({ error: 'Organization not found.' });
    }

    const page = Number(req.query.page || 1);
    const perPage = Number(req.query.perPage || 20);
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;

    const listing = githubAppService.listOrgRepositories(
      {
        orgId: auth.activeOrgId,
        page,
        perPage,
        query,
      },
      store
    );

    return res.json({
      ...listing,
      installationsCount: store.listGitHubInstallationsForOrg(auth.activeOrgId).length,
    });
  });

  // ==========================================================================
  // DM-907: 1-Click Instant Rollback (< 10s, Immutable Artifact Switch)
  // ==========================================================================

  router.post(
    '/projects/:projectId/rollback/:deploymentId',
    requireAuth,
    (req: Request, res: Response) => {
      const auth = req.auth!;
      const { projectId, deploymentId } = req.params;

      if (!auth.activeOrgId || !auth.activeRole) {
        return res.status(404).json({ error: `Project "${projectId}" not found.` });
      }

      const project = store.getProjectForOrg(projectId, auth.activeOrgId);
      if (!project) {
        return res.status(404).json({ error: `Project "${projectId}" not found.` });
      }

      const perm = authService.evaluatePermission(
        auth.activeRole,
        'DEPLOY',
        'production'
      );
      if (!perm.allowed) {
        return res.status(403).json({
          error:
            perm.reason ||
            'Forbidden: ADMIN or OWNER role is required to roll back production deployments.',
          code: 'FORBIDDEN_RBAC',
        });
      }

      const rollback = manager.rollbackProjectToDeployment(projectId, deploymentId);
      if (!rollback.ok) {
        return res.status(rollback.statusCode).json({ error: rollback.error });
      }

      return res.status(200).json({
        ok: true,
        project: rollback.project,
        activeDeployment: rollback.activeDeployment,
        previousDeploymentId: rollback.previousDeploymentId,
      });
    }
  );

  // ==========================================================================
  // DM-913: AES-256-GCM Encrypted Secrets Vault & Multi-Line .env Parser
  // ==========================================================================

  router.get('/projects/:projectId/secrets', requireAuth, (req: Request, res: Response) => {
    const auth = req.auth!;
    const { projectId } = req.params;

    if (!auth.activeOrgId || !auth.activeRole) {
      return res.status(404).json({ error: `Project "${projectId}" not found.` });
    }

    const project = store.getProjectForOrg(projectId, auth.activeOrgId);
    if (!project) {
      return res.status(404).json({ error: `Project "${projectId}" not found.` });
    }

    const rawEnv = req.query.environment;
    const envFilter: EnvironmentType | undefined =
      typeof rawEnv === 'string' && VALID_ENVIRONMENTS.has(rawEnv as EnvironmentType)
        ? (rawEnv as EnvironmentType)
        : undefined;

    return res.json({
      projectId,
      secrets: secretsVault.listMaskedSecrets(projectId, envFilter, store),
    });
  });

  router.post(
    '/projects/:projectId/secrets',
    requireAuth,
    (req: Request, res: Response) => {
      const auth = req.auth!;
      const { projectId } = req.params;

      if (!auth.activeOrgId || !auth.activeRole) {
        return res.status(404).json({ error: `Project "${projectId}" not found.` });
      }

      const project = store.getProjectForOrg(projectId, auth.activeOrgId);
      if (!project) {
        return res.status(404).json({ error: `Project "${projectId}" not found.` });
      }

      const rawEnv = req.body?.environment;
      const environment: EnvironmentType =
        typeof rawEnv === 'string' && VALID_ENVIRONMENTS.has(rawEnv as EnvironmentType)
          ? (rawEnv as EnvironmentType)
          : 'production';

      const perm = authService.evaluatePermission(
        auth.activeRole,
        'DEPLOY',
        environment
      );
      if (!perm.allowed) {
        return res.status(403).json({
          error:
            perm.reason ||
            `Forbidden: insufficient role permissions to modify "${environment}" secrets.`,
          code: 'FORBIDDEN_RBAC',
        });
      }

      let secretPairs: Record<string, string> = {};
      if (typeof req.body?.dotEnvText === 'string') {
        const parsed = parseDotEnvContent(req.body.dotEnvText);
        if (!parsed.valid) {
          return res.status(400).json({ error: parsed.error });
        }
        secretPairs = { ...secretPairs, ...parsed.parsed };
      }

      if (req.body?.secrets && typeof req.body.secrets === 'object') {
        secretPairs = {
          ...secretPairs,
          ...(req.body.secrets as Record<string, string>),
        };
      }

      if (Object.keys(secretPairs).length === 0) {
        return res.status(400).json({
          error: 'Provide at least one secret key-value pair or valid dotEnvText.',
        });
      }

      try {
        const summaries = secretsVault.saveSecrets(
          {
            orgId: auth.activeOrgId,
            projectId,
            environment,
            secrets: secretPairs,
            updatedByUserId: auth.user.userId,
          },
          store
        );
        return res.status(201).json({
          projectId,
          environment,
          secrets: summaries,
        });
      } catch (err: unknown) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : 'Invalid secret payload.',
        });
      }
    }
  );

  router.delete(
    '/projects/:projectId/secrets/:key',
    requireAuth,
    (req: Request, res: Response) => {
      const auth = req.auth!;
      const { projectId, key } = req.params;

      if (!auth.activeOrgId || !auth.activeRole) {
        return res.status(404).json({ error: `Project "${projectId}" not found.` });
      }

      const project = store.getProjectForOrg(projectId, auth.activeOrgId);
      if (!project) {
        return res.status(404).json({ error: `Project "${projectId}" not found.` });
      }

      const rawEnv = req.query.environment;
      const environment: EnvironmentType =
        typeof rawEnv === 'string' && VALID_ENVIRONMENTS.has(rawEnv as EnvironmentType)
          ? (rawEnv as EnvironmentType)
          : 'production';

      const perm = authService.evaluatePermission(
        auth.activeRole,
        'DEPLOY',
        environment
      );
      if (!perm.allowed) {
        return res.status(403).json({
          error: perm.reason || 'Forbidden: insufficient permissions to delete secret.',
          code: 'FORBIDDEN_RBAC',
        });
      }

      const deleted = store.deleteEncryptedSecret(projectId, environment, key);
      if (!deleted) {
        return res.status(404).json({
          error: `Secret "${key}" not found in "${environment}" environment.`,
        });
      }

      return res.json({ ok: true, deletedKey: key, environment });
    }
  );

  router.post('/secrets/parse-dotenv', (req: Request, res: Response) => {
    const rawDotEnv = req.body?.dotEnvText;
    if (typeof rawDotEnv !== 'string') {
      return res.status(400).json({ error: 'dotEnvText string is required.' });
    }

    const parsed = parseDotEnvContent(rawDotEnv);
    if (!parsed.valid) {
      return res.status(400).json({ error: parsed.error });
    }

    const entries = Object.entries(parsed.parsed).map(([key, value]) => ({
      key,
      value,
      maskedPreview: maskSecretValue(value),
    }));

    return res.json({
      valid: true,
      count: entries.length,
      entries,
    });
  });

  return router;
}

export const githubAndSecretsRouter = createGitHubAndSecretsRouter();
