import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import {
  GitHubConnectedRepo,
  GitHubInstallationRecord,
} from '../types/tenant';
import { maskSecretValue } from './secretsVault';

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getEnvelopeKey(): Buffer {
  const rawSecret =
    process.env.SECRETS_MASTER_KEY ||
    'deploymate-phase9-aes256gcm-envelope-master-key-change-in-prod';
  return crypto.createHash('sha256').update(rawSecret, 'utf8').digest();
}

interface GitHubApiRepoItem {
  id: number | string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
  clone_url?: string;
  owner?: {
    login?: string;
    type?: string;
  };
}

/**
 * DM-906 (#6): Official GitHub App RS256 JWT Signer, Short-Lived Installation Token Exchange,
 * Live GitHub Public/Private Repository Discovery & .git/config Credential Scrubber.
 */
export class GitHubAppService {
  /**
   * Generates a standard RS256 GitHub App JWT valid for 9 minutes using Node crypto.
   */
  public signAppJwt(appId: string, privateKeyPem: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: appId,
      })
    );
    const signingInput = `${header}.${payload}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(privateKeyPem);
    return `${signingInput}.${base64Url(signature)}`;
  }

  private encryptInstallationToken(
    orgId: string,
    installationId: string,
    plaintextToken: string
  ): NonNullable<GitHubInstallationRecord['encryptedAccessToken']> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEnvelopeKey(), iv);
    cipher.setAAD(Buffer.from(`gh_inst:${orgId}:${installationId}`, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(plaintextToken, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      maskedPreview: maskSecretValue(plaintextToken),
    };
  }

  private decryptInstallationToken(record: GitHubInstallationRecord): string | undefined {
    const env = record.encryptedAccessToken;
    if (!env) return undefined;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getEnvelopeKey(),
      Buffer.from(env.iv, 'base64')
    );
    decipher.setAAD(
      Buffer.from(`gh_inst:${record.orgId}:${record.installationId}`, 'utf8')
    );
    decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * Exchanges a GitHub App installation_id for a short-lived (1-hour) installation token,
   * or decrypts an AES-256-GCM envelope-protected GitHub Fine-Grained Token in memory for local dev.
   */
  public async getEphemeralInstallationToken(
    installationId: string,
    store: DeploymentStore = deploymentStore
  ): Promise<{ token: string; expiresAt: string }> {
    const installation = store.getGitHubInstallation(installationId);
    if (!installation) {
      throw new Error(`GitHub App installation "${installationId}" is not registered.`);
    }

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (
      appId &&
      privateKey &&
      process.env.FORCE_DRY_RUN_TEST !== 'true' &&
      !installationId.startsWith('inst_')
    ) {
      const appJwt = this.signAppJwt(appId, privateKey);
      const res = await fetch(
        `https://api.github.com/app/installations/${encodeURIComponent(
          installationId
        )}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${appJwt}`,
            'User-Agent': 'DeployMate-GitHubApp/1.0',
          },
        }
      );
      if (!res.ok) {
        throw new Error(`GitHub App token exchange failed with HTTP ${res.status}`);
      }
      const data = (await res.json()) as { token: string; expires_at: string };
      return { token: data.token, expiresAt: data.expires_at };
    }

    if (installation.encryptedAccessToken) {
      const decrypted = this.decryptInstallationToken(installation);
      if (decrypted) {
        return { token: decrypted, expiresAt };
      }
    }

    if (
      process.env.FORCE_DRY_RUN_TEST !== 'true' &&
      process.env.GITHUB_ACCESS_TOKEN?.trim()
    ) {
      return { token: process.env.GITHUB_ACCESS_TOKEN.trim(), expiresAt };
    }

    const ephemeralToken = `ghs_ephemeral_${crypto.randomBytes(12).toString('hex')}`;
    return { token: ephemeralToken, expiresAt };
  }

  private async fetchRepoBranches(
    fullName: string,
    defaultBranch: string,
    token?: string
  ): Promise<string[]> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DeployMate-GitHubApp/1.0',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${fullName}/branches?per_page=10`,
        { headers, signal: controller.signal }
      );
      if (!res.ok) return [defaultBranch];
      const list = (await res.json()) as Array<{ name?: string }>;
      if (!Array.isArray(list) || list.length === 0) return [defaultBranch];
      const names = list
        .map((b) => b.name)
        .filter((n): n is string => Boolean(n));
      if (!names.includes(defaultBranch)) {
        names.unshift(defaultBranch);
      }
      return names;
    } catch {
      return [defaultBranch];
    } finally {
      clearTimeout(timer);
    }
  }

  private async discoverLiveGitHubRepositories(params: {
    owner: string;
    installationId?: string;
    accessToken?: string;
  }): Promise<{
    repos: GitHubConnectedRepo[];
    detectedAccountType: 'User' | 'Organization';
    authMode: 'github_app' | 'token_authenticated' | 'public_unauthenticated';
  }> {
    const { owner, installationId, accessToken } = params;
    const appId = process.env.GITHUB_APP_ID?.trim();
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    // 1. Official Production GitHub App RS256 Token Exchange Flow
    if (appId && privateKey && installationId && !installationId.startsWith('inst_')) {
      const appJwt = this.signAppJwt(appId, privateKey);
      const tokRes = await fetch(
        `https://api.github.com/app/installations/${encodeURIComponent(
          installationId
        )}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${appJwt}`,
            'User-Agent': 'DeployMate-GitHubApp/1.0',
          },
        }
      );
      if (!tokRes.ok) {
        throw new Error(
          `GitHub App installation token exchange failed (HTTP ${tokRes.status}). Verify GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and installationId.`
        );
      }
      const tokData = (await tokRes.json()) as { token: string };
      const reposRes = await fetch(
        'https://api.github.com/installation/repositories?per_page=50',
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${tokData.token}`,
            'User-Agent': 'DeployMate-GitHubApp/1.0',
          },
        }
      );
      if (!reposRes.ok) {
        throw new Error(`Failed to list GitHub App repositories (HTTP ${reposRes.status}).`);
      }
      const payload = (await reposRes.json()) as { repositories?: GitHubApiRepoItem[] };
      const items = payload.repositories || [];
      const mapped = await Promise.all(
        items.slice(0, 20).map(async (item, idx) => {
          const repoOwner = item.owner?.login || owner;
          const defBranch = item.default_branch || 'main';
          const branches =
            idx < 8
              ? await this.fetchRepoBranches(`${repoOwner}/${item.name}`, defBranch, tokData.token)
              : [defBranch];
          return {
            repoId: `ghr_${item.id}`,
            owner: repoOwner,
            name: item.name,
            fullName: item.full_name || `${repoOwner}/${item.name}`,
            private: Boolean(item.private),
            defaultBranch: defBranch,
            branches,
            cloneUrl: item.clone_url || `https://github.com/${repoOwner}/${item.name}.git`,
          };
        })
      );
      return {
        repos: mapped,
        detectedAccountType:
          items[0]?.owner?.type === 'Organization' ? 'Organization' : 'User',
        authMode: 'github_app',
      };
    }

    // 2. Authenticated GitHub Token Flow (unlocks PRIVATE + PUBLIC repos for @owner!)
    const effectiveToken =
      accessToken?.trim() || process.env.GITHUB_ACCESS_TOKEN?.trim();
    if (effectiveToken) {
      const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${effectiveToken}`,
        'User-Agent': 'DeployMate-GitHubApp/1.0',
      };
      const userReposRes = await fetch(
        'https://api.github.com/user/repos?per_page=60&sort=updated&affiliation=owner,collaborator,organization_member',
        { headers }
      );
      if (userReposRes.status === 401 || userReposRes.status === 403) {
        throw new Error(
          `GitHub rejected the access token (HTTP ${userReposRes.status}). Generate a Fine-Grained Token (github_pat_... or ghp_...) with Repository "Contents: Read-only" and "Metadata: Read-only".`
        );
      }
      if (!userReposRes.ok) {
        throw new Error(`GitHub API error (HTTP ${userReposRes.status}).`);
      }

      const allAuthRepos = (await userReposRes.json()) as GitHubApiRepoItem[];
      let matching = allAuthRepos.filter(
        (r) => (r.owner?.login || '').toLowerCase() === owner.toLowerCase()
      );

      // If owner wasn't among /user/repos (e.g. inspecting another org/user), fall back to /users/{owner}/repos with token
      if (matching.length === 0) {
        const fallbackRes = await fetch(
          `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=30&sort=updated`,
          { headers }
        );
        if (fallbackRes.ok) {
          matching = (await fallbackRes.json()) as GitHubApiRepoItem[];
        }
      }

      const mapped = await Promise.all(
        matching.slice(0, 25).map(async (item, idx) => {
          const repoOwner = item.owner?.login || owner;
          const defBranch = item.default_branch || 'main';
          const branches =
            idx < 8
              ? await this.fetchRepoBranches(
                  `${repoOwner}/${item.name}`,
                  defBranch,
                  effectiveToken
                )
              : [defBranch];
          return {
            repoId: `ghr_${item.id}`,
            owner: repoOwner,
            name: item.name,
            fullName: item.full_name || `${repoOwner}/${item.name}`,
            private: Boolean(item.private),
            defaultBranch: defBranch,
            branches,
            cloneUrl: item.clone_url || `https://github.com/${repoOwner}/${item.name}.git`,
          };
        })
      );

      return {
        repos: mapped,
        detectedAccountType:
          matching[0]?.owner?.type === 'Organization' ? 'Organization' : 'User',
        authMode: 'token_authenticated',
      };
    }

    // 3. Unauthenticated Live GitHub Discovery (loads real PUBLIC repos of @owner immediately)
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DeployMate-GitHubApp/1.0',
    };
    let pubRes = await fetch(
      `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=30&sort=updated`,
      { headers }
    );
    if (pubRes.status === 404) {
      pubRes = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?per_page=30&sort=updated`,
        { headers }
      );
    }
    if (pubRes.status === 404) {
      throw new Error(
        `GitHub user or organization "@${owner}" was not found on GitHub.`
      );
    }
    if (!pubRes.ok) {
      throw new Error(
        `GitHub API returned HTTP ${pubRes.status}. Provide a GitHub Fine-Grained Token to bypass anonymous rate limits and access private repos.`
      );
    }

    const pubItems = (await pubRes.json()) as GitHubApiRepoItem[];
    const mapped = await Promise.all(
      pubItems.slice(0, 20).map(async (item, idx) => {
        const repoOwner = item.owner?.login || owner;
        const defBranch = item.default_branch || 'main';
        const branches =
          idx < 5
            ? await this.fetchRepoBranches(`${repoOwner}/${item.name}`, defBranch)
            : [defBranch];
        return {
          repoId: `ghr_${item.id}`,
          owner: repoOwner,
          name: item.name,
          fullName: item.full_name || `${repoOwner}/${item.name}`,
          private: Boolean(item.private),
          defaultBranch: defBranch,
          branches,
          cloneUrl: item.clone_url || `https://github.com/${repoOwner}/${item.name}.git`,
        };
      })
    );

    return {
      repos: mapped,
      detectedAccountType:
        pubItems[0]?.owner?.type === 'Organization' ? 'Organization' : 'User',
      authMode: 'public_unauthenticated',
    };
  }

  /**
   * Connects or updates a GitHub installation for an organization.
   * - In test / explicit mock mode: uses deterministic provided or synthetic repositories.
   * - In live mode: queries api.github.com for @accountLogin's real repositories (both private & public when a token or GitHub App is supplied, or real public repos when unauthenticated).
   */
  public async connectInstallation(
    params: {
      orgId: string;
      installationId?: string;
      accountLogin: string;
      accountType?: 'User' | 'Organization';
      accessToken?: string;
      repositories?: Array<{
        name: string;
        private?: boolean;
        defaultBranch?: string;
        branches?: string[];
      }>;
    },
    store: DeploymentStore = deploymentStore
  ): Promise<GitHubInstallationRecord> {
    const now = new Date().toISOString();
    const owner = params.accountLogin.trim();

    // Live GitHub API discovery when running outside unit test dry-run and no explicit mock repos passed
    if (
      process.env.FORCE_DRY_RUN_TEST !== 'true' &&
      !Array.isArray(params.repositories)
    ) {
      const live = await this.discoverLiveGitHubRepositories({
        owner,
        installationId: params.installationId?.trim(),
        accessToken: params.accessToken?.trim(),
      });

      const installationId =
        params.installationId?.trim() ||
        `inst_live_${crypto.randomBytes(4).toString('hex')}`;

      const rawTokenToEncrypt =
        params.accessToken?.trim() || undefined;

      const record: GitHubInstallationRecord = {
        installationId,
        orgId: params.orgId,
        accountLogin: owner,
        accountType: live.detectedAccountType || params.accountType || 'User',
        authMode: live.authMode,
        encryptedAccessToken: rawTokenToEncrypt
          ? this.encryptInstallationToken(params.orgId, installationId, rawTokenToEncrypt)
          : undefined,
        repositories: live.repos,
        createdAt: now,
        updatedAt: now,
      };

      return store.upsertGitHubInstallation(record);
    }

    // Deterministic offline / test fixture path (TC-906-02)
    const installationId =
      params.installationId?.trim() ||
      `inst_mock_${crypto.randomBytes(4).toString('hex')}`;

    const defaultRepos = params.repositories || [
      {
        name: 'commercial-saas-web',
        private: true,
        defaultBranch: 'main',
        branches: ['main', 'staging', 'feat/billing'],
      },
      {
        name: 'ai-agent-api',
        private: true,
        defaultBranch: 'main',
        branches: ['main', 'dev'],
      },
      {
        name: 'marketing-landing',
        private: false,
        defaultBranch: 'main',
        branches: ['main'],
      },
    ];

    const connectedRepos: GitHubConnectedRepo[] = defaultRepos.map((r, idx) => {
      const cleanName = r.name.trim();
      return {
        repoId: `ghr_${installationId}_${idx + 1}`,
        owner,
        name: cleanName,
        fullName: `${owner}/${cleanName}`,
        private: Boolean(r.private),
        defaultBranch: r.defaultBranch || 'main',
        branches: r.branches && r.branches.length > 0 ? r.branches : ['main'],
        cloneUrl: `https://github.com/${owner}/${cleanName}.git`,
      };
    });

    return store.upsertGitHubInstallation({
      installationId,
      orgId: params.orgId,
      accountLogin: owner,
      accountType: params.accountType || 'Organization',
      authMode: 'mock',
      repositories: connectedRepos,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Sanitizes a GitHubInstallationRecord before returning over HTTP so AES-256-GCM ciphertext/IV/tag never leave the server.
   */
  public toPublicInstallationView(record: GitHubInstallationRecord): Omit<
    GitHubInstallationRecord,
    'encryptedAccessToken'
  > & {
    hasEncryptedToken: boolean;
    maskedTokenPreview?: string;
  } {
    const { encryptedAccessToken, ...rest } = record;
    return {
      ...rest,
      hasEncryptedToken: Boolean(encryptedAccessToken),
      maskedTokenPreview: encryptedAccessToken?.maskedPreview,
    };
  }

  /**
   * TC-906-02: Lists paginated repositories and branches scoped strictly to the org's installations.
   */
  public listOrgRepositories(
    params: {
      orgId: string;
      page?: number;
      perPage?: number;
      query?: string;
    },
    store: DeploymentStore = deploymentStore
  ): {
    repositories: GitHubConnectedRepo[];
    page: number;
    perPage: number;
    totalCount: number;
    totalPages: number;
  } {
    const installations = store.listGitHubInstallationsForOrg(params.orgId);
    let allRepos = installations.flatMap((inst) => inst.repositories);

    if (params.query && params.query.trim()) {
      const q = params.query.trim().toLowerCase();
      allRepos = allRepos.filter((r) => r.fullName.toLowerCase().includes(q));
    }

    const page = Math.max(1, Number(params.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(params.perPage || 20)));
    const totalCount = allRepos.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const startIdx = (page - 1) * perPage;

    return {
      repositories: allRepos.slice(startIdx, startIdx + perPage),
      page,
      perPage,
      totalCount,
      totalPages,
    };
  }

  /**
   * DM-906 AC2: Scrubs any embedded GitHub installation token or Basic/Bearer auth header
   * from .git/config inside the isolated workspace BEFORE running untrusted user build scripts.
   */
  public scrubGitConfigCredentials(repoDir: string): void {
    const gitConfigPath = path.join(repoDir, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) {
      return;
    }

    const raw = fs.readFileSync(gitConfigPath, 'utf8');
    const scrubbed = raw
      // Strip https://x-access-token:<TOKEN>@github.com/... -> https://github.com/...
      .replace(/https:\/\/[^@\s/]+@github\.com/gi, 'https://github.com')
      // Strip extraheader = AUTHORIZATION: basic/bearer ...
      .replace(/^\s*extraheader\s*=\s*AUTHORIZATION:.*$/gim, '')
      // Strip any stray ghs_ / ghp_ / github_pat_ tokens
      .replace(/\b(ghs_[A-Za-z0-9_]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '');

    fs.writeFileSync(gitConfigPath, scrubbed, 'utf8');
  }
}

export const githubAppService = new GitHubAppService();
