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

async function runPhase1And2Tests(): Promise<void> {
  console.log('=== Repo2Cloud Phase 1 & Phase 2 Verification Suite ===\n');

  // Task 2: Validate GitHub URL
  console.log('1. Testing Phase 1 (GitHub URL validation)...');
  const validRepo = validateGitHubRepoUrl('https://github.com/example/vite-app');
  assert.strictEqual(validRepo.valid, true);
  assert.strictEqual(validRepo.data?.owner, 'example');
  assert.strictEqual(validRepo.data?.repo, 'vite-app');

  assert.strictEqual(validateGitHubRepoUrl('http://github.com/example/vite-app').valid, false);
  assert.strictEqual(validateGitHubRepoUrl('https://gitlab.com/example/vite-app').valid, false);
  console.log('   ✓ GitHub URL validation passed.');

  // Task 2 & 3: Inspect package.json & identify buildCommand and outputDirectory
  console.log('2. Testing Phase 1 (Inspect package.json -> buildCommand & outputDirectory)...');
  const analyzer = new RepositoryAnalyzer();
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
  console.log('   ✓ package.json inspection & build/output detection passed.');

  // Phase 2: Subdomain & Server-Controlled Base Domain Validation
  console.log('3. Testing Phase 2 (RFC-1123 subdomain & server-controlled domain validation)...');
  assert.strictEqual(validateSubdomain('my-app-2026').valid, true);
  assert.strictEqual(validateSubdomain('-bad-start').valid, false);
  assert.strictEqual(validateSubdomain('bad_underscore').valid, false);
  assert.strictEqual(validateSubdomain('api').valid, false, 'Reserved subdomain should be rejected');
  assert.strictEqual(validateSubdomain('a').valid, false, 'Too short subdomain should be rejected');

  assert.strictEqual(resolveServerControlledDomain('repo2cloud.dev').valid, true);
  assert.strictEqual(resolveServerControlledDomain('evil.com').valid, false);
  console.log('   ✓ RFC-1123 subdomain & server-controlled domain validation passed.');

  // Phase 1 & Phase 2 End-to-End Pipeline + Atomic Hostname Reservation (409 Conflict)
  console.log('4. Testing Phase 1 & Phase 2 Pipeline (Custom Subdomain + ACM + Route 53 + 409 Conflict)...');
  const tmpStoreFile = path.join(os.tmpdir(), `repo2cloud-phase2-test-${Date.now()}.json`);
  const store = new DeploymentStore(tmpStoreFile);
  const manager = new DeploymentManager(store);

  const startRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/vite-app',
    deploymentType: 'static',
    subdomain: 'technica-demo',
    domain: 'repo2cloud.dev',
  });
  assert.strictEqual(startRes.ok, true);
  assert.strictEqual(startRes.deployment?.status, 'BUILDING');
  assert.strictEqual(startRes.deployment?.customHostname, 'technica-demo.repo2cloud.dev');

  // Attempt duplicate subdomain deployment -> must return 409 Conflict immediately
  const duplicateRes = await manager.startDeployment({
    repoUrl: 'https://github.com/example/other-app',
    deploymentType: 'static',
    subdomain: 'technica-demo',
    domain: 'repo2cloud.dev',
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
  assert.strictEqual(completed.url, 'https://technica-demo.repo2cloud.dev');
  assert.ok(completed.infrastructureUrl?.endsWith('.cloudfront.net'));
  assert.ok(completed.resources.acmCertificateArn, 'Expected ACM certificate ARN in resources');
  assert.strictEqual(completed.resources.route53RecordName, 'technica-demo.repo2cloud.dev', 'Expected Route 53 Alias record in resources');

  // Test teardown releases the custom hostname reservation
  const delRes = await manager.deleteDeployment(depId);
  assert.strictEqual(delRes.ok, true);
  assert.strictEqual(store.isHostnameAvailable('technica-demo.repo2cloud.dev'), true, 'Hostname must be released after delete');

  if (fs.existsSync(tmpStoreFile)) {
    fs.unlinkSync(tmpStoreFile);
  }
  console.log(`   ✓ End-to-end Phase 2 custom domain deployment & teardown verified (${completed.url}).\n`);
  console.log('ALL PHASE 1 & PHASE 2 TESTS PASSED!');
}

runPhase1And2Tests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
