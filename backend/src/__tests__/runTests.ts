// Force dry-run in automated unit tests so we don't provision real AWS buckets on test runs
process.env.FORCE_DRY_RUN_TEST = 'true';

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeploymentManager } from '../services/deploymentManager';
import { RepositoryAnalyzer } from '../services/repositoryAnalyzer';
import { DeploymentStore } from '../store/deploymentStore';
import { resolveServerControlledDomain, validateGitHubRepoUrl, validateSubdomain } from '../utils/validation';

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

  if (fs.existsSync(tmpStoreFile)) {
    fs.unlinkSync(tmpStoreFile);
  }
  console.log(`   ✓ End-to-end Phase 5 Lambda + API Gateway deployment & teardown verified (${lambdaCompleted.url}).\n`);
  console.log('ALL PHASE 1, PHASE 2, PHASE 3, PHASE 4 & PHASE 5 TESTS PASSED!');
}

runPhase1To3Tests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
