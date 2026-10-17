import cors from 'cors';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { deployRouter } from './routes/deployRoutes';
import { deploymentManager } from './services/deploymentManager';
import { getConfiguredDomains } from './utils/validation';

const rootEnvPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: rootEnvPath, override: true });
dotenv.config({ override: true });

export const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  })
);
app.use(express.json({ limit: '64kb' }));

// Phase 7: Lightweight per-IP rate limiting middleware for abuse prevention
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const maxReqs = Number(process.env.RATE_LIMIT_MAX_REQUESTS_PER_WINDOW || 60);

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
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

app.get('/api/health', (_req: Request, res: Response) => {
  dotenv.config({ path: rootEnvPath, override: true });
  dotenv.config({ override: true });
  res.json({
    service: 'repo2cloud-backend',
    status: 'ok',
    dryRun: deploymentManager.isDryRunMode(),
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    configuredDomains: getConfiguredDomains().map((d) => d.domain),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api', deployRouter);

const PORT = Number(process.env.PORT || 4000);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `[Repo2Cloud API] Listening on http://localhost:${PORT} (dryRun=${deploymentManager.isDryRunMode()})`
    );
  });
}
