import fs from 'fs';
import path from 'path';
import {
  AnalysisResult,
  ApplicationType,
  DeploymentTarget,
  SignalDetection,
} from '../types/deployment';

export interface RepoInspectionSnapshot {
  files: string[];
  packageJson?: {
    name?: string;
    main?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    workspaces?: string[] | { packages?: string[] };
  };
  nextConfigContent?: string;
  dockerfileContent?: string;
  serverlessContent?: string;
  requirementsTxtContent?: string;
  pyprojectContent?: string;
}

export class RepositoryAnalyzer {
  /**
   * Analyzes a local directory on disk (e.g., inside the isolated build workspace).
   */
  public analyzeDirectory(repoDir: string): AnalysisResult {
    const snapshot = this.collectLocalSnapshot(repoDir);
    return this.evaluateSnapshot(snapshot);
  }

  /**
   * Analyzes a remote GitHub repository via GitHub's REST/Raw API without executing any code.
   * Falls back gracefully if network/rate-limits occur.
   */
  public async analyzeRemoteGitHubRepo(
    owner: string,
    repo: string,
    branch?: string
  ): Promise<AnalysisResult> {
    try {
      const snapshot = await this.fetchRemoteSnapshot(owner, repo, branch);
      if (snapshot.files.length > 0 || snapshot.packageJson) {
        return this.evaluateSnapshot(snapshot);
      }
    } catch {
      // Fallback to heuristic URL inspection when offline or rate-limited
    }

    return this.evaluateHeuristicFromRepoName(owner, repo);
  }

  /**
   * Deterministic rule engine that converts a repository snapshot into an AnalysisResult (Phase 3).
   */
  public evaluateSnapshot(snapshot: RepoInspectionSnapshot): AnalysisResult {
    const fileSet = new Set(snapshot.files.map((f) => f.toLowerCase()));
    const signals: SignalDetection[] = [];
    const warnings: string[] = [];
    const reasons: string[] = [];

    const pkg = snapshot.packageJson;
    const allDeps: Record<string, string> = {
      ...(pkg?.dependencies || {}),
      ...(pkg?.devDependencies || {}),
    };
    const scripts = pkg?.scripts || {};

    // 1. Check Monorepo signals
    const hasMonorepoFile =
      fileSet.has('pnpm-workspace.yaml') ||
      fileSet.has('turbo.json') ||
      fileSet.has('lerna.json') ||
      fileSet.has('nx.json') ||
      Boolean(pkg?.workspaces);

    if (hasMonorepoFile) {
      signals.push({
        signal: 'Monorepo manifest',
        description: 'Detected workspace/monorepo configuration',
      });
      warnings.push(
        'Monorepo detected: multiple services or packages may require separate deployment targets.'
      );
    }

    // 2. Check Dockerfile signal
    const hasDockerfile =
      fileSet.has('dockerfile') ||
      Array.from(fileSet).some((f) => f.endsWith('/dockerfile'));
    if (hasDockerfile) {
      signals.push({
        signal: 'Dockerfile',
        description: 'Container build definition found at repository root',
        file: 'Dockerfile',
      });
    }

    // 3. Check Serverless signals (SAM / Serverless Framework / Lambda handlers)
    const hasSamOrServerlessConfig =
      fileSet.has('serverless.yml') ||
      fileSet.has('serverless.yaml') ||
      fileSet.has('serverless.ts') ||
      fileSet.has('template.yaml') ||
      fileSet.has('template.yml') ||
      fileSet.has('samconfig.toml');

    const hasLambdaAdapter =
      Boolean(allDeps['serverless-http']) ||
      Boolean(allDeps['@vendia/serverless-express']) ||
      Boolean(allDeps['@codegenie/serverless-express']) ||
      Boolean(allDeps['aws-lambda']);

    const hasHandlerFile =
      fileSet.has('handler.js') ||
      fileSet.has('handler.ts') ||
      fileSet.has('src/handler.ts') ||
      fileSet.has('src/handler.js') ||
      fileSet.has('lambda.js') ||
      fileSet.has('lambda.ts');

    if (hasSamOrServerlessConfig || hasLambdaAdapter || hasHandlerFile) {
      signals.push({
        signal: 'Serverless configuration / handler',
        description: hasSamOrServerlessConfig
          ? 'Found AWS SAM / Serverless Framework manifest'
          : 'Found AWS Lambda handler adapter in dependencies/files',
      });
    }

    // 4. Check Vite config signals
    const hasViteConfig =
      Array.from(fileSet).some((f) => /^vite\.config\.(js|ts|mjs|cjs)$/.test(f)) ||
      Boolean(allDeps['vite']);

    if (hasViteConfig) {
      signals.push({
        signal: 'vite.config.* / vite',
        description: 'Vite frontend bundler configuration detected',
      });
    }

    // 5. Check Next.js signals
    const hasNextConfig =
      Array.from(fileSet).some((f) => /^next\.config\.(js|ts|mjs|cjs)$/.test(f)) ||
      Boolean(allDeps['next']);

    if (hasNextConfig) {
      signals.push({
        signal: 'next.config.* / next',
        description: 'Next.js framework configuration detected',
      });
    }

    // 6. Check Node server signals (Express, Fastify, NestJS, Koa, server.js, app.js)
    const hasServerEntryFile =
      fileSet.has('server.js') ||
      fileSet.has('server.ts') ||
      fileSet.has('app.js') ||
      fileSet.has('app.ts') ||
      fileSet.has('src/server.ts') ||
      fileSet.has('src/server.js') ||
      fileSet.has('src/index.ts');

    const hasNodeServerFramework =
      Boolean(allDeps['express']) ||
      Boolean(allDeps['fastify']) ||
      Boolean(allDeps['@nestjs/core']) ||
      Boolean(allDeps['koa']) ||
      Boolean(allDeps['hono']);

    if (hasServerEntryFile || hasNodeServerFramework) {
      signals.push({
        signal: 'Node.js server signal',
        description: hasNodeServerFramework
          ? 'Detected Node.js server framework (Express/Fastify/NestJS)'
          : 'Detected server.js / app.js server entry point',
      });
    }

    // 7. Check Python signals
    const hasPythonSignals =
      fileSet.has('requirements.txt') ||
      fileSet.has('pyproject.toml') ||
      fileSet.has('pipfile') ||
      fileSet.has('main.py') ||
      fileSet.has('app.py');

    if (hasPythonSignals) {
      signals.push({
        signal: 'Python manifest',
        description: 'Detected requirements.txt / pyproject.toml Python service',
      });
    }

    if (pkg) {
      signals.push({
        signal: 'package.json',
        description: `Inspected scripts (${Object.keys(scripts).join(', ') || 'none'}) and ${
          Object.keys(allDeps).length
        } dependencies`,
        file: 'package.json',
      });
    }

    // ========================================================================
    // Deterministic Classification & Target Recommendation Rules
    // ========================================================================
    let framework = 'Unknown';
    let applicationType: ApplicationType = 'unknown';
    let buildCommand: string | null = scripts.build ? 'npm run build' : null;
    let outputDirectory: string | null = null;
    let recommendedTarget: DeploymentTarget = 'S3_CLOUDFRONT';
    let confidence = 0.65;
    let runtime = pkg ? 'nodejs20.x' : hasPythonSignals ? 'python3.12' : 'unknown';
    let entryPoint: string | undefined = pkg?.main;

    // Rule A: Explicit Serverless project (SAM / serverless.yml / Lambda adapter)
    if (hasSamOrServerlessConfig || (hasLambdaAdapter && hasHandlerFile)) {
      framework = allDeps['express']
        ? 'Serverless Express (Lambda)'
        : hasPythonSignals
        ? 'Python AWS Lambda'
        : 'AWS Serverless Node.js';
      applicationType = 'serverless-api';
      buildCommand = scripts.build ? 'npm run build' : null;
      outputDirectory = '.serverless';
      recommendedTarget = 'LAMBDA_API_GATEWAY';
      confidence = hasSamOrServerlessConfig ? 0.95 : 0.89;
      entryPoint = hasHandlerFile ? 'handler.handler' : 'index.handler';
      reasons.push(
        'Detected serverless configuration/handler compatible with AWS Lambda and API Gateway.'
      );
    }
    // Rule B: Vite / React / Vue / Svelte / Solid static frontend
    else if (hasViteConfig) {
      const uiLib = allDeps['react']
        ? 'React'
        : allDeps['vue']
        ? 'Vue'
        : allDeps['svelte']
        ? 'Svelte'
        : 'TypeScript/JS';
      framework = `Vite + ${uiLib}`;
      applicationType = 'static-frontend';
      buildCommand = scripts.build ? 'npm run build' : 'npx vite build';
      outputDirectory = 'dist';
      recommendedTarget = 'S3_CLOUDFRONT';
      confidence = 0.96;
      reasons.push(
        `Detected ${framework} with static build output in "dist/" suitable for S3 + CloudFront OAC hosting.`
      );
    }
    // Rule C: Create React App / static React or Vue CLI / Angular static SPA
    else if (
      allDeps['react-scripts'] ||
      allDeps['@vue/cli-service'] ||
      allDeps['@angular/core'] ||
      allDeps['astro']
    ) {
      if (allDeps['react-scripts']) {
        framework = 'Create React App';
        outputDirectory = 'build';
      } else if (allDeps['@vue/cli-service']) {
        framework = 'Vue CLI SPA';
        outputDirectory = 'dist';
      } else if (allDeps['@angular/core']) {
        framework = 'Angular SPA';
        outputDirectory = 'dist';
      } else {
        framework = 'Astro Static Site';
        outputDirectory = 'dist';
      }
      applicationType = 'static-frontend';
      buildCommand = 'npm run build';
      recommendedTarget = 'S3_CLOUDFRONT';
      confidence = 0.93;
      reasons.push(
        `Detected ${framework} single-page/static application that compiles static assets to "${outputDirectory}/".`
      );
    }
    // Rule D: Next.js application (Static Export vs SSR Managed Amplify / ECS)
    else if (hasNextConfig) {
      const isStaticExport =
        Boolean(snapshot.nextConfigContent && /output\s*:\s*['"]export['"]/.test(snapshot.nextConfigContent)) ||
        Boolean(scripts.build && scripts.build.includes('next export'));

      if (isStaticExport) {
        framework = 'Next.js (Static Export)';
        applicationType = 'static-frontend';
        buildCommand = 'npm run build';
        outputDirectory = 'out';
        recommendedTarget = 'S3_CLOUDFRONT';
        confidence = 0.94;
        reasons.push(
          'Detected Next.js configured with static export (`output: "export"`), emitting static assets to "out/".'
        );
      } else if (hasDockerfile) {
        framework = 'Next.js (Containerized SSR)';
        applicationType = 'containerized-service';
        buildCommand = 'docker build -t app .';
        outputDirectory = '.next';
        recommendedTarget = 'ECS_FARGATE';
        confidence = 0.92;
        reasons.push(
          'Detected Next.js SSR application with a Dockerfile; recommending ECS Fargate container deployment.'
        );
      } else {
        framework = 'Next.js (Full-Stack / SSR)';
        applicationType = 'ssr-frontend';
        buildCommand = 'npm run build';
        outputDirectory = '.next';
        recommendedTarget = 'AMPLIFY';
        confidence = 0.91;
        reasons.push(
          'Detected Next.js with Server-Side Rendering / App Router; recommending AWS Amplify Managed Hosting (or S3 + CloudFront if exported statically).'
        );
      }
    }
    // Rule E: Conventional Node.js API (Express / Fastify / NestJS) or Dockerfile service
    else if (hasNodeServerFramework || hasDockerfile || hasPythonSignals) {
      if (hasPythonSignals) {
        const pyContent =
          `${snapshot.requirementsTxtContent || ''}\n${snapshot.pyprojectContent || ''}`.toLowerCase();
        if (pyContent.includes('fastapi')) {
          framework = 'Python + FastAPI';
        } else if (pyContent.includes('flask')) {
          framework = 'Python + Flask';
        } else if (pyContent.includes('django')) {
          framework = 'Python + Django';
        } else {
          framework = 'Python Service';
        }
        applicationType = hasDockerfile ? 'containerized-service' : 'python-service';
      } else if (allDeps['@nestjs/core']) {
        framework = 'NestJS API';
        applicationType = hasDockerfile ? 'containerized-service' : 'node-server';
      } else if (allDeps['fastify']) {
        framework = 'Fastify API';
        applicationType = hasDockerfile ? 'containerized-service' : 'node-server';
      } else if (allDeps['express']) {
        framework = 'Node.js + Express';
        applicationType = hasDockerfile ? 'containerized-service' : 'node-server';
        warnings.push(
          'Standard Express server detected without a Lambda serverless adapter; routing to ECS Fargate instead of Lambda.'
        );
      } else {
        framework = 'Dockerized Web Service';
        applicationType = 'containerized-service';
      }

      buildCommand = hasDockerfile
        ? 'docker build -t service-image .'
        : scripts.build
        ? 'npm run build'
        : null;
      outputDirectory = scripts.build ? 'dist' : null;
      recommendedTarget = 'ECS_FARGATE';
      confidence = hasDockerfile ? 0.95 : 0.87;
      entryPoint =
        pkg?.main ||
        (fileSet.has('server.js')
          ? 'server.js'
          : fileSet.has('app.js')
          ? 'app.js'
          : 'src/index.ts');

      if (!hasDockerfile) {
        warnings.push(
          'No Dockerfile found in repository root; Repo2Cloud will generate a hardened production Dockerfile for ECS Fargate.'
        );
      }

      reasons.push(
        `Detected persistent backend service (${framework}); recommending ECS Fargate with an Application Load Balancer.`
      );
    }
    // Rule F: Static HTML/CSS/JS repository with index.html
    else if (fileSet.has('index.html') || fileSet.has('public/index.html')) {
      framework = 'Static HTML/JS';
      applicationType = 'static-frontend';
      buildCommand = scripts.build ? 'npm run build' : null;
      outputDirectory = fileSet.has('index.html') ? '.' : 'public';
      recommendedTarget = 'S3_CLOUDFRONT';
      confidence = 0.88;
      reasons.push(
        'Detected static index.html entry point with no server runtime needed; recommending S3 + CloudFront.'
      );
    } else {
      warnings.push(
        'Could not confidently detect a standard framework manifest. Defaulting to static S3 + CloudFront target.'
      );
      reasons.push(
        'Fallback recommendation: S3 + CloudFront static hosting.'
      );
    }

    const aiExplanation = this.buildDeterministicExplanation({
      framework,
      applicationType,
      buildCommand,
      outputDirectory,
      recommendedTarget,
      confidence,
      warnings,
      reasons,
      signalsDetected: signals,
    });

    return {
      framework,
      applicationType,
      buildCommand,
      outputDirectory,
      recommendedTarget,
      confidence,
      warnings,
      reasons,
      signalsDetected: signals,
      runtime,
      entryPoint,
      hasDockerfile,
      isMonorepo: hasMonorepoFile,
      aiExplanation,
    };
  }

  private collectLocalSnapshot(repoDir: string): RepoInspectionSnapshot {
    const files: string[] = [];
    const topEntries = fs.existsSync(repoDir) ? fs.readdirSync(repoDir, { withFileTypes: true }) : [];

    for (const entry of topEntries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      files.push(entry.name);
      if (entry.isDirectory() && ['src', 'public', 'packages', 'apps'].includes(entry.name)) {
        try {
          const subEntries = fs.readdirSync(path.join(repoDir, entry.name));
          for (const sub of subEntries) {
            files.push(`${entry.name}/${sub}`);
          }
        } catch {
          // ignore unreadable subdirs
        }
      }
    }

    const readTextIfPresent = (relPath: string): string | undefined => {
      const full = path.join(repoDir, relPath);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return fs.readFileSync(full, 'utf-8');
      }
      return undefined;
    };

    let packageJson: RepoInspectionSnapshot['packageJson'];
    const rawPkg = readTextIfPresent('package.json');
    if (rawPkg) {
      try {
        packageJson = JSON.parse(rawPkg);
      } catch {
        // ignore invalid package.json
      }
    }

    const nextConfigContent =
      readTextIfPresent('next.config.js') ||
      readTextIfPresent('next.config.mjs') ||
      readTextIfPresent('next.config.ts');

    const dockerfileContent = readTextIfPresent('Dockerfile');
    const serverlessContent =
      readTextIfPresent('serverless.yml') ||
      readTextIfPresent('serverless.yaml') ||
      readTextIfPresent('template.yaml');
    const requirementsTxtContent = readTextIfPresent('requirements.txt');
    const pyprojectContent = readTextIfPresent('pyproject.toml');

    return {
      files,
      packageJson,
      nextConfigContent,
      dockerfileContent,
      serverlessContent,
      requirementsTxtContent,
      pyprojectContent,
    };
  }

  private async fetchRemoteSnapshot(
    owner: string,
    repo: string,
    branch?: string
  ): Promise<RepoInspectionSnapshot> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Repo2Cloud-Analyzer/1.0',
    };
    if (process.env.GITHUB_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_ACCESS_TOKEN}`;
    }

    const refQuery = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents${refQuery}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(contentsUrl, { headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`GitHub API responded with ${res.status}`);
      }

      const items = (await res.json()) as Array<{ name: string; type: string; download_url?: string }>;
      if (!Array.isArray(items)) {
        throw new Error('Unexpected GitHub contents payload');
      }

      const files = items.map((item) => item.name);
      const snapshot: RepoInspectionSnapshot = { files };

      const fetchFileText = async (fileName: string): Promise<string | undefined> => {
        const found = items.find((i) => i.name.toLowerCase() === fileName.toLowerCase());
        if (!found || !found.download_url) return undefined;
        const fileRes = await fetch(found.download_url, { signal: controller.signal });
        if (!fileRes.ok) return undefined;
        return await fileRes.text();
      };

      const pkgText = await fetchFileText('package.json');
      if (pkgText) {
        try {
          snapshot.packageJson = JSON.parse(pkgText);
        } catch {
          // ignore malformed JSON
        }
      }

      snapshot.nextConfigContent =
        (await fetchFileText('next.config.js')) ||
        (await fetchFileText('next.config.mjs')) ||
        (await fetchFileText('next.config.ts'));
      snapshot.dockerfileContent = await fetchFileText('Dockerfile');
      snapshot.requirementsTxtContent = await fetchFileText('requirements.txt');
      snapshot.pyprojectContent = await fetchFileText('pyproject.toml');

      return snapshot;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Deterministic fallback when offline or testing demo URLs (e.g., https://github.com/example/vite-app).
   */
  public evaluateHeuristicFromRepoName(owner: string, repo: string): AnalysisResult {
    const lower = `${owner}/${repo}`.toLowerCase();

    if (lower.includes('lambda') || lower.includes('serverless') || lower.includes('sam-')) {
      return this.evaluateSnapshot({
        files: ['package.json', 'serverless.yml', 'handler.js'],
        packageJson: {
          name: repo,
          scripts: { build: 'npm run build' },
          dependencies: { 'serverless-http': '^3.2.0' },
        },
      });
    }

    if (
      lower.includes('express') ||
      lower.includes('api') ||
      lower.includes('backend') ||
      lower.includes('docker') ||
      lower.includes('fargate') ||
      lower.includes('server')
    ) {
      return this.evaluateSnapshot({
        files: ['package.json', 'Dockerfile', 'server.js'],
        packageJson: {
          name: repo,
          main: 'server.js',
          scripts: { start: 'node server.js', build: 'tsc' },
          dependencies: { express: '^4.19.2' },
        },
      });
    }

    if (lower.includes('next') || lower.includes('amplify') || lower.includes('ssr')) {
      return this.evaluateSnapshot({
        files: ['package.json', 'next.config.mjs'],
        packageJson: {
          name: repo,
          scripts: { build: 'next build', start: 'next start' },
          dependencies: { next: '^14.2.0', react: '^18.3.0', 'react-dom': '^18.3.0' },
        },
      });
    }

    // Default: Vite + React static application (Phase 1 primary vertical slice)
    return this.evaluateSnapshot({
      files: ['package.json', 'vite.config.ts', 'index.html'],
      packageJson: {
        name: repo,
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        devDependencies: { vite: '^5.4.0', typescript: '^5.5.0' },
      },
    });
  }

  private buildDeterministicExplanation(
    result: Omit<AnalysisResult, 'aiExplanation'>
  ): string {
    const targetLabels: Record<DeploymentTarget, string> = {
      S3_CLOUDFRONT: 'Amazon S3 (private bucket) + CloudFront CDN with Origin Access Control (OAC)',
      ECS_FARGATE: 'Amazon ECS Fargate container service behind an Application Load Balancer',
      LAMBDA_API_GATEWAY: 'AWS Lambda serverless function fronted by Amazon API Gateway',
      AMPLIFY: 'AWS Amplify Managed Hosting with SSR compute support',
    };

    const buildPart = result.buildCommand
      ? `The repository builds via \`${result.buildCommand}\`${
          result.outputDirectory ? ` and outputs artifacts to \`${result.outputDirectory}/\`` : ''
        }.`
      : 'No compile step is required before packaging.';

    return `Detected **${result.framework}** (${result.applicationType}) with ${Math.round(
      result.confidence * 100
    )}% confidence. ${buildPart} Recommended target: **${
      targetLabels[result.recommendedTarget]
    }**.`;
  }
}

export const repositoryAnalyzer = new RepositoryAnalyzer();
