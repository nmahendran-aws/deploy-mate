// Import-free HTTP adapter: keep this backend's existing CommonJS module contract.
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export class DeploymentAccessError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function requireDeploymentAccess(
  verifiedOrgId: string | undefined,
  env: Record<string, string | undefined> = process.env,
  send: typeof fetch = fetch
): Promise<void> {
  if (!env.LONGPLAY_DEPLOY_FEATURE_ID) return;
  if (!verifiedOrgId) throw new DeploymentAccessError(401, 'AUTH_REQUIRED', 'Sign in to deploy.');
  let allowed: boolean;
  try {
    const base = new URL(env.LONGPLAY_BASE_URL || '');
    if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !env.LONGPLAY_APP_ID || !/^gg_sk_[A-Za-z0-9_-]{32,128}$/.test(env.LONGPLAY_SECRET_KEY || '') ||
      !['sandbox', 'live'].includes(env.LONGPLAY_ENVIRONMENT || '') || !uuid.test(env.LONGPLAY_DEPLOY_FEATURE_ID)) throw new Error('Configuration');
    async function post(path: string, input: unknown) {
      const response = await send(new URL('/api/v1/' + path, base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LONGPLAY_SECRET_KEY}`,
          'X-Indiana-Protocol': '0.10', 'X-Indiana-Project': env.LONGPLAY_APP_ID!, 'X-Indiana-Environment': env.LONGPLAY_ENVIRONMENT! },
        body: JSON.stringify(input),
      });
      if (!response.ok || response.headers.get('X-Indiana-Protocol') !== '0.10') throw new Error('Unavailable');
      const data = await response.json() as { requestId: string; scope: {projectId: string; environment: string}; customer?: {id: string}; check?: {kind: string; allowed: boolean; internal_feature_id: string} };
      if (!uuid.test(data.requestId) || data.scope?.projectId !== env.LONGPLAY_APP_ID || data.scope?.environment !== env.LONGPLAY_ENVIRONMENT) throw new Error('Scope mismatch');
      return data;
    }
    const customer = await post('customers', { externalUserId: `deploymate:org:${verifiedOrgId}` });
    if (!customer.customer || !uuid.test(customer.customer.id)) throw new Error('Customer response');
    const result = await post('entitlements/check', { customerId: customer.customer.id, requirement: {
      internal_feature_id: env.LONGPLAY_DEPLOY_FEATURE_ID, quantity: '1', properties: {},
    } });
    if (result.check?.kind !== 'access' || result.check.internal_feature_id !== env.LONGPLAY_DEPLOY_FEATURE_ID || typeof result.check.allowed !== 'boolean') throw new Error('Access Feature required');
    allowed = result.check.allowed;
  } catch {
    throw new DeploymentAccessError(503, 'BILLING_UNAVAILABLE', 'Could not verify deployment access.');
  }
  if (!allowed) throw new DeploymentAccessError(402, 'PLAN_REQUIRED', 'This workspace plan does not include deployment.');
}
