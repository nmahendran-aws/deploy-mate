import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import {
  GitHubConnectedRepo,
  GitHubInstallationRecord,
} from '../types/tenant';

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * DM-906 (#6): Official GitHub App RS256 JWT Signer, Short-Lived Installation Token Exchange,
 * Connected Private Repository Discovery & .git/config Credential Scrubber.
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

  /**
   * Exchanges a GitHub App installation_id for a short-lived (1-hour) installation token.
   * Uses live GitHub App REST API when GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are configured,
   * or issues an isolated ephemeral installation token in dry-run / local dev mode.
   */
  public async getEphemeralInstallationToken(
    installationId: string,
    store: DeploymentStore = deploymentStore
  ): Promise<{ token: string; expiresAt: string }> {
    const installation = store.getGitHubInstallation(installationId);
    if (!installation) {
      throw new Error(`GitHub App installation "${installationId}" is not registered.`);
    }

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (
      appId &&
      privateKey &&
      process.env.FORCE_DRY_RUN_TEST !== 'true' &&
      !installationId.startsWith('inst_mock_')
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

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const ephemeralToken = `ghs_ephemeral_${crypto.randomBytes(12).toString('hex')}`;
    return { token: ephemeralToken, expiresAt };
  }

  /**
   * Connects or updates a GitHub App installation for an organization.
   */
  public connectInstallation(
    params: {
      orgId: string;
      installationId?: string;
      accountLogin: string;
      accountType?: 'User' | 'Organization';
      repositories?: Array<{
        name: string;
        private?: boolean;
        defaultBranch?: string;
        branches?: string[];
      }>;
    },
    store: DeploymentStore = deploymentStore
  ): GitHubInstallationRecord {
    const now = new Date().toISOString();
    const owner = params.accountLogin.trim();
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
      repositories: connectedRepos,
      createdAt: now,
      updatedAt: now,
    });
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
