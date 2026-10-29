import { CloudProvider, ExecutionTenancy, WorkloadArchetype } from './deployment';

export type PlanTier =
  | 'CAMPUS_FREE'
  | 'STUDENT_PRO'
  | 'BUILDER'
  | 'PRO_BUILDER'
  | 'GROWTH'
  | 'GROWTH_TEAM'
  | 'SCALE_AGENCY'
  | 'ENTERPRISE';

export type OrgRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';

export type AuthProvider = 'github' | 'google' | 'email';

export type EnvironmentType = 'production' | 'staging' | 'preview';

export interface UserRecord {
  userId: string;
  email: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  authProvider: AuthProvider;
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
  invitedByUserId?: string;
  createdAt: string;
}

export interface ProjectRecord {
  projectId: string;
  orgId: string;
  name: string;
  slug: string;
  repoUrl: string;
  defaultBranch: string;
  cloudProvider: CloudProvider;
  defaultArchetype?: WorkloadArchetype;
  defaultTenancy?: ExecutionTenancy;
  environments: EnvironmentType[];
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedContext {
  user: UserRecord;
  activeOrgId?: string;
  activeRole?: OrgRole;
}
