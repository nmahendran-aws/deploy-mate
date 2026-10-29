import cors from 'cors';
import dotenv from 'dotenv';
import express, { Express, NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createAuthMiddlewares } from './middleware/authMiddleware';
import { createAuthAndOrgRouter } from './routes/authAndOrgRoutes';
import { createDeployRouter } from './routes/deployRoutes';
import { DeploymentJobQueue, deploymentJobQueue } from './services/deploymentJobQueue';
import { DeploymentManager, deploymentManager } from './services/deploymentManager';
import { DeploymentStore, deploymentStore } from './store/deploymentStore';
import { getConfiguredDomains } from './utils/validation';

const rootEnvPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: rootEnvPath, override: true });
dotenv.config({ override: true });

export function createApp(
  store: DeploymentStore = deploymentStore,
  manager: DeploymentManager = deploymentManager,
  queue: DeploymentJobQueue = deploymentJobQueue
): Express {
  const instance = express();

  instance.use(
    cors({
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id'],
      credentials: true,
    })
  );
  instance.use(express.json({ limit: '64kb' }));

  // Phase 7: Lightweight per-IP rate limiting middleware for abuse prevention
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
  const maxReqs = Number(process.env.RATE_LIMIT_MAX_REQUESTS_PER_WINDOW || 60);

  instance.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // Exempt read-only status polling from strict write rate-limits
    if (req.method === 'GET') {
      return next();
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'local';
    const now = Date.now();
    const entry = requestCounts.get(clientIp);

    if (!entry || now > entry.resetAt) {
      requestCounts.set(clientIp, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxReqs) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Please wait before submitting additional deployment requests.',
      });
    }

    entry.count += 1;
    return next();
  });

  instance.get('/api/health', (_req: Request, res: Response) => {
    if (process.env.FORCE_DRY_RUN_TEST !== 'true') {
      dotenv.config({ path: rootEnvPath, override: true });
      dotenv.config({ override: true });
    }
    res.json({
      service: 'deploymate-backend',
      status: 'ok',
      dryRun: manager.isDryRunMode(),
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      supportedProviders: ['AWS', 'GCP', 'AZURE'],
      configuredDomains: getConfiguredDomains().map((d) => d.domain),
      queue: queue.getSnapshot(),
      timestamp: new Date().toISOString(),
    });
  });

  const { attachAuthIfPresent } = createAuthMiddlewares(store);
  instance.use('/api', attachAuthIfPresent);
  instance.use('/api', createAuthAndOrgRouter(store));
  instance.use('/api', createDeployRouter(store, manager, queue));

  // Serve Next.js static export frontend from /frontend/out when available
  const frontendOutDir = path.resolve(__dirname, '../../frontend/out');
  if (fs.existsSync(frontendOutDir)) {
    instance.use(express.static(frontendOutDir));
    instance.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(path.join(frontendOutDir, 'index.html'));
    });
  }

  return instance;
}

export const app = createApp();

const PORT = Number(process.env.PORT || 4000);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `[DeployMate API] Listening on http://localhost:${PORT} (dryRun=${deploymentManager.isDryRunMode()})`
    );
  });
}
