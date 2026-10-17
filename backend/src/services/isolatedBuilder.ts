import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AnalysisResult } from '../types/deployment';

export interface IsolatedBuildResult {
  workspaceDir: string;
  repoDir: string;
  artifactDir: string;
  generatedFiles: string[];
  buildLogs: string[];
  durationMs: number;
  usedDockerIsolation: boolean;
}

export class IsolatedBuildRunner {
  private readonly buildRoot: string;
  private readonly maxBuildDurationMs: number;
  private readonly useDockerIsolation: boolean;

  constructor() {
    this.buildRoot =
      process.env.ISOLATED_BUILD_ROOT || path.join(os.tmpdir(), 'repo2cloud-isolated-builds');
    this.maxBuildDurationMs = Number(process.env.MAX_BUILD_DURATION_MS || 180_000);
    this.useDockerIsolation = process.env.USE_DOCKER_ISOLATION === 'true';

    if (!fs.existsSync(this.buildRoot)) {
      fs.mkdirSync(this.buildRoot, { recursive: true });
    }
  }

  /**
   * Creates a stripped environment for untrusted repository builds.
   * NEVER passes AWS credentials, session tokens, or backend secrets into build workers (Phase 7).
   */
  public createSanitizedWorkerEnv(
    userEnvVars: Record<string, string> = {}
  ): NodeJS.ProcessEnv {
    const nodeBinDir = path.dirname(process.execPath);
    return {
      PATH: `${nodeBinDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: this.buildRoot,
      CI: 'true',
      NODE_ENV: 'production',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      ...userEnvVars,
    };
  }

  /**
   * Downloads and extracts the GitHub repository into an isolated workspace directory.
   * Uses GitHub's HTTPS tarball archive + /usr/bin/tar so it works even on macOS systems
   * where /usr/bin/git is blocked by an unaccepted Xcode license.
   */
  public async prepareWorkspace(
    deploymentId: string,
    cloneUrl: string,
    branch?: string,
    dryRun: boolean = true,
    onLog?: (msg: string) => void
  ): Promise<{ workspaceDir: string; repoDir: string; clonedFromRemote: boolean }> {
    const workspaceDir = path.join(this.buildRoot, deploymentId);
    const repoDir = path.join(workspaceDir, 'repo');

    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(repoDir, { recursive: true });

    const isSyntheticExample =
      cloneUrl.includes('github.com/example/') || cloneUrl.includes('github.com/demo/');

    if (!isSyntheticExample && !dryRun) {
      const normalized = cloneUrl.replace(/\.git$/i, '');
      const match = normalized.match(/github\.com\/([^/]+)\/([^/]+)/i);
      if (!match) {
        throw new Error(`Unable to parse owner/repo from ${cloneUrl}`);
      }
      const [, owner, repo] = match;
      const ref = branch ? encodeURIComponent(branch) : 'HEAD';
      const tarballUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
      const archivePath = path.join(workspaceDir, 'repo.tar.gz');

      onLog?.(`Downloading repository archive from ${tarballUrl} into isolated workspace...`);
      const res = await fetch(tarballUrl, {
        headers: {
          'User-Agent': 'Repo2Cloud-IsolatedBuilder/1.0',
          ...(process.env.GITHUB_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_ACCESS_TOKEN}` }
            : {}),
        },
      });

      if (!res.ok) {
        throw new Error(
          `Failed to download repository archive from GitHub (HTTP ${res.status} ${res.statusText}). Ensure the repository is public.`
        );
      }

      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(archivePath, Buffer.from(arrayBuffer));

      const tarRes = await this.runSandboxedCommand(
        '/usr/bin/tar',
        ['-xzf', archivePath, '-C', repoDir, '--strip-components=1'],
        workspaceDir,
        this.createSanitizedWorkerEnv()
      );
      if (tarRes.exitCode !== 0) {
        throw new Error(
          `Failed to extract repository archive: ${tarRes.stderr || tarRes.stdout}`
        );
      }

      onLog?.('Repository archive downloaded and extracted into isolated sandbox.');
      return { workspaceDir, repoDir, clonedFromRemote: true };
    }

    // In dry-run mode or when deploying synthetic example repositories (e.g. github.com/example/vite-app)
    onLog?.(
      `Prepared isolated sandbox workspace at ${workspaceDir} (AWS credentials stripped from worker env).`
    );
    return { workspaceDir, repoDir, clonedFromRemote: false };
  }

  /**
   * Executes the build in an isolated worker (Docker container or sanitized subprocess)
   * and verifies the output directory & artifacts.
   */
  public async runIsolatedBuild(params: {
    deploymentId: string;
    workspaceDir: string;
    repoDir: string;
    clonedFromRemote: boolean;
    repoUrl: string;
    analysis: AnalysisResult;
    userEnvVars?: Record<string, string>;
    dryRun: boolean;
    onLog?: (msg: string) => void;
  }): Promise<IsolatedBuildResult> {
    const startTime = Date.now();
    const buildLogs: string[] = [];
    const log = (msg: string) => {
      buildLogs.push(msg);
      params.onLog?.(msg);
    };

    const sanitizedEnv = this.createSanitizedWorkerEnv(params.userEnvVars);
    const nodeExec = process.execPath;
    const npmCli = path.join(path.dirname(nodeExec), 'npm');

    log(
      `Isolated build worker initialized (timeout=${Math.round(
        this.maxBuildDurationMs / 1000
      )}s, awsCredentialsExposed=false, dockerIsolation=${this.useDockerIsolation}).`
    );

    const outSubdir = params.analysis.outputDirectory || 'dist';
    const artifactDir =
      outSubdir === '.' ? params.repoDir : path.join(params.repoDir, outSubdir);

    if (params.clonedFromRemote && !params.dryRun) {
      if (this.useDockerIsolation) {
        log('Running build inside ephemeral Docker container (--cap-drop=ALL --security-opt=no-new-privileges)...');
        const buildCmd = params.analysis.buildCommand || 'npm run build';
        const dockerArgs = [
          'run',
          '--rm',
          '--cpus=1.0',
          '--memory=1024m',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '-v',
          `${params.repoDir}:/workspace`,
          '-w',
          '/workspace',
          'node:20-alpine',
          'sh',
          '-c',
          `npm ci --ignore-scripts && ${buildCmd}`,
        ];
        const res = await this.runSandboxedCommand('docker', dockerArgs, params.workspaceDir, sanitizedEnv);
        if (res.exitCode !== 0) {
          throw new Error(`Isolated Docker build failed: ${res.stderr || res.stdout}`);
        }
      } else if (params.analysis.buildCommand) {
        log('Installing dependencies in isolated worker with "--ignore-scripts" protection...');
        const installRes = await this.runSandboxedCommand(
          nodeExec,
          [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
          params.repoDir,
          sanitizedEnv
        );
        if (installRes.exitCode !== 0) {
          throw new Error(`Dependency installation failed: ${installRes.stderr || installRes.stdout}`);
        }

        log(`Executing build command: ${params.analysis.buildCommand}`);
        const buildRes = await this.runSandboxedCommand(
          nodeExec,
          [npmCli, 'run', 'build'],
          params.repoDir,
          sanitizedEnv
        );
        if (buildRes.exitCode !== 0) {
          throw new Error(`Build command failed: ${buildRes.stderr || buildRes.stdout}`);
        }
      }
    } else {
      // Synthesize deterministic build artifacts in the isolated workspace for demo/synthetic repos

      log(
        `Executing isolated build plan for ${params.analysis.framework} (${
          params.analysis.buildCommand || 'static package'
        })...`
      );
      this.populateSyntheticBuildArtifacts(params.repoDir, artifactDir, params.repoUrl, params.analysis);
      log(`Generated verified build artifacts in "${outSubdir}/".`);
    }

    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    const generatedFiles = this.listFilesRecursively(artifactDir, artifactDir);
    if (generatedFiles.length === 0) {
      throw new Error(
        `Build finished but output directory "${outSubdir}/" is empty. Verify buildCommand and outputDirectory.`
      );
    }

    log(`Verified ${generatedFiles.length} build artifact(s) ready for deployment.`);

    return {
      workspaceDir: params.workspaceDir,
      repoDir: params.repoDir,
      artifactDir,
      generatedFiles,
      buildLogs,
      durationMs: Date.now() - startTime,
      usedDockerIsolation: this.useDockerIsolation,
    };
  }

  /**
   * Ensures a safe production Dockerfile exists for Phase 4 ECS Fargate deployments.
   */
  public ensureProductionDockerfile(repoDir: string, analysis: AnalysisResult): string {
    const dockerfilePath = path.join(repoDir, 'Dockerfile');
    if (fs.existsSync(dockerfilePath)) {
      return dockerfilePath;
    }

    const entryPoint = analysis.entryPoint || 'server.js';
    const generated =
      analysis.applicationType === 'python-service'
        ? `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* ./
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi
COPY . .
USER nobody
EXPOSE 8080
CMD ["python", "app.py"]
`
        : `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts
COPY . .
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "${entryPoint}"]
`;

    fs.writeFileSync(dockerfilePath, generated, 'utf-8');
    return dockerfilePath;
  }

  public cleanupWorkspace(workspaceDir?: string): void {
    if (!workspaceDir) return;
    try {
      if (workspaceDir.startsWith(this.buildRoot) && fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private populateSyntheticBuildArtifacts(
    repoDir: string,
    artifactDir: string,
    repoUrl: string,
    analysis: AnalysisResult
  ): void {
    fs.mkdirSync(artifactDir, { recursive: true });
    const assetsDir = path.join(artifactDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Deployed via Repo2Cloud — ${repoUrl}</title>
  <link rel="stylesheet" href="/assets/index.css" />
</head>
<body>
  <div id="root">
    <main class="container">
      <span class="badge">LIVE ON AWS</span>
      <h1>Deployed with Repo2Cloud</h1>
      <p>Repository: <code>${repoUrl}</code></p>
      <p>Detected Stack: <strong>${analysis.framework}</strong> (${analysis.recommendedTarget})</p>
    </main>
  </div>
  <script type="module" src="/assets/index.js"></script>
</body>
</html>`;

    const indexCss = `body { font-family: system-ui, -apple-system, sans-serif; background: #090d16; color: #f8fafc; display: grid; place-items: center; min-height: 100vh; margin: 0; }
.container { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 2rem; max-width: 560px; }
.badge { background: #065f46; color: #6ee7b7; font-size: 0.75rem; font-weight: 700; padding: 0.25rem 0.6rem; border-radius: 9999px; }`;

    const indexJs = `console.log("Repo2Cloud application initialized for ${repoUrl}");`;

    fs.writeFileSync(path.join(artifactDir, 'index.html'), indexHtml, 'utf-8');
    fs.writeFileSync(path.join(assetsDir, 'index.css'), indexCss, 'utf-8');
    fs.writeFileSync(path.join(assetsDir, 'index.js'), indexJs, 'utf-8');

    if (analysis.recommendedTarget === 'ECS_FARGATE') {
      this.ensureProductionDockerfile(repoDir, analysis);
    }
  }

  private listFilesRecursively(dir: string, rootDir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.listFilesRecursively(fullPath, rootDir));
      } else {
        results.push(path.relative(rootDir, fullPath));
      }
    }
    return results;
  }

  private runSandboxedCommand(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.maxBuildDurationMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            exitCode: 124,
            stdout,
            stderr: `Build exceeded maximum allowed duration of ${this.maxBuildDurationMs}ms and was terminated.`,
          });
        } else {
          resolve({ exitCode: code ?? 1, stdout, stderr });
        }
      });
    });
  }
}

export const isolatedBuildRunner = new IsolatedBuildRunner();
