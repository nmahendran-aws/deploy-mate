import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import { createAuthMiddlewares } from '../middleware/authMiddleware';
import { authService } from '../services/authService';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import {
  CloudProvider,
  ExecutionTenancy,
  WorkloadArchetype,
} from '../types/deployment';
import {
  AuthProvider,
  MembershipRecord,
  OrganizationRecord,
  OrgRole,
  PlanTier,
  ProjectRecord,
} from '../types/tenant';
import { validateGitHubRepoUrl } from '../utils/validation';

const VALID_ROLES = new Set<OrgRole>(['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER']);
const VALID_PROVIDERS = new Set<AuthProvider>(['github', 'google', 'email']);
const VALID_CLOUDS = new Set<CloudProvider>(['AWS', 'GCP', 'AZURE']);
const VALID_ARCHETYPES = new Set<WorkloadArchetype>([
  'STATIC_EDGE',
  'SSR_WEB',
  'CONTAINER_SERVICE',
  'SERVERLESS_FUNC',
]);
const VALID_TENANCIES = new Set<ExecutionTenancy>([
  'DEPLOYMATE_MANAGED',
  'CUSTOMER_BYOC',
]);

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * DM-904 (#4) & DM-905 (#5):
 * Authentication (GitHub / Google OAuth + .edu Student Verification) and
 * Multi-Tenant Organization, Membership RBAC, and Project Routes.
 */
export function createAuthAndOrgRouter(
  store: DeploymentStore = deploymentStore
): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddlewares(store);

  /**
   * POST /api/auth/session
   * Authenticates a user via GitHub / Google / Email identity, detects .edu academic domains,
   * provisions a default Personal Workspace + OWNER membership on first sign-in, and issues an HttpOnly JWT session.
   */
  router.post('/auth/session', (req: Request, res: Response) => {
    try {
      const { email, displayName, username, authProvider, avatarUrl } = req.body || {};
      if (typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({
          error: 'Email address is required to establish an authenticated session.',
          code: 'INVALID_AUTH_REQUEST',
        });
      }

      const provider: AuthProvider =
        typeof authProvider === 'string' && VALID_PROVIDERS.has(authProvider as AuthProvider)
          ? (authProvider as AuthProvider)
          : 'github';

      const session = authService.loginOrRegisterUser(
        {
          email,
          displayName: typeof displayName === 'string' ? displayName : undefined,
          username: typeof username === 'string' ? username : undefined,
          authProvider: provider,
          avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : undefined,
        },
        store
      );

      res.setHeader(
        'Set-Cookie',
        `dm_session=${encodeURIComponent(
          session.token
        )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
      );

      return res.status(200).json(session);
    } catch (err: unknown) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Authentication failed.',
        code: 'AUTH_ERROR',
      });
    }
  });

  /**
   * GET /api/auth/me
   * Returns current authenticated user, .edu student verification badge, active org, and RBAC role.
   */
  router.get('/auth/me', requireAuth, (req: Request, res: Response) => {
    const auth = req.auth!;
    const organizations = store.listOrganizationsForUser(auth.user.userId);
    return res.json({
      user: auth.user,
      activeOrgId: auth.activeOrgId,
      activeRole: auth.activeRole || null,
      organizations,
    });
  });

  /**
   * POST /api/auth/logout
   * Clears the HttpOnly session cookie.
   */
  router.post('/auth/logout', (_req: Request, res: Response) => {
    res.setHeader(
      'Set-Cookie',
      'dm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    );
    return res.json({ ok: true });
  });

  /**
   * GET /api/orgs
   * Lists organizations where the authenticated user holds a membership.
   */
  router.get('/orgs', requireAuth, (req: Request, res: Response) => {
    const organizations = store.listOrganizationsForUser(req.auth!.user.userId);
    return res.json({ organizations });
  });

  /**
   * POST /api/orgs
   * Creates a new team organization and assigns the creator as OWNER.
   */
  router.post('/orgs', requireAuth, (req: Request, res: Response) => {
    const { name, slug, planTier } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({
        error: 'Organization name must be at least 2 characters.',
      });
    }

    const baseSlug = slugify(typeof slug === 'string' && slug.trim() ? slug : name);
    if (!baseSlug) {
      return res.status(400).json({
        error: 'Valid alphanumeric organization slug is required.',
      });
    }

    const validTiers = new Set<PlanTier>([
      'CAMPUS_FREE',
      'STUDENT_PRO',
      'BUILDER',
      'PRO_BUILDER',
      'GROWTH',
      'GROWTH_TEAM',
      'SCALE_AGENCY',
      'ENTERPRISE',
    ]);
    const resolvedTier: PlanTier =
      typeof planTier === 'string' && validTiers.has(planTier as PlanTier)
        ? (planTier as PlanTier)
        : 'CAMPUS_FREE';

    const now = new Date().toISOString();
    const user = req.auth!.user;

    try {
      const organization: OrganizationRecord = store.createOrganization({
        orgId: `org_${crypto.randomBytes(5).toString('hex')}`,
        name: name.trim(),
        slug: baseSlug,
        planTier: resolvedTier,
        ownerUserId: user.userId,
        createdAt: now,
        updatedAt: now,
      });

      const membership: MembershipRecord = store.upsertMembership({
        membershipId: `mem_${crypto.randomBytes(5).toString('hex')}`,
        orgId: organization.orgId,
        userId: user.userId,
        userEmail: user.email,
        role: 'OWNER',
        createdAt: now,
      });

      return res.status(201).json({
        organization,
        membership,
      });
    } catch (err: unknown) {
      return res.status(409).json({
        error: err instanceof Error ? err.message : 'Unable to create organization.',
      });
    }
  });

  /**
   * GET /api/orgs/:orgId
   * Fetches organization details strictly scoped to members (404 on cross-tenant IDOR).
   */
  router.get('/orgs/:orgId', requireAuth, (req: Request, res: Response) => {
    const { orgId } = req.params;
    const role = store.getUserRoleInOrg(orgId, req.auth!.user.userId);
    const org = store.getOrganization(orgId);
    if (!org || !role) {
      return res.status(404).json({
        error: `Organization "${orgId}" not found.`,
      });
    }

    return res.json({
      organization: org,
      role,
      projectsCount: store.listProjectsForOrg(orgId).length,
      deploymentsCount: store.listByOrg(orgId).length,
    });
  });

  /**
   * GET /api/orgs/:orgId/members
   * Lists members in the organization (must be an existing member).
   */
  router.get('/orgs/:orgId/members', requireAuth, (req: Request, res: Response) => {
    const { orgId } = req.params;
    const callerRole = store.getUserRoleInOrg(orgId, req.auth!.user.userId);
    if (!callerRole || !store.getOrganization(orgId)) {
      return res.status(404).json({
        error: `Organization "${orgId}" not found.`,
      });
    }

    const members = store.listMembershipsForOrg(orgId);
    return res.json({ members });
  });

  /**
   * POST /api/orgs/:orgId/members
   * Invites/assigns a team member with an RBAC role (OWNER or ADMIN required).
   */
  router.post('/orgs/:orgId/members', requireAuth, (req: Request, res: Response) => {
    const { orgId } = req.params;
    const callerRole = store.getUserRoleInOrg(orgId, req.auth!.user.userId);
    if (!callerRole || !store.getOrganization(orgId)) {
      return res.status(404).json({
        error: `Organization "${orgId}" not found.`,
      });
    }

    const perm = authService.evaluatePermission(callerRole, 'MANAGE_MEMBERS');
    if (!perm.allowed) {
      return res.status(403).json({
        error: perm.reason || 'Forbidden: insufficient organization permissions.',
        code: 'FORBIDDEN_RBAC',
      });
    }

    const { email, role, displayName } = req.body || {};
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ error: 'Member email is required.' });
    }
    if (typeof role !== 'string' || !VALID_ROLES.has(role as OrgRole)) {
      return res.status(400).json({
        error: 'Valid role is required (OWNER, ADMIN, DEVELOPER, or VIEWER).',
      });
    }
    if (role === 'OWNER' && callerRole !== 'OWNER') {
      return res.status(403).json({
        error: 'Only an existing organization OWNER can grant the OWNER role.',
        code: 'FORBIDDEN_RBAC',
      });
    }

    try {
      // Ensure user record exists (along with their personal workspace if brand-new)
      const invited = authService.loginOrRegisterUser(
        {
          email,
          displayName: typeof displayName === 'string' ? displayName : undefined,
        },
        store
      );

      const membership = store.upsertMembership({
        membershipId: `mem_${crypto.randomBytes(5).toString('hex')}`,
        orgId,
        userId: invited.user.userId,
        userEmail: invited.user.email,
        role: role as OrgRole,
        invitedByUserId: req.auth!.user.userId,
        createdAt: new Date().toISOString(),
      });

      return res.status(201).json({
        membership,
        user: invited.user,
      });
    } catch (err: unknown) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to add organization member.',
      });
    }
  });

  /**
   * GET /api/orgs/:orgId/projects
   * Lists projects belonging to an organization (strictly member-scoped).
   */
  router.get('/orgs/:orgId/projects', requireAuth, (req: Request, res: Response) => {
    const { orgId } = req.params;
    const callerRole = store.getUserRoleInOrg(orgId, req.auth!.user.userId);
    if (!callerRole || !store.getOrganization(orgId)) {
      return res.status(404).json({
        error: `Organization "${orgId}" not found.`,
      });
    }

    return res.json({
      projects: store.listProjectsForOrg(orgId),
    });
  });

  /**
   * POST /api/orgs/:orgId/projects
   * Creates a multi-cloud Project with production & preview environments (OWNER, ADMIN, or DEVELOPER).
   */
  router.post('/orgs/:orgId/projects', requireAuth, (req: Request, res: Response) => {
    const { orgId } = req.params;
    const callerRole = store.getUserRoleInOrg(orgId, req.auth!.user.userId);
    if (!callerRole || !store.getOrganization(orgId)) {
      return res.status(404).json({
        error: `Organization "${orgId}" not found.`,
      });
    }

    const perm = authService.evaluatePermission(callerRole, 'CREATE_PROJECT');
    if (!perm.allowed) {
      return res.status(403).json({
        error: perm.reason || 'Forbidden: insufficient permissions to create projects.',
        code: 'FORBIDDEN_RBAC',
      });
    }

    const {
      name,
      slug,
      repoUrl,
      defaultBranch,
      defaultProvider,
      defaultArchetype,
      defaultTenancy,
    } = req.body || {};

    const repoCheck = validateGitHubRepoUrl(repoUrl);
    if (!repoCheck.valid || !repoCheck.data) {
      return res.status(400).json({
        error: repoCheck.error || 'Valid GitHub repository URL is required.',
      });
    }

    const projectName =
      typeof name === 'string' && name.trim().length >= 2
        ? name.trim()
        : repoCheck.data.repo;
    const projectSlug = slugify(
      typeof slug === 'string' && slug.trim() ? slug : projectName
    );

    const provider: CloudProvider =
      typeof defaultProvider === 'string' && VALID_CLOUDS.has(defaultProvider as CloudProvider)
        ? (defaultProvider as CloudProvider)
        : 'AWS';
    const archetype: WorkloadArchetype =
      typeof defaultArchetype === 'string' &&
      VALID_ARCHETYPES.has(defaultArchetype as WorkloadArchetype)
        ? (defaultArchetype as WorkloadArchetype)
        : 'STATIC_EDGE';
    const tenancy: ExecutionTenancy =
      typeof defaultTenancy === 'string' &&
      VALID_TENANCIES.has(defaultTenancy as ExecutionTenancy)
        ? (defaultTenancy as ExecutionTenancy)
        : 'DEPLOYMATE_MANAGED';

    const now = new Date().toISOString();
    try {
      const project: ProjectRecord = store.createProject({
        projectId: `prj_${crypto.randomBytes(5).toString('hex')}`,
        orgId,
        name: projectName,
        slug: projectSlug || repoCheck.data.repo.toLowerCase(),
        repoUrl: repoCheck.data.normalizedUrl,
        defaultBranch:
          typeof defaultBranch === 'string' && defaultBranch.trim()
            ? defaultBranch.trim()
            : repoCheck.data.branch || 'main',
        cloudProvider: provider,
        defaultArchetype: archetype,
        defaultTenancy: tenancy,
        environments: ['production', 'preview'],
        createdByUserId: req.auth!.user.userId,
        createdAt: now,
        updatedAt: now,
      });

      return res.status(201).json({ project });
    } catch (err: unknown) {
      return res.status(409).json({
        error: err instanceof Error ? err.message : 'Unable to create project.',
      });
    }
  });

  return router;
}

export const authAndOrgRouter = createAuthAndOrgRouter();
