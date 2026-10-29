import crypto from 'crypto';
import { DeploymentManager, deploymentManager } from './deploymentManager';
import { DeploymentStore, deploymentStore } from '../store/deploymentStore';
import { DeploymentRecord } from '../types/deployment';

function getWebhookSecret(): string {
  return (
    process.env.GITHUB_WEBHOOK_SECRET ||
    'deploymate-phase9-github-webhook-hmac-secret'
  );
}

/**
 * Computes X-Hub-Signature-256 HMAC header for a raw GitHub webhook payload.
 */
export function computeGitHubWebhookSignature(
  rawBody: Buffer | string,
  secret: string = getWebhookSecret()
): string {
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  return `sha256=${hmac}`;
}

/**
 * DM-907 (#7) AC1: Constant-time HMAC-SHA256 verification of X-Hub-Signature-256.
 */
export function verifyGitHubWebhookSignature(
  rawBody: Buffer | string | undefined,
  signatureHeader?: string,
  secret: string = getWebhookSecret()
): boolean {
  if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = computeGitHubWebhookSignature(rawBody, secret);
  const actualBuf = Buffer.from(signatureHeader.trim(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Generates deterministic RFC-1123 preview subdomain: pr-<prNumber>-<slug>
 */
export function buildPrPreviewSubdomain(prNumber: number, projectOrRepoSlug: string): string {
  const cleanSlug = projectOrRepoSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return `pr-${prNumber}-${cleanSlug || 'app'}`.slice(0, 63).replace(/-+$/, '');
}

function renderPrPreviewMarkdown(dep: DeploymentRecord): string {
  const statusBadge =
    dep.status === 'LIVE'
      ? '🟢 **LIVE**'
      : dep.status === 'FAILED'
      ? '🔴 **FAILED**'
      : dep.status === 'DELETED'
      ? '⚪ **DELETED (Resources Torn Down)**'
      : `🟡 **${dep.status}**`;

  const urlCell =
    dep.status === 'LIVE' && dep.url
      ? `[${dep.url}](${dep.url})`
      : dep.customHostname
      ? `Provisioning \`https://${dep.customHostname}\`...`
      : '_Pending verification_';

  const hourlyCost =
    dep.target === 'ECS_FARGATE'
      ? '~$0.012/hr'
      : dep.target === 'AMPLIFY'
      ? '~$0.002/hr'
      : '$0.000/hr (Scale-to-Zero Edge)';

  return [
    `### ⚡ DeployMate Ephemeral PR Preview (#${dep.prNumber})`,
    '',
    '| Status | Live Preview URL | Target Architecture | Commit | Est. Idle Cost |',
    '| :--- | :--- | :--- | :--- | :--- |',
    `| ${statusBadge} | ${urlCell} | \`${dep.cloudProvider}:${dep.target}\` | \`${(
      dep.commitSha || 'HEAD'
    ).slice(0, 7)}\` | ${hourlyCost} |`,
    '',
    '_Automatically updated on every push and torn down when this Pull Request is merged or closed._',
  ].join('\n');
}

export class GitHubWebhookService {
  /**
   * Attaches a listener so whenever a PR preview deployment updates status, its single PR bot comment
   * is updated in-place automatically (DM-908 AC1).
   */
  private bindPrCommentLiveUpdater(
    store: DeploymentStore,
    repoFullName: string,
    prNumber: number,
    deploymentId: string
  ): void {
    const syncComment = (dep: DeploymentRecord) => {
      const existing = store.getPrPreviewComment(repoFullName, prNumber);
      const now = new Date().toISOString();
      const comment = store.upsertPrPreviewComment({
        commentId:
          existing?.commentId || `prc_${crypto.randomBytes(5).toString('hex')}`,
        repoFullName,
        prNumber,
        deploymentId: dep.deploymentId,
        previewUrl: dep.status === 'LIVE' ? dep.url : null,
        status: dep.status,
        markdownBody: renderPrPreviewMarkdown(dep),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      });

      if (dep.prCommentId !== comment.commentId) {
        dep.prCommentId = comment.commentId;
      }

      if (
        dep.status === 'LIVE' ||
        dep.status === 'FAILED' ||
        dep.status === 'DELETED'
      ) {
        store.events.off(`deployment:${deploymentId}`, syncComment);
      }
    };

    const current = store.get(deploymentId);
    if (current) {
      syncComment(current);
    }
    store.events.on(`deployment:${deploymentId}`, syncComment);
  }

  public async processEvent(params: {
    event: string;
    deliveryId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: Record<string, any>;
    store?: DeploymentStore;
    manager?: DeploymentManager;
  }): Promise<{
    statusCode: number;
    body: Record<string, unknown>;
  }> {
    const store = params.store || deploymentStore;
    const manager = params.manager || deploymentManager;

    if (params.deliveryId) {
      const isNew = store.markWebhookDeliveryProcessed(params.deliveryId);
      if (!isNew) {
        return {
          statusCode: 200,
          body: {
            ok: true,
            deduplicated: true,
            deliveryId: params.deliveryId,
            message: 'Webhook delivery already processed (idempotent replay skip).',
          },
        };
      }
    }

    if (params.event === 'ping') {
      return {
        statusCode: 200,
        body: { ok: true, action: 'pong' },
      };
    }

    const repoFullName: string | undefined = params.payload?.repository?.full_name;
    const repoHtmlUrl: string | undefined =
      params.payload?.repository?.html_url ||
      (repoFullName ? `https://github.com/${repoFullName}` : undefined);

    if (!repoHtmlUrl || !repoFullName) {
      return {
        statusCode: 400,
        body: { error: 'Webhook payload missing repository.full_name / html_url.' },
      };
    }

    const matchingProjects = store.findProjectsByRepoUrl(repoHtmlUrl);
    const primaryProject = matchingProjects[0];
    const installationId = params.payload?.installation?.id
      ? String(params.payload.installation.id)
      : store.findGitHubInstallationForRepo(repoFullName, primaryProject?.orgId)
          ?.installationId;

    // ========================================================================
    // Event 1: GitHub Push -> Push-to-Deploy CI/CD (DM-907)
    // ========================================================================
    if (params.event === 'push') {
      if (params.payload?.deleted === true) {
        return {
          statusCode: 200,
          body: { ok: true, ignored: true, reason: 'Branch deletion event ignored.' },
        };
      }

      const rawRef = String(params.payload?.ref || 'refs/heads/main');
      const branch = rawRef.replace(/^refs\/heads\//, '');
      const commitSha = String(
        params.payload?.after || params.payload?.head_commit?.id || ''
      );
      const commitMessage = String(
        params.payload?.head_commit?.message || 'Push deployment'
      );
      const commitAuthor = String(
        params.payload?.head_commit?.author?.username ||
          params.payload?.pusher?.name ||
          'github-pusher'
      );

      const defaultBranch =
        primaryProject?.defaultBranch ||
        params.payload?.repository?.default_branch ||
        'main';
      const environment = branch === defaultBranch ? 'production' : 'preview';

      const deployRes = await manager.startDeployment({
        repoUrl: repoHtmlUrl,
        branch,
        orgId: primaryProject?.orgId,
        projectId: primaryProject?.projectId,
        cloudProvider: primaryProject?.cloudProvider || 'AWS',
        archetype: primaryProject?.defaultArchetype,
        tenancy: primaryProject?.defaultTenancy || 'DEPLOYMATE_MANAGED',
        environment,
        triggerSource: 'github_push',
        commitSha: commitSha || undefined,
        commitMessage,
        commitAuthor,
        githubInstallationId: installationId,
      });

      if (!deployRes.ok || !deployRes.deployment) {
        return {
          statusCode: deployRes.statusCode,
          body: { error: deployRes.error },
        };
      }

      return {
        statusCode: 202,
        body: {
          ok: true,
          event: 'push',
          environment,
          deploymentId: deployRes.deployment.deploymentId,
          status: deployRes.deployment.status,
          githubCheckStatus: deployRes.deployment.githubCheckStatus || 'pending',
        },
      };
    }

    // ========================================================================
    // Event 2: GitHub Pull Request -> Ephemeral PR Previews (DM-908)
    // ========================================================================
    if (params.event === 'pull_request') {
      const action = String(params.payload?.action || '');
      const prNumber = Number(
        params.payload?.number || params.payload?.pull_request?.number
      );
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        return {
          statusCode: 400,
          body: { error: 'Invalid pull_request number in webhook payload.' },
        };
      }

      const prHeadBranch = String(
        params.payload?.pull_request?.head?.ref || `pr-${prNumber}`
      );
      const prHeadSha = String(params.payload?.pull_request?.head?.sha || '');
      const prTitle = String(
        params.payload?.pull_request?.title || `PR #${prNumber}`
      );
      const prAuthor = String(
        params.payload?.pull_request?.user?.login || 'pr-author'
      );

      // Case A: PR Merged or Closed -> Auto-Destroy Preview Infrastructure (DM-908 AC2)
      if (action === 'closed') {
        const activePreview = store.findActivePreviewDeployment(repoHtmlUrl, prNumber);
        if (!activePreview) {
          return {
            statusCode: 200,
            body: {
              ok: true,
              action: 'closed',
              prNumber,
              cleanedUp: false,
              message: 'No active preview deployment found for this PR.',
            },
          };
        }

        const delRes = await manager.deleteDeployment(activePreview.deploymentId);
        if (delRes.deployment) {
          const existingComment = store.getPrPreviewComment(repoFullName, prNumber);
          const now = new Date().toISOString();
          store.upsertPrPreviewComment({
            commentId:
              existingComment?.commentId ||
              `prc_${crypto.randomBytes(5).toString('hex')}`,
            repoFullName,
            prNumber,
            deploymentId: delRes.deployment.deploymentId,
            previewUrl: null,
            status: 'DELETED',
            markdownBody: renderPrPreviewMarkdown(delRes.deployment),
            createdAt: existingComment?.createdAt || now,
            updatedAt: now,
          });
        }

        return {
          statusCode: 200,
          body: {
            ok: true,
            action: 'closed',
            prNumber,
            cleanedUp: true,
            deploymentId: activePreview.deploymentId,
            status: 'DELETED',
          },
        };
      }

      // Case B: PR Opened, Reopened, or Synchronize -> Create or Update Preview In-Place (DM-908 AC1)
      if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
        const slugSource =
          primaryProject?.slug || repoFullName.split('/')[1] || 'app';
        const previewSubdomain = buildPrPreviewSubdomain(prNumber, slugSource);
        const existingPreview = store.findActivePreviewDeployment(repoHtmlUrl, prNumber);

        if (existingPreview) {
          const updatedRes = await manager.redeployPreviewInPlace(
            existingPreview.deploymentId,
            {
              branch: prHeadBranch,
              commitSha: prHeadSha || undefined,
              commitMessage: prTitle,
              commitAuthor: prAuthor,
              githubInstallationId: installationId,
            }
          );

          if (!updatedRes.ok || !updatedRes.deployment) {
            return {
              statusCode: updatedRes.statusCode,
              body: { error: updatedRes.error },
            };
          }

          this.bindPrCommentLiveUpdater(
            store,
            repoFullName,
            prNumber,
            updatedRes.deployment.deploymentId
          );

          const comment = store.getPrPreviewComment(repoFullName, prNumber);
          return {
            statusCode: 202,
            body: {
              ok: true,
              action,
              inPlaceUpdate: true,
              prNumber,
              deploymentId: updatedRes.deployment.deploymentId,
              customHostname: updatedRes.deployment.customHostname,
              prCommentId: comment?.commentId,
            },
          };
        }

        const startRes = await manager.startDeployment({
          repoUrl: repoHtmlUrl,
          branch: prHeadBranch,
          subdomain: previewSubdomain,
          orgId: primaryProject?.orgId,
          projectId: primaryProject?.projectId,
          cloudProvider: primaryProject?.cloudProvider || 'AWS',
          archetype: primaryProject?.defaultArchetype,
          tenancy: primaryProject?.defaultTenancy || 'DEPLOYMATE_MANAGED',
          environment: 'preview',
          triggerSource: 'github_pr',
          prNumber,
          commitSha: prHeadSha || undefined,
          commitMessage: prTitle,
          commitAuthor: prAuthor,
          githubInstallationId: installationId,
        });

        if (!startRes.ok || !startRes.deployment) {
          return {
            statusCode: startRes.statusCode,
            body: { error: startRes.error },
          };
        }

        this.bindPrCommentLiveUpdater(
          store,
          repoFullName,
          prNumber,
          startRes.deployment.deploymentId
        );

        const comment = store.getPrPreviewComment(repoFullName, prNumber);
        return {
          statusCode: 202,
          body: {
            ok: true,
            action,
            inPlaceUpdate: false,
            prNumber,
            deploymentId: startRes.deployment.deploymentId,
            customHostname: startRes.deployment.customHostname,
            prCommentId: comment?.commentId,
          },
        };
      }

      return {
        statusCode: 200,
        body: { ok: true, ignored: true, action },
      };
    }

    return {
      statusCode: 200,
      body: { ok: true, ignored: true, event: params.event },
    };
  }
}

export const githubWebhookService = new GitHubWebhookService();
