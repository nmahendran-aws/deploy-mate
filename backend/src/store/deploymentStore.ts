import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import {
  AuditLogEntry,
  DeploymentChecklist,
  DeploymentRecord,
  DeploymentStatus,
  TrackedCloudResources,
} from '../types/deployment';
import {
  MembershipRecord,
  OrganizationRecord,
  OrgRole,
  ProjectRecord,
  UserRecord,
} from '../types/tenant';

export interface PersistedDatabase {
  deployments: Record<string, DeploymentRecord>;
  /**
   * Maps normalized full hostname (e.g. "demo.maas-fam.com") -> deploymentId
   */
  reservedHostnames: Record<string, string>;
  /**
   * DM-902 / DM-904 / DM-905: Multi-tenant Identity, Organizations, Memberships & Projects
   */
  users: Record<string, UserRecord>;
  organizations: Record<string, OrganizationRecord>;
  memberships: Record<string, MembershipRecord>;
  projects: Record<string, ProjectRecord>;
}

/**
 * DM-902 (#2): Cloud-agnostic & multi-tenant repository interface.
 */
export interface IDeploymentRepository {
  reserveHostname(
    customHostname: string,
    deploymentId: string
  ): { reserved: boolean; existingDeploymentId?: string };
  releaseHostname(customHostname?: string, deploymentId?: string): void;
  isHostnameAvailable(customHostname: string): boolean;

  create(record: DeploymentRecord): DeploymentRecord;
  get(deploymentId: string): DeploymentRecord | undefined;
  getForOrg(deploymentId: string, orgId: string): DeploymentRecord | undefined;
  listAll(): DeploymentRecord[];
  listByOrg(orgId: string): DeploymentRecord[];
  countActiveDeployments(orgId?: string): number;
  update(
    deploymentId: string,
    patch: Partial<Omit<DeploymentRecord, 'deploymentId' | 'createdAt'>>
  ): DeploymentRecord | undefined;
  addLog(
    deploymentId: string,
    phase: DeploymentStatus,
    level: AuditLogEntry['level'],
    message: string
  ): void;
  updateChecklist(
    deploymentId: string,
    checklistPatch: Partial<DeploymentChecklist>
  ): void;
  updateResources(
    deploymentId: string,
    resourcePatch: Partial<TrackedCloudResources>
  ): void;
}

interface MinimalPgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

export class DeploymentStore implements IDeploymentRepository {
  private readonly filePath: string;
  private db: PersistedDatabase;
  private dynamoClient?: DynamoDBClient;
  private dynamoTableName?: string;
  private pgPool?: MinimalPgPool;
  public readonly events: EventEmitter = new EventEmitter();

  constructor(customFilePath?: string) {
    this.events.setMaxListeners(100);
    const dataDir = path.resolve(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.filePath = customFilePath || path.join(dataDir, 'deployments.json');
    this.db = this.loadFromDisk();

    if (process.env.DYNAMODB_TABLE_NAME && process.env.AWS_DRY_RUN === 'false') {
      this.dynamoTableName = process.env.DYNAMODB_TABLE_NAME;
      this.dynamoClient = new DynamoDBClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });
    }

    if (process.env.DATABASE_URL && process.env.FORCE_DRY_RUN_TEST !== 'true') {
      void this.initializePostgresPool(process.env.DATABASE_URL);
    }
  }

  /**
   * Optional PostgreSQL connection pool initialization when DATABASE_URL is configured (DM-902).
   * Automatically executes postgresSchema.sql migrations without requiring external setup for local tests.
   */
  private async initializePostgresPool(connectionString: string): Promise<void> {
    try {
      // Dynamic import so local zero-config dev works even without a running Postgres daemon
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pgModule = require('pg') as { Pool: new (cfg: { connectionString: string }) => MinimalPgPool };
      const pool = new pgModule.Pool({ connectionString });
      const schemaPath = path.join(__dirname, 'postgresSchema.sql');
      if (fs.existsSync(schemaPath)) {
        const ddl = fs.readFileSync(schemaPath, 'utf-8');
        await pool.query(ddl);
      }
      this.pgPool = pool;
    } catch {
      // Local ACID atomic file persistence remains authoritative fallback
    }
  }

  private loadFromDisk(): PersistedDatabase {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PersistedDatabase>;
        return {
          deployments: parsed.deployments || {},
          reservedHostnames: parsed.reservedHostnames || {},
          users: parsed.users || {},
          organizations: parsed.organizations || {},
          memberships: parsed.memberships || {},
          projects: parsed.projects || {},
        };
      }
    } catch {
      // Fallback to empty database if file is corrupted
    }
    return {
      deployments: {},
      reservedHostnames: {},
      users: {},
      organizations: {},
      memberships: {},
      projects: {},
    };
  }

  private saveToDisk(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(this.db, null, 2), 'utf-8');
    fs.renameSync(tmpFile, this.filePath);
  }

  private async syncToPostgres(record: DeploymentRecord): Promise<void> {
    if (!this.pgPool) return;
    try {
      await this.pgPool.query(
        `INSERT INTO deployments (
          deployment_id, org_id, project_id, environment, created_by_user_id,
          cloud_provider, archetype, tenancy, target, status, repo_url,
          custom_hostname, url, payload_json, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (deployment_id) DO UPDATE SET
          status = EXCLUDED.status,
          url = EXCLUDED.url,
          custom_hostname = EXCLUDED.custom_hostname,
          payload_json = EXCLUDED.payload_json,
          updated_at = EXCLUDED.updated_at`,
        [
          record.deploymentId,
          record.orgId || null,
          record.projectId || null,
          record.environment || 'production',
          record.createdByUserId || null,
          record.cloudProvider,
          record.archetype,
          record.tenancy,
          record.target,
          record.status,
          record.repoUrl,
          record.customHostname || null,
          record.url || null,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        ]
      );
    } catch {
      // Fallback safely
    }
  }

  private async syncToDynamoDB(record: DeploymentRecord): Promise<void> {
    if (!this.dynamoClient || !this.dynamoTableName) return;
    try {
      await this.dynamoClient.send(
        new PutItemCommand({
          TableName: this.dynamoTableName,
          Item: {
            deploymentId: { S: record.deploymentId },
            orgId: { S: record.orgId || 'public' },
            status: { S: record.status },
            cloudProvider: { S: record.cloudProvider },
            target: { S: record.target },
            repoUrl: { S: record.repoUrl },
            customHostname: { S: record.customHostname || '' },
            url: { S: record.url || '' },
            updatedAt: { S: record.updatedAt },
            payloadJson: { S: JSON.stringify(record) },
          },
        })
      );
    } catch {
      // Local disk persistence remains authoritative fallback
    }
  }

  private emitUpdate(record: DeploymentRecord): void {
    this.events.emit(`deployment:${record.deploymentId}`, record);
    this.events.emit('deployment:any', record);
  }

  /**
   * Reserves a custom hostname atomically before deployment begins, preventing duplicate assignments.
   */
  public reserveHostname(
    customHostname: string,
    deploymentId: string
  ): { reserved: boolean; existingDeploymentId?: string } {
    const key = customHostname.trim().toLowerCase();
    const existingOwner = this.db.reservedHostnames[key];

    if (existingOwner && existingOwner !== deploymentId) {
      const existingRecord = this.db.deployments[existingOwner];
      // If an owner is already registered (even if deployment record is about to be inserted in the same tick),
      // only allow takeover when the prior deployment explicitly reached DELETED or FAILED.
      if (
        !existingRecord ||
        (existingRecord.status !== 'DELETED' && existingRecord.status !== 'FAILED')
      ) {
        return { reserved: false, existingDeploymentId: existingOwner };
      }
    }

    this.db.reservedHostnames[key] = deploymentId;
    this.saveToDisk();
    return { reserved: true };
  }

  public releaseHostname(customHostname?: string, deploymentId?: string): void {
    if (!customHostname) return;
    const key = customHostname.trim().toLowerCase();
    const owner = this.db.reservedHostnames[key];
    if (!deploymentId || owner === deploymentId) {
      delete this.db.reservedHostnames[key];
      this.saveToDisk();
    }
  }

  public isHostnameAvailable(customHostname: string): boolean {
    const key = customHostname.trim().toLowerCase();
    const existingOwner = this.db.reservedHostnames[key];
    if (!existingOwner) return true;
    const rec = this.db.deployments[existingOwner];
    if (!rec) return false;
    return rec.status === 'DELETED' || rec.status === 'FAILED';
  }

  public create(record: DeploymentRecord): DeploymentRecord {
    this.db.deployments[record.deploymentId] = record;
    this.saveToDisk();
    void this.syncToPostgres(record);
    void this.syncToDynamoDB(record);
    this.emitUpdate(record);
    return record;
  }

  public get(deploymentId: string): DeploymentRecord | undefined {
    return this.db.deployments[deploymentId];
  }

  /**
   * DM-902 / DM-905: Tenant-isolated deployment lookup preventing IDOR across organizations.
   */
  public getForOrg(deploymentId: string, orgId: string): DeploymentRecord | undefined {
    const rec = this.db.deployments[deploymentId];
    if (!rec || rec.orgId !== orgId) {
      return undefined;
    }
    return rec;
  }

  public listAll(): DeploymentRecord[] {
    return Object.values(this.db.deployments).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * DM-902 AC2: Strict organization-scoped deployment listing.
   */
  public listByOrg(orgId: string): DeploymentRecord[] {
    return Object.values(this.db.deployments)
      .filter((d) => d.orgId === orgId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public countActiveDeployments(orgId?: string): number {
    const activeStatuses = new Set<DeploymentStatus>([
      'QUEUED',
      'ANALYZING',
      'BUILDING',
      'DEPLOYING',
      'CONFIGURING_DOMAIN',
      'VERIFYING',
    ]);
    return Object.values(this.db.deployments).filter(
      (d) => activeStatuses.has(d.status) && (!orgId || d.orgId === orgId)
    ).length;
  }

  public update(
    deploymentId: string,
    patch: Partial<Omit<DeploymentRecord, 'deploymentId' | 'createdAt'>>
  ): DeploymentRecord | undefined {
    const existing = this.db.deployments[deploymentId];
    if (!existing) return undefined;

    const updated: DeploymentRecord = {
      ...existing,
      ...patch,
      checklist: patch.checklist
        ? { ...existing.checklist, ...patch.checklist }
        : existing.checklist,
      resources: patch.resources
        ? { ...existing.resources, ...patch.resources }
        : existing.resources,
      updatedAt: new Date().toISOString(),
    };

    this.db.deployments[deploymentId] = updated;
    this.saveToDisk();
    void this.syncToPostgres(updated);
    void this.syncToDynamoDB(updated);
    this.emitUpdate(updated);
    return updated;
  }

  public addLog(
    deploymentId: string,
    phase: DeploymentStatus,
    level: AuditLogEntry['level'],
    message: string
  ): void {
    const existing = this.db.deployments[deploymentId];
    if (!existing) return;

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      phase,
      level,
      message,
    };

    existing.auditLogs.push(entry);
    existing.updatedAt = entry.timestamp;
    this.saveToDisk();
    this.emitUpdate(existing);
  }

  public updateChecklist(
    deploymentId: string,
    checklistPatch: Partial<DeploymentChecklist>
  ): void {
    const existing = this.db.deployments[deploymentId];
    if (!existing) return;

    existing.checklist = {
      ...existing.checklist,
      ...checklistPatch,
    };
    existing.updatedAt = new Date().toISOString();
    this.saveToDisk();
    this.emitUpdate(existing);
  }

  public updateResources(
    deploymentId: string,
    resourcePatch: Partial<TrackedCloudResources>
  ): void {
    const existing = this.db.deployments[deploymentId];
    if (!existing) return;

    existing.resources = {
      ...existing.resources,
      ...resourcePatch,
    };
    existing.updatedAt = new Date().toISOString();
    this.saveToDisk();
    this.emitUpdate(existing);
  }

  // ============================================================================
  // DM-904 & DM-905: Multi-Tenant Users, Organizations, Memberships & Projects
  // ============================================================================

  public upsertUser(user: UserRecord): UserRecord {
    this.db.users[user.userId] = user;
    this.saveToDisk();
    return user;
  }

  public getUserById(userId: string): UserRecord | undefined {
    return this.db.users[userId];
  }

  public getUserByEmail(email: string): UserRecord | undefined {
    const norm = email.trim().toLowerCase();
    return Object.values(this.db.users).find((u) => u.email.toLowerCase() === norm);
  }

  public createOrganization(org: OrganizationRecord): OrganizationRecord {
    const slugConflict = Object.values(this.db.organizations).find(
      (o) => o.slug.toLowerCase() === org.slug.toLowerCase() && o.orgId !== org.orgId
    );
    if (slugConflict) {
      throw new Error(`Organization slug "${org.slug}" is already taken.`);
    }
    this.db.organizations[org.orgId] = org;
    this.saveToDisk();
    return org;
  }

  public getOrganization(orgId: string): OrganizationRecord | undefined {
    return this.db.organizations[orgId];
  }

  public updateOrganization(
    orgId: string,
    patch: Partial<Omit<OrganizationRecord, 'orgId' | 'createdAt'>>
  ): OrganizationRecord | undefined {
    const existing = this.db.organizations[orgId];
    if (!existing) return undefined;
    const updated: OrganizationRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.db.organizations[orgId] = updated;
    this.saveToDisk();
    return updated;
  }

  public upsertMembership(membership: MembershipRecord): MembershipRecord {
    const existing = Object.values(this.db.memberships).find(
      (m) => m.orgId === membership.orgId && m.userId === membership.userId
    );
    if (existing) {
      const updated: MembershipRecord = {
        ...existing,
        role: membership.role,
        userEmail: membership.userEmail,
      };
      this.db.memberships[existing.membershipId] = updated;
      this.saveToDisk();
      return updated;
    }
    this.db.memberships[membership.membershipId] = membership;
    this.saveToDisk();
    return membership;
  }

  public getMembership(orgId: string, userId: string): MembershipRecord | undefined {
    return Object.values(this.db.memberships).find(
      (m) => m.orgId === orgId && m.userId === userId
    );
  }

  public getUserRoleInOrg(orgId: string, userId: string): OrgRole | undefined {
    return this.getMembership(orgId, userId)?.role;
  }

  public listMembershipsForOrg(orgId: string): MembershipRecord[] {
    return Object.values(this.db.memberships).filter((m) => m.orgId === orgId);
  }

  public listOrganizationsForUser(
    userId: string
  ): Array<{ organization: OrganizationRecord; role: OrgRole }> {
    const userMemberships = Object.values(this.db.memberships).filter(
      (m) => m.userId === userId
    );
    const results: Array<{ organization: OrganizationRecord; role: OrgRole }> = [];
    for (const m of userMemberships) {
      const org = this.db.organizations[m.orgId];
      if (org) {
        results.push({ organization: org, role: m.role });
      }
    }
    return results;
  }

  public createProject(project: ProjectRecord): ProjectRecord {
    const conflict = Object.values(this.db.projects).find(
      (p) =>
        p.orgId === project.orgId &&
        p.slug.toLowerCase() === project.slug.toLowerCase()
    );
    if (conflict) {
      throw new Error(
        `Project slug "${project.slug}" already exists in this organization.`
      );
    }
    this.db.projects[project.projectId] = project;
    this.saveToDisk();
    return project;
  }

  public getProject(projectId: string): ProjectRecord | undefined {
    return this.db.projects[projectId];
  }

  public getProjectForOrg(projectId: string, orgId: string): ProjectRecord | undefined {
    const proj = this.db.projects[projectId];
    if (!proj || proj.orgId !== orgId) return undefined;
    return proj;
  }

  public listProjectsForOrg(orgId: string): ProjectRecord[] {
    return Object.values(this.db.projects)
      .filter((p) => p.orgId === orgId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
}

export const deploymentStore = new DeploymentStore();
