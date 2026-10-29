import crypto from 'crypto';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import { EnvironmentType } from '../types/tenant';
import {
  AuthProvider,
  MembershipRecord,
  OrganizationRecord,
  OrgRole,
  UserRecord,
} from '../types/tenant';

export interface SessionTokenPayload {
  sub: string;
  email: string;
  defaultOrgId: string;
  iat: number;
  exp: number;
}

const DEFAULT_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

function getJwtSecret(): string {
  return (
    process.env.AUTH_JWT_SECRET ||
    'deploymate-phase9-dev-hmac-secret-change-in-production'
  );
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToString(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf-8');
}

/**
 * DM-904 (#4): Academic & .edu email verification detector for Student Pro eligibility.
 */
export function detectAcademicStudentEmail(rawEmail: string): {
  studentVerified: boolean;
  academicDomain?: string;
} {
  const trimmed = rawEmail.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx === -1) return { studentVerified: false };

  const domain = trimmed.slice(atIdx + 1);
  if (!domain || !domain.includes('.')) {
    return { studentVerified: false };
  }

  const isAcademic =
    domain.endsWith('.edu') ||
    /\.edu\.[a-z]{2,3}$/.test(domain) ||
    /\.ac\.[a-z]{2,3}$/.test(domain) ||
    domain.endsWith('.edu.sg') ||
    domain.endsWith('.edu.au') ||
    domain.endsWith('.edu.in');

  return isAcademic
    ? { studentVerified: true, academicDomain: domain }
    : { studentVerified: false };
}

export class AuthService {
  /**
   * Signs an HMAC-SHA256 JWT token using Node's native crypto module.
   */
  public signToken(
    payload: Omit<SessionTokenPayload, 'iat' | 'exp'>,
    ttlSeconds: number = DEFAULT_TOKEN_TTL_SEC
  ): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const fullPayload: SessionTokenPayload = {
      ...payload,
      iat: nowSec,
      exp: nowSec + ttlSeconds,
    };

    const headerPart = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadPart = base64UrlEncode(JSON.stringify(fullPayload));
    const signingInput = `${headerPart}.${payloadPart}`;
    const signature = crypto
      .createHmac('sha256', getJwtSecret())
      .update(signingInput)
      .digest();

    return `${signingInput}.${base64UrlEncode(signature)}`;
  }

  /**
   * Verifies signature integrity and expiration timestamp of a Bearer JWT.
   */
  public verifyToken(token?: string): {
    valid: boolean;
    payload?: SessionTokenPayload;
    error?: string;
  } {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Authentication token is missing.' };
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Malformed authentication token.' };
    }

    const [headerPart, payloadPart, sigPart] = parts;
    const signingInput = `${headerPart}.${payloadPart}`;
    const expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', getJwtSecret()).update(signingInput).digest()
    );

    const actualBuf = Buffer.from(sigPart);
    const expectedBuf = Buffer.from(expectedSig);
    if (
      actualBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(actualBuf, expectedBuf)
    ) {
      return { valid: false, error: 'Invalid token signature.' };
    }

    try {
      const parsed = JSON.parse(base64UrlDecodeToString(payloadPart)) as SessionTokenPayload;
      const nowSec = Math.floor(Date.now() / 1000);
      if (typeof parsed.exp !== 'number' || parsed.exp <= nowSec) {
        return { valid: false, error: 'Authentication token has expired.' };
      }
      return { valid: true, payload: parsed };
    } catch {
      return { valid: false, error: 'Invalid token payload.' };
    }
  }

  /**
   * DM-904: Authenticates a user (GitHub / Google / Email OAuth) and atomically provisions
   * their personal workspace + OWNER membership on first sign-in.
   */
  public loginOrRegisterUser(
    params: {
      email: string;
      displayName?: string;
      username?: string;
      authProvider?: AuthProvider;
      avatarUrl?: string;
    },
    store: DeploymentStore = deploymentStore
  ): {
    token: string;
    user: UserRecord;
    defaultOrganization: OrganizationRecord;
    organizations: Array<{ organization: OrganizationRecord; role: OrgRole }>;
  } {
    const normalizedEmail = params.email.trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error('A valid email address is required.');
    }

    const academic = detectAcademicStudentEmail(normalizedEmail);
    const now = new Date().toISOString();

    let user = store.getUserByEmail(normalizedEmail);
    if (!user) {
      const rawUsername =
        params.username?.trim() ||
        normalizedEmail.split('@')[0].replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const safeUsername = rawUsername.slice(0, 32) || 'dev';

      user = store.upsertUser({
        userId: `usr_${crypto.randomBytes(5).toString('hex')}`,
        email: normalizedEmail,
        displayName: params.displayName?.trim() || safeUsername,
        username: safeUsername,
        avatarUrl: params.avatarUrl,
        authProvider: params.authProvider || 'github',
        studentVerified: academic.studentVerified,
        academicDomain: academic.academicDomain,
        createdAt: now,
        updatedAt: now,
      });
    } else if (academic.studentVerified && !user.studentVerified) {
      user = store.upsertUser({
        ...user,
        studentVerified: true,
        academicDomain: academic.academicDomain,
        updatedAt: now,
      });
    }

    let orgs = store.listOrganizationsForUser(user.userId);
    if (orgs.length === 0) {
      const baseSlug = `${user.username}-workspace`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
      const uniqueSlug = store
        .listAll() // ensure uniqueness even if two users share email prefix
        ? `${baseSlug}-${user.userId.slice(-4)}`
        : baseSlug;

      const defaultOrg: OrganizationRecord = store.createOrganization({
        orgId: `org_${crypto.randomBytes(5).toString('hex')}`,
        name: `${user.displayName}'s Workspace`,
        slug: uniqueSlug,
        planTier: 'CAMPUS_FREE',
        ownerUserId: user.userId,
        createdAt: now,
        updatedAt: now,
      });

      const ownerMembership: MembershipRecord = {
        membershipId: `mem_${crypto.randomBytes(5).toString('hex')}`,
        orgId: defaultOrg.orgId,
        userId: user.userId,
        userEmail: user.email,
        role: 'OWNER',
        createdAt: now,
      };
      store.upsertMembership(ownerMembership);
      orgs = [{ organization: defaultOrg, role: 'OWNER' }];
    }

    const defaultOrganization = orgs[0].organization;
    const token = this.signToken({
      sub: user.userId,
      email: user.email,
      defaultOrgId: defaultOrganization.orgId,
    });

    return {
      token,
      user,
      defaultOrganization,
      organizations: orgs,
    };
  }

  /**
   * DM-905 (#5): Role-Based Access Control (RBAC) permission evaluator.
   * - VIEWER: read-only
   * - DEVELOPER: create projects, deploy & delete preview/staging; CANNOT deploy/delete production or manage members
   * - ADMIN: production deploy & teardown, custom domains, BYOC connections, invite members
   * - OWNER: all ADMIN capabilities + billing & org deletion
   */
  public evaluatePermission(
    role: OrgRole | undefined,
    action:
      | 'READ'
      | 'CREATE_PROJECT'
      | 'DEPLOY'
      | 'DELETE_DEPLOYMENT'
      | 'MANAGE_MEMBERS'
      | 'MANAGE_BILLING',
    environment: EnvironmentType = 'production'
  ): { allowed: boolean; reason?: string } {
    if (!role) {
      return {
        allowed: false,
        reason: 'User is not a member of this organization.',
      };
    }

    switch (action) {
      case 'READ':
        return { allowed: true };

      case 'CREATE_PROJECT':
        return role === 'OWNER' || role === 'ADMIN' || role === 'DEVELOPER'
          ? { allowed: true }
          : {
              allowed: false,
              reason: `Role "${role}" is read-only and cannot create projects.`,
            };

      case 'DEPLOY':
        if (role === 'VIEWER') {
          return {
            allowed: false,
            reason: 'Role "VIEWER" cannot trigger deployments.',
          };
        }
        if (role === 'DEVELOPER' && environment === 'production') {
          return {
            allowed: false,
            reason:
              'Role "DEVELOPER" can deploy to preview/staging environments, but "ADMIN" or "OWNER" is required for production deployments.',
          };
        }
        return { allowed: true };

      case 'DELETE_DEPLOYMENT':
        if (role === 'VIEWER') {
          return {
            allowed: false,
            reason: 'Role "VIEWER" cannot delete deployments.',
          };
        }
        if (role === 'DEVELOPER' && environment === 'production') {
          return {
            allowed: false,
            reason:
              'Role "DEVELOPER" cannot tear down production infrastructure. Requires "ADMIN" or "OWNER".',
          };
        }
        return { allowed: true };

      case 'MANAGE_MEMBERS':
        return role === 'OWNER' || role === 'ADMIN'
          ? { allowed: true }
          : {
              allowed: false,
              reason: `Role "${role}" cannot manage organization members.`,
            };

      case 'MANAGE_BILLING':
        return role === 'OWNER'
          ? { allowed: true }
          : {
              allowed: false,
              reason: 'Only organization "OWNER" can modify billing or plan tiers.',
            };
    }
  }
}

export const authService = new AuthService();
