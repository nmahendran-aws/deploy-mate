import serverless from 'serverless-http';
import { app } from './server';
import { deploymentManager } from './services/deploymentManager';

const httpHandler = serverless(app);

export const handler = async (event: any, context: any) => {
  // If invoked directly by async self-invocation for background deployment
  if (event && event.action === 'PROCESS_DEPLOYMENT' && event.payload) {
    const { deploymentId, cloneUrl, domainConfig, userEnvVars, ephemeralGitHubToken } =
      event.payload;
    try {
      await deploymentManager.executePipeline(
        deploymentId,
        cloneUrl,
        domainConfig,
        userEnvVars,
        ephemeralGitHubToken
      );
      return { statusCode: 200, body: JSON.stringify({ ok: true, deploymentId }) };
    } catch (err: unknown) {
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
