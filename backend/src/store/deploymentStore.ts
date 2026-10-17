import fs from 'fs';
import path from 'path';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import {
  AuditLogEntry,
  DeploymentChecklist,
  DeploymentRecord,
  DeploymentStatus,
  TrackedAwsResources,
} from '../types/deployment';

interface PersistedDatabase {
  deployments: Record<string, DeploymentRecord>;
  /**
   * Maps full hostname (e.g. "demo.repo2cloud.dev") -> deploymentId
   */
  reservedHostnames: Record<string, string>;
}

export class DeploymentStore {
  private readonly filePath: string;
  private db: PersistedDatabase;
  private dynamoClient?: DynamoDBClient;
  private dynamoTableName?: string;

  constructor(customFilePath?: string) {
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
  }

  private loadFromDisk(): PersistedDatabase {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedDatabase;
        return {
          deployments: parsed.deployments || {},
          reservedHostnames: parsed.reservedHostnames || {},
        };
      }
    } catch {
      // Fallback to empty database if file is corrupted
    }
    return {
      deployments: {},
      reservedHostnames: {},
    };
  }

  private saveToDisk(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(this.db, null, 2), 'utf-8');
    fs.renameSync(tmpFile, this.filePath);
  }

  private async syncToDynamoDB(record: DeploymentRecord): Promise<void> {
    if (!this.dynamoClient || !this.dynamoTableName) return;
    try {
      await this.dynamoClient.send(
        new PutItemCommand({
          TableName: this.dynamoTableName,
          Item: {
            deploymentId: { S: record.deploymentId },
            status: { S: record.status },
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

  /**
   * Reserves a custom hostname before deployment begins, preventing duplicate assignments.
   */
  public reserveHostname(
    customHostname: string,
    deploymentId: string
  ): { reserved: boolean; existingDeploymentId?: string } {
    const key = customHostname.toLowerCase();
    const existingOwner = this.db.reservedHostnames[key];

    if (existingOwner && existingOwner !== deploymentId) {
      const existingRecord = this.db.deployments[existingOwner];
      if (existingRecord && existingRecord.status !== 'DELETED' && existingRecord.status !== 'FAILED') {
        return { reserved: false, existingDeploymentId: existingOwner };
      }
    }

    this.db.reservedHostnames[key] = deploymentId;
    this.saveToDisk();
    return { reserved: true };
  }

  public releaseHostname(customHostname?: string, deploymentId?: string): void {
    if (!customHostname) return;
    const key = customHostname.toLowerCase();
    const owner = this.db.reservedHostnames[key];
    if (!deploymentId || owner === deploymentId) {
      delete this.db.reservedHostnames[key];
      this.saveToDisk();
    }
  }

  public isHostnameAvailable(customHostname: string): boolean {
    const key = customHostname.toLowerCase();
    const existingOwner = this.db.reservedHostnames[key];
    if (!existingOwner) return true;
    const rec = this.db.deployments[existingOwner];
    return !rec || rec.status === 'DELETED' || rec.status === 'FAILED';
  }

  public create(record: DeploymentRecord): DeploymentRecord {
    this.db.deployments[record.deploymentId] = record;
    this.saveToDisk();
    void this.syncToDynamoDB(record);
    return record;
  }

  public get(deploymentId: string): DeploymentRecord | undefined {
    return this.db.deployments[deploymentId];
  }

  public listAll(): DeploymentRecord[] {
    return Object.values(this.db.deployments).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public countActiveDeployments(): number {
    const activeStatuses = new Set<DeploymentStatus>([
      'QUEUED',
      'ANALYZING',
      'BUILDING',
      'DEPLOYING',
      'CONFIGURING_DOMAIN',
      'VERIFYING',
    ]);
    return Object.values(this.db.deployments).filter((d) => activeStatuses.has(d.status)).length;
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
    void this.syncToDynamoDB(updated);
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
  }

  public updateResources(
    deploymentId: string,
    resourcePatch: Partial<TrackedAwsResources>
  ): void {
    const existing = this.db.deployments[deploymentId];
    if (!existing) return;

    existing.resources = {
      ...existing.resources,
      ...resourcePatch,
    };
    existing.updatedAt = new Date().toISOString();
    this.saveToDisk();
  }
}

export const deploymentStore = new DeploymentStore();
