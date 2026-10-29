import crypto from 'crypto';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import { EncryptedSecretRecord, EnvironmentType } from '../types/tenant';
import { sanitizeUserEnvVars } from '../utils/validation';

export interface MaskedSecretSummary {
  secretId: string;
  projectId: string;
  environment: EnvironmentType;
  key: string;
  maskedPreview: string;
  updatedAt: string;
}

function getMasterKeyBuffer(): Buffer {
  const rawSecret =
    process.env.SECRETS_MASTER_KEY ||
    'deploymate-phase9-aes256gcm-envelope-master-key-change-in-prod';
  return crypto.createHash('sha256').update(rawSecret, 'utf8').digest();
}

export function maskSecretValue(value: string): string {
  if (!value || value.length <= 6) {
    return '••••••••';
  }
  const prefix = value.slice(0, Math.min(4, Math.floor(value.length / 3)));
  const suffix = value.slice(-Math.min(4, Math.floor(value.length / 4)));
  return `${prefix}••••${suffix}`;
}

/**
 * DM-913 (#13) AC2: Parses multi-line .env text (ignoring comments & blank lines)
 * and enforces Phase 7/9 restricted key sanitization.
 */
export function parseDotEnvContent(rawDotEnv: string): {
  valid: boolean;
  parsed: Record<string, string>;
  error?: string;
} {
  const rawPairs: Record<string, string> = {};
  const lines = rawDotEnv.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;

    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }

    const key = withoutExport.slice(0, eqIdx).trim();
    let val = withoutExport.slice(eqIdx + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      const inlineCommentIdx = val.indexOf(' #');
      if (inlineCommentIdx !== -1) {
        val = val.slice(0, inlineCommentIdx).trim();
      }
    }

    if (key) {
      rawPairs[key] = val;
    }
  }

  const sanitized = sanitizeUserEnvVars(rawPairs);
  if (!sanitized.valid) {
    return {
      valid: false,
      parsed: {},
      error: sanitized.error,
    };
  }

  return {
    valid: true,
    parsed: sanitized.sanitized,
  };
}

/**
 * DM-913 (#13): AES-256-GCM Encrypted Secrets Vault with authenticated AAD binding.
 */
export class SecretsVaultService {
  private buildAad(
    projectId: string,
    environment: EnvironmentType,
    key: string
  ): Buffer {
    return Buffer.from(`${projectId}:${environment}:${key}`, 'utf8');
  }

  public encryptValue(params: {
    orgId: string;
    projectId: string;
    environment: EnvironmentType;
    key: string;
    plaintext: string;
    updatedByUserId?: string;
  }): EncryptedSecretRecord {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKeyBuffer(), iv);
    cipher.setAAD(this.buildAad(params.projectId, params.environment, params.key));

    const encrypted = Buffer.concat([
      cipher.update(params.plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const now = new Date().toISOString();

    return {
      secretId: `sec_${crypto.randomBytes(5).toString('hex')}`,
      orgId: params.orgId,
      projectId: params.projectId,
      environment: params.environment,
      key: params.key,
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      maskedPreview: maskSecretValue(params.plaintext),
      updatedByUserId: params.updatedByUserId,
      createdAt: now,
      updatedAt: now,
    };
  }

  public decryptRecord(record: EncryptedSecretRecord): string {
    try {
      const ivBuf = Buffer.from(record.iv, 'base64');
      const tagBuf = Buffer.from(record.authTag, 'base64');
      const cipherBuf = Buffer.from(record.ciphertext, 'base64');

      if (ivBuf.length !== 12 || tagBuf.length !== 16) {
        throw new Error('Invalid IV or GCM authentication tag length.');
      }

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        getMasterKeyBuffer(),
        ivBuf
      );
      decipher.setAAD(
        this.buildAad(record.projectId, record.environment, record.key)
      );
      decipher.setAuthTag(tagBuf);

      const decrypted = Buffer.concat([
        decipher.update(cipherBuf),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      throw new Error(
        `Secret integrity verification failed for "${record.key}" (tampered ciphertext or authentication tag).`
      );
    }
  }

  public saveSecrets(
    params: {
      orgId: string;
      projectId: string;
      environment: EnvironmentType;
      secrets: Record<string, string>;
      updatedByUserId?: string;
    },
    store: DeploymentStore = deploymentStore
  ): MaskedSecretSummary[] {
    const check = sanitizeUserEnvVars(params.secrets);
    if (!check.valid) {
      throw new Error(check.error || 'Invalid secret variables.');
    }

    const summaries: MaskedSecretSummary[] = [];
    for (const [key, value] of Object.entries(check.sanitized)) {
      const encrypted = this.encryptValue({
        orgId: params.orgId,
        projectId: params.projectId,
        environment: params.environment,
        key,
        plaintext: value,
        updatedByUserId: params.updatedByUserId,
      });
      const saved = store.upsertEncryptedSecret(encrypted);
      summaries.push({
        secretId: saved.secretId,
        projectId: saved.projectId,
        environment: saved.environment,
        key: saved.key,
        maskedPreview: saved.maskedPreview,
        updatedAt: saved.updatedAt,
      });
    }

    return summaries;
  }

  public listMaskedSecrets(
    projectId: string,
    environment?: EnvironmentType,
    store: DeploymentStore = deploymentStore
  ): MaskedSecretSummary[] {
    return store.listEncryptedSecrets(projectId, environment).map((s) => ({
      secretId: s.secretId,
      projectId: s.projectId,
      environment: s.environment,
      key: s.key,
      maskedPreview: s.maskedPreview,
      updatedAt: s.updatedAt,
    }));
  }

  /**
   * Decrypts secrets strictly in-memory for a deployment execution — never persisted or returned over HTTP.
   */
  public resolveDecryptedSecretsForDeploy(
    projectId: string | undefined,
    environment: EnvironmentType = 'production',
    store: DeploymentStore = deploymentStore
  ): Record<string, string> {
    if (!projectId) return {};
    const records = store.listEncryptedSecrets(projectId, environment);
    const decrypted: Record<string, string> = {};
    for (const rec of records) {
      decrypted[rec.key] = this.decryptRecord(rec);
    }
    return decrypted;
  }
}

export const secretsVault = new SecretsVaultService();
