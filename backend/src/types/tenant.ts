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
  activeProductionDeploymentId?: string | null;
  activeProductionUrl?: string | null;
  environments: EnvironmentType[];
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * DM-913 (#13): AES-256-GCM Encrypted Environment Variable / Secret Record
 */
export interface EncryptedSecretRecord {
  secretId: string;
  orgId: string;
  projectId: string;
  environment: EnvironmentType;
  key: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  maskedPreview: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * DM-906 (#6): GitHub App Installation & Connected Repository Metadata
 */
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

export interface GitHubInstallationRecord {
  installationId: string;
  orgId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  authMode?: 'github_app' | 'token_authenticated' | 'public_unauthenticated' | 'mock';
  encryptedAccessToken?: {
    ciphertext: string;
    iv: string;
    authTag: string;
    maskedPreview: string;
  };
  repositories: GitHubConnectedRepo[];
  createdAt: string;
  updatedAt: string;
}

/**
 * DM-908 (#8): Single Upserted Pull Request Preview Comment Record
 */
export interface PrPreviewCommentRecord {
  commentId: string;
  repoFullName: string;
  prNumber: number;
  deploymentId: string;
  previewUrl: string | null;
  status: string;
  markdownBody: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedContext {
  user: UserRecord;
  activeOrgId?: string;
  activeRole?: OrgRole;
}
