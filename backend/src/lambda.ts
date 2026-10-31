import serverless from 'serverless-http';
import { app } from './server';
import { deploymentManager } from './services/deploymentManager';
import { deploymentStore } from './store/deploymentStore';
import { resolveServerControlledDomain } from './utils/validation';

const httpHandler = serverless(app);

export const handler = async (event: any, context: any) => {
  // If invoked directly by async self-invocation for background deployment
  if (event && event.action === 'PROCESS_DEPLOYMENT') {
    const payload = event.payload || event;
    const deploymentId = payload.deploymentId;
    try {
      await deploymentStore.loadFromS3();
      const record = deploymentStore.get(deploymentId);
      if (!record) {
        console.error(`[Lambda Worker] Deployment ${deploymentId} not found in store.`);
        return { statusCode: 404, body: `Deployment ${deploymentId} not found.` };
      }

      const cloneUrl = payload.cloneUrl || record.repoUrl;
      let domainConfig = payload.domainConfig;
      if (!domainConfig && record.domain) {
        const domCheck = resolveServerControlledDomain(record.domain);
        if (domCheck.valid && domCheck.domainConfig) {
          domainConfig = domCheck.domainConfig;
        }
      }
      const userEnvVars = payload.userEnvVars || {};
      const ephemeralGitHubToken = payload.ephemeralGitHubToken;

      if (record.status === 'FAILED' || record.status === 'DEPLOYING') {
        deploymentStore.update(deploymentId, {
          status: 'BUILDING',
          error: null,
        });
      }

      console.log(`[Lambda Worker] Processing background deployment ${deploymentId} (${record.customHostname || record.repoName})...`);
      await deploymentManager.executePipeline(
        deploymentId,
        cloneUrl,
        domainConfig,
        userEnvVars,
        ephemeralGitHubToken
      );
      await deploymentStore.syncToS3();
      return { statusCode: 200, body: JSON.stringify({ ok: true, deploymentId }) };
    } catch (err: unknown) {
      console.error(`[Lambda Worker] Error processing deployment ${deploymentId}:`, err);
      await deploymentStore.syncToS3();
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      };
    }
  }

  return httpHandler(event, context);
};
