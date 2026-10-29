import { NextFunction, Request, Response } from 'express';
import { authService } from '../services/authService';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import { AuthenticatedContext } from '../types/tenant';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthenticatedContext;
    }
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header) {
    const [scheme, token] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return '__MALFORMED__';
    }
    return token;
  }

  const rawCookie = req.headers.cookie;
  if (rawCookie) {
    const match = rawCookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('dm_session='));
    if (match) {
      const val = decodeURIComponent(match.slice('dm_session='.length).trim());
      if (val) return val;
    }
  }

  return undefined;
}

/**
 * Creates auth middleware bound to a specific DeploymentStore instance (supports isolated test stores).
 */
export function createAuthMiddlewares(store: DeploymentStore = deploymentStore) {
  /**
   * Parses Bearer JWT if present:
   * - If `Authorization` header is present and invalid/expired -> ALWAYS returns `401 Unauthorized`.
   * - If `Authorization` header is absent and `REQUIRE_AUTH === 'true'` -> returns `401 Unauthorized` on mutating calls.
   * - Populates `req.auth` with `{ user, activeOrgId, activeRole }` when authenticated.
   */
  const attachAuthIfPresent = (req: Request, res: Response, next: NextFunction) => {
    const rawToken = extractBearerToken(req);

    if (!rawToken) {
      if (process.env.REQUIRE_AUTH === 'true' && req.method !== 'GET') {
        return res.status(401).json({
          error: 'Authentication required. Please sign in to DeployMate.',
          code: 'UNAUTHORIZED',
        });
      }
      return next();
    }

    if (rawToken === '__MALFORMED__') {
      return res.status(401).json({
        error: 'Malformed Authorization header. Expected "Bearer <token>".',
        code: 'UNAUTHORIZED',
      });
    }

    const verification = authService.verifyToken(rawToken);
    if (!verification.valid || !verification.payload) {
      return res.status(401).json({
        error: verification.error || 'Invalid or expired authentication token.',
        code: 'UNAUTHORIZED',
      });
    }

    const user = store.getUserById(verification.payload.sub);
    if (!user) {
      return res.status(401).json({
        error: 'Authenticated user session no longer exists.',
        code: 'UNAUTHORIZED',
      });
    }

    const requestedOrgId =
      (typeof req.headers['x-org-id'] === 'string' && req.headers['x-org-id'].trim()) ||
      (typeof req.body?.orgId === 'string' && req.body.orgId.trim()) ||
      (typeof req.query?.orgId === 'string' && req.query.orgId.trim()) ||
      verification.payload.defaultOrgId;

    const activeRole = requestedOrgId
      ? store.getUserRoleInOrg(requestedOrgId, user.userId)
      : undefined;

    req.auth = {
      user,
      activeOrgId: requestedOrgId,
      activeRole,
    };

    return next();
  };

  /**
   * Strict authentication guard for `/api/auth/me`, `/api/orgs/*`, and `/api/projects/*`.
   */
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const rawToken = extractBearerToken(req);
    if (!rawToken || rawToken === '__MALFORMED__') {
      return res.status(401).json({
        error: 'Authentication required. Please sign in with GitHub or Google.',
        code: 'UNAUTHORIZED',
      });
    }

    const verification = authService.verifyToken(rawToken);
    if (!verification.valid || !verification.payload) {
      return res.status(401).json({
        error: verification.error || 'Invalid or expired authentication token.',
        code: 'UNAUTHORIZED',
      });
    }

    const user = store.getUserById(verification.payload.sub);
    if (!user) {
      return res.status(401).json({
        error: 'User account not found.',
        code: 'UNAUTHORIZED',
      });
    }

    const requestedOrgId =
      (typeof req.headers['x-org-id'] === 'string' && req.headers['x-org-id'].trim()) ||
      req.params.orgId ||
      verification.payload.defaultOrgId;

    const activeRole = requestedOrgId
      ? store.getUserRoleInOrg(requestedOrgId, user.userId)
      : undefined;

    req.auth = {
      user,
      activeOrgId: requestedOrgId,
      activeRole,
    };

    return next();
  };

  return { attachAuthIfPresent, requireAuth };
}
