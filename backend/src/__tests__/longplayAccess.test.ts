import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentAccessError, requireDeploymentAccess } from '../services/longplayAccess';
import { createDeployRouter } from '../routes/deployRoutes';

const feature = '11111111-1111-4111-8111-111111111111';
const customer = '22222222-2222-4222-8222-222222222222';
const env = { LONGPLAY_DEPLOY_FEATURE_ID: feature, LONGPLAY_BASE_URL: 'https://billing.invalid',
  LONGPLAY_APP_ID: 'app', LONGPLAY_SECRET_KEY: 'gg_sk_' + 'x'.repeat(43), LONGPLAY_ENVIRONMENT: 'sandbox' };
function transport(allowed = true, kind = 'access', projectId = 'app'): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const body = JSON.parse(options?.body as string);
    const result: Record<string, unknown> = { requestId: customer, scope: { projectId, environment: 'sandbox' } };
    assert.equal(options?.redirect, 'error');
    if (String(url).endsWith('/customers')) {
      assert.deepEqual(body, { externalUserId: 'deploymate:org:verified-org' });
      result.customer = { id: customer };
    } else {
      assert.deepEqual(body, { customerId: customer, requirement: { internal_feature_id: feature, quantity: '1', properties: {} } });
      result.check = { internal_feature_id: feature, kind, allowed };
    }
    return new Response(JSON.stringify(result), { headers: { 'X-Indiana-Protocol': '0.10' } });
  }) as typeof fetch;
}
test('disabled deployments make no requests and enabled deployments require verified organization identity', async () => {
  const noNetwork = async () => { throw new Error('must not request'); };
  await requireDeploymentAccess(undefined, {}, noNetwork);
  await assert.rejects(requireDeploymentAccess(undefined, env, noNetwork), { status: 401 });
});
test('protocol requests bind only the verified organization; revocation is fresh', async () => {
  await requireDeploymentAccess('verified-org', env, transport());
  await assert.rejects(requireDeploymentAccess('verified-org', env, transport(false)), { status: 402 });
});
test('foreign scope, unsupported Feature and service failures never grant admission', async () => {
  await assert.rejects(requireDeploymentAccess('verified-org', env, transport(true, 'access', 'foreign')), { status: 503 });
  await assert.rejects(requireDeploymentAccess('verified-org', env, transport(true, 'credit')), { status: 503 });
  await assert.rejects(requireDeploymentAccess('verified-org', env, async () => { throw new Error('PRIVATE'); }), { message: 'Could not verify deployment access.' });
});
test('incomplete configuration makes no provider request', async () => {
  await assert.rejects(requireDeploymentAccess('verified-org', { LONGPLAY_DEPLOY_FEATURE_ID: feature }, async () => { throw new Error('must not request'); }), { status: 503 });
});
for (const path of ['/deploy', '/deploy/:id/retry']) {
  test(`actual ${path} refuses admission before manager work and ignores a body organization`, async () => {
    let started = false;
    const router = createDeployRouter({ loadFromS3: async () => {} } as never,
      { startDeployment: () => { started = true; }, retryDeployment: () => { started = true; } } as never,
      {} as never, async org => { assert.equal(org, undefined); throw new DeploymentAccessError(401, 'AUTH_REQUIRED', 'Sign in'); });
    const layer = router.stack.find(item => item.route?.path === path);
    assert.ok(layer?.route);
    let status = 0;
    const response = { status(code: number) { status = code; return this; }, json(value: unknown) { return value; } };
    await layer.route.stack[0].handle({ body: { orgId: 'attacker-selected' }, params: { id: 'd' }, ip: 'unit-test' } as never, response as never, () => { throw new Error('Unexpected next middleware'); });
    assert.equal(status, 401);
    assert.equal(started, false);
  });
}
