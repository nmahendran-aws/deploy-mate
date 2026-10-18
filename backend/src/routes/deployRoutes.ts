import { Request, Response, Router } from 'express';
import { deploymentManager } from '../services/deploymentManager';
import { repositoryAnalyzer } from '../services/repositoryAnalyzer';
import { securityGuardrails } from '../services/securityGuardrails';
import { deploymentStore } from '../store/deploymentStore';
import {
  getConfiguredDomains,
  resolveServerControlledDomain,
  validateGitHubRepoUrl,
  validateSubdomain,
} from '../utils/validation';

export const deployRouter = Router();

/**
 * GET /api/security/status
 * Phase 7: Returns active build isolation flags, command/path guardrail status,
 * concurrent build usage, and AWS active deployment cost caps.
 */
deployRouter.get('/security/status', (_req: Request, res: Response) => {
  return res.json(securityGuardrails.getStatus(deploymentStore));
});

/**
 * POST /api/analyze
 * Phase 3: Pre-deployment repository inspection & multi-target recommendation engine.
 */
deployRouter.post('/analyze', async (req: Request, res: Response) => {
  const rateCheck = securityGuardrails.checkRateLimit(req.ip || 'analyze-client');
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.error });
  }

  const { repoUrl, branch } = req.body || {};
  const repoCheck = validateGitHubRepoUrl(repoUrl);
  if (!repoCheck.valid || !repoCheck.data) {
    return res.status(400).json({
      error: repoCheck.error || 'Invalid GitHub repository URL.',
    });
  }

  const effectiveBranch =
    typeof branch === 'string' && branch.trim()
      ? branch.trim()
      : repoCheck.data.branch || 'main';

  const analysis = await repositoryAnalyzer.analyzeRemoteGitHubRepo(
    repoCheck.data.owner,
    repoCheck.data.repo,
    effectiveBranch
  );

  return res.json({
    repoUrl: repoCheck.data.normalizedUrl,
    owner: repoCheck.data.owner,
    repo: repoCheck.data.repo,
    branch: effectiveBranch,
    analysis,
  });
});

/**
 * GET /api/domains
 * Phase 2: Returns the server-controlled domain list and optionally checks
 * whether a requested subdomain is valid and available in the reservation store.
 */
deployRouter.get('/domains', (req: Request, res: Response) => {
  const configured = getConfiguredDomains().map((d) => ({
    domain: d.domain,
    hasWildcardCert: Boolean(d.acmCertificateArn),
  }));

  const rawSubdomain = req.query.subdomain;
  const rawDomain = req.query.domain;

  if (typeof rawSubdomain === 'string' && rawSubdomain.trim()) {
    const subCheck = validateSubdomain(rawSubdomain);
    const domCheck = resolveServerControlledDomain(rawDomain);

    if (!subCheck.valid) {
      return res.json({
        domains: configured,
        subdomainCheck: {
          valid: false,
          available: false,
          error: subCheck.error,
        },
      });
    }

    if (!domCheck.valid || !domCheck.domainConfig) {
      return res.json({
        domains: configured,
        subdomainCheck: {
          valid: false,
          available: false,
          error: domCheck.error,
        },
      });
    }

    const customHostname = `${subCheck.subdomain}.${domCheck.domainConfig.domain}`;
    const available = deploymentStore.isHostnameAvailable(customHostname);

    return res.json({
      domains: configured,
      subdomainCheck: {
        valid: true,
        available,
        customHostname,
        error: available
          ? undefined
          : `Hostname "${customHostname}" is already reserved by an active deployment.`,
      },
    });
  }

  return res.json({ domains: configured });
});

/**
 * POST /api/deploy
 * Phases 1–7 API Contract
 */
deployRouter.post('/deploy', async (req: Request, res: Response) => {
  const rateCheck = securityGuardrails.checkRateLimit(req.ip || 'deploy-client');
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.error });
  }

  const result = await deploymentManager.startDeployment(req.body || {});
  if (!result.ok || !result.deployment) {
    return res.status(result.statusCode).json({
      error: result.error,
    });
  }

  const dep = result.deployment;
  return res.status(result.statusCode).json({
    deploymentId: dep.deploymentId,
    status: dep.status,
    target: dep.target,
    url: dep.url, // Always null until deployment and HTTPS checks pass
    customHostname: dep.customHostname || null,
    deployment: dep,
  });
});

/**
 * GET /api/deploy/:id
 * Polls deployment status and only populates `url` after the deployment is reachable over HTTPS.
 */
deployRouter.get('/deploy/:id', (req: Request, res: Response) => {
  const record = deploymentStore.get(req.params.id);
  if (!record) {
    return res.status(404).json({
      error: `Deployment "${req.params.id}" not found.`,
    });
  }

  return res.json({
    deploymentId: record.deploymentId,
    status: record.status,
    target: record.target,
    url: record.status === 'LIVE' ? record.url : null,
    customHostname: record.customHostname || null,
    deployment: record,
  });
});

/**
 * GET /api/deployments
 */
deployRouter.get('/deployments', (_req: Request, res: Response) => {
  const deployments = deploymentStore.listAll();
  return res.json({ deployments });
});

/**
 * DELETE /api/deploy/:id
 * Deletes all provisioned AWS resources across S3/CloudFront, ECS/ECR, Lambda/API GW, or Amplify,
 * and releases the reserved Route 53 subdomain.
 */
deployRouter.delete('/deploy/:id', async (req: Request, res: Response) => {
  const result = await deploymentManager.deleteDeployment(req.params.id);
  if (!result.ok || !result.deployment) {
    return res.status(result.statusCode).json({ error: result.error });
  }
  return res.status(result.statusCode).json({
    deploymentId: result.deployment.deploymentId,
    status: result.deployment.status,
    deployment: result.deployment,
  });
});
