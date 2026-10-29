import { EventEmitter } from 'events';
import { ConfiguredDomain } from '../types/deployment';

export interface DeploymentQueuePayload {
  deploymentId: string;
  cloneUrl: string;
  domainConfig?: ConfiguredDomain;
  userEnvVars?: Record<string, string>;
  ephemeralGitHubToken?: string;
}

export type WorkerJobProcessor = (payload: DeploymentQueuePayload) => Promise<void>;
export type WorkerTimeoutHandler = (
  payload: DeploymentQueuePayload,
  timeoutMs: number
) => Promise<void> | void;

export interface QueuedJobEntry {
  payload: DeploymentQueuePayload;
  enqueuedAt: string;
  processor: WorkerJobProcessor;
  onStartBuilding?: (deploymentId: string) => void;
  onQueuePositionChanged?: (deploymentId: string, position: number) => void;
  onTimeout?: WorkerTimeoutHandler;
}

export interface QueueStatusSnapshot {
  backend: 'redis-bullmq-ready' | 'bounded-worker-queue';
  maxConcurrency: number;
  activeWorkers: number;
  queuedJobs: number;
  jobTimeoutMs: number;
  queuedDeploymentIds: string[];
}

/**
 * DM-903 (#3): Durable Asynchronous Deployment Worker Queue.
 * Decouples deployment execution from Express request threads, enforces bounded worker
 * concurrency with FIFO queueing + live queuePosition tracking, and runs a stalled/hung
 * build timeout watchdog (`WORKER_TIMEOUT` / `BUILD_TIMEOUT`) that guarantees slot release.
 */
export class DeploymentJobQueue {
  private maxConcurrency: number;
  private jobTimeoutMs: number;
  private readonly maxQueueBacklog: number;
  private readonly activeJobs: Map<string, { startedAt: number; timer: NodeJS.Timeout }> =
    new Map();
  private readonly pendingQueue: QueuedJobEntry[] = [];
  public readonly events: EventEmitter = new EventEmitter();

  constructor(options?: {
    maxConcurrency?: number;
    jobTimeoutMs?: number;
    maxQueueBacklog?: number;
  }) {
    this.maxConcurrency =
      options?.maxConcurrency ??
      Math.max(1, Number(process.env.MAX_CONCURRENT_DEPLOYMENTS || 5));
    this.jobTimeoutMs =
      options?.jobTimeoutMs ??
      Math.max(500, Number(process.env.MAX_DEPLOYMENT_DURATION_MS || 600_000));
    this.maxQueueBacklog =
      options?.maxQueueBacklog ??
      Math.max(10, Number(process.env.MAX_DEPLOYMENT_QUEUE_BACKLOG || 100));
    this.events.setMaxListeners(100);
  }

  public configure(options: { maxConcurrency?: number; jobTimeoutMs?: number }): void {
    if (options.maxConcurrency !== undefined && options.maxConcurrency >= 1) {
      this.maxConcurrency = options.maxConcurrency;
    }
    if (options.jobTimeoutMs !== undefined && options.jobTimeoutMs >= 50) {
      this.jobTimeoutMs = options.jobTimeoutMs;
    }
    this.drain();
  }

  public getSnapshot(): QueueStatusSnapshot {
    return {
      backend: process.env.REDIS_URL ? 'redis-bullmq-ready' : 'bounded-worker-queue',
      maxConcurrency: this.maxConcurrency,
      activeWorkers: this.activeJobs.size,
      queuedJobs: this.pendingQueue.length,
      jobTimeoutMs: this.jobTimeoutMs,
      queuedDeploymentIds: this.pendingQueue.map((j) => j.payload.deploymentId),
    };
  }

  public canAcceptMore(): boolean {
    return this.pendingQueue.length < this.maxQueueBacklog;
  }

  /**
   * Enqueues a deployment job.
   * - If a worker slot is immediately available, starts execution right away (`startedImmediately = true`).
   * - Otherwise places the job in the FIFO queue and returns its 1-based `queuePosition`.
   */
  public enqueue(entry: Omit<QueuedJobEntry, 'enqueuedAt'>): {
    startedImmediately: boolean;
    queuePosition: number | null;
  } {
    const fullEntry: QueuedJobEntry = {
      ...entry,
      enqueuedAt: new Date().toISOString(),
    };

    if (this.activeJobs.size < this.maxConcurrency) {
      this.startWorkerJob(fullEntry);
      return { startedImmediately: true, queuePosition: null };
    }

    this.pendingQueue.push(fullEntry);
    const position = this.pendingQueue.length;
    fullEntry.onQueuePositionChanged?.(fullEntry.payload.deploymentId, position);
    this.events.emit('job:queued', {
      deploymentId: fullEntry.payload.deploymentId,
      queuePosition: position,
    });

    return { startedImmediately: false, queuePosition: position };
  }

  private startWorkerJob(entry: QueuedJobEntry): void {
    const { deploymentId } = entry.payload;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      this.activeJobs.delete(deploymentId);
      Promise.resolve(entry.onTimeout?.(entry.payload, this.jobTimeoutMs))
        .catch(() => {})
        .finally(() => {
          this.events.emit('job:timeout', {
            deploymentId,
            timeoutMs: this.jobTimeoutMs,
          });
          this.drain();
        });
    }, this.jobTimeoutMs);

    // Allow Node test runner process to exit cleanly if idle
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.activeJobs.set(deploymentId, { startedAt: Date.now(), timer });
    entry.onStartBuilding?.(deploymentId);
    this.events.emit('job:started', { deploymentId });

    void Promise.resolve()
      .then(() => entry.processor(entry.payload))
      .catch(() => {
        // Processor handles domain error logging internally
      })
      .finally(() => {
        if (!timedOut) {
          clearTimeout(timer);
          this.activeJobs.delete(deploymentId);
          this.events.emit('job:completed', { deploymentId });
          this.drain();
        }
      });
  }

  private drain(): void {
    while (this.activeJobs.size < this.maxConcurrency && this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift()!;
      this.startWorkerJob(next);
    }

    // Broadcast updated 1-based queue positions to remaining queued jobs
    this.pendingQueue.forEach((queued, idx) => {
      queued.onQueuePositionChanged?.(queued.payload.deploymentId, idx + 1);
    });
  }
}

export const deploymentJobQueue = new DeploymentJobQueue();
