import {
  CodeBuildClient,
  StartBuildCommand,
  BatchGetBuildsCommand,
  Build,
} from '@aws-sdk/client-codebuild';
import { AnalysisResult, DeploymentTarget } from '../types/deployment';

export interface CodeBuildJobParams {
  deploymentId: string;
  repoUrl: string;
  branch?: string;
  commitHash?: string;
  target: DeploymentTarget;
  analysis: AnalysisResult;
  userEnvVars?: Record<string, string>;
  targetS3Bucket?: string;
  targetS3Prefix?: string;
  artifactS3Bucket?: string;
  artifactS3Key?: string;
  ecrRepositoryUri?: string;
  dryRun?: boolean;
  onLog?: (message: string) => void;
  timeoutMinutes?: number;
}

export interface CodeBuildJobResult {
  buildId: string;
  buildStatus: 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT' | 'STOPPED';
  durationSeconds: number;
  logsUrl?: string;
  artifactS3Uri?: string;
  ecrImageUri?: string;
}

export class CodeBuildService {
  private readonly client: CodeBuildClient;
  public readonly projectName: string;
  private readonly region: string;

  constructor(projectName?: string, region?: string) {
    this.region = region || process.env.AWS_REGION || 'us-east-1';
    this.projectName =
      projectName || process.env.CODEBUILD_PROJECT_NAME || 'deploymate-build-worker';
    this.client = new CodeBuildClient({ region: this.region });
  }

  /**
   * Generates a dynamic AWS CodeBuild buildspec.yml tailored to the application
   * framework, deployment target, and artifact destination.
   */
  public generateBuildspec(params: {
    target: DeploymentTarget;
    analysis: AnalysisResult;
    repoUrl: string;
    branch?: string;
    targetS3Bucket?: string;
    targetS3Prefix?: string;
    artifactS3Bucket?: string;
    artifactS3Key?: string;
    ecrRepositoryUri?: string;
  }): string {
    const {
      target,
      analysis,
      repoUrl,
      branch = 'main',
      targetS3Bucket,
      targetS3Prefix,
      artifactS3Bucket,
      artifactS3Key,
      ecrRepositoryUri,
    } = params;
    const buildCmd = analysis.buildCommand || 'npm run build';
    const outputDir = analysis.outputDirectory || 'dist';

    if (target === 'ECS_FARGATE' && ecrRepositoryUri) {
      const ecrRegistry = ecrRepositoryUri.split('/')[0];
      return `version: 0.2
phases:
  pre_build:
    commands:
      - echo "Logging in to Amazon ECR..."
      - aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${ecrRegistry}
      - echo "Cloning repository \${REPO_URL} (branch: ${branch})..."
      - git clone --depth 1 --branch ${branch} \${REPO_URL} repo
      - cd repo
  build:
    commands:
      - echo "Building Docker image for linux/amd64..."
      - docker build --platform=linux/amd64 -t ${ecrRepositoryUri} .
  post_build:
    commands:
      - echo "Pushing Docker image to ECR (${ecrRepositoryUri})..."
      - docker push ${ecrRepositoryUri}
      - echo "Docker image successfully built and pushed."
`;
    }

    if (targetS3Bucket) {
      const prefix = targetS3Prefix ? `${targetS3Prefix.replace(/\/$/, '')}/` : '';
      return `version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - echo "Preparing build environment..."
      - git clone --depth 1 --branch ${branch} \${REPO_URL} .
      - npm ci --include=dev || npm install --include=dev
  build:
    commands:
      - echo "Executing production build (${buildCmd})..."
      - ${buildCmd}
  post_build:
    commands:
      - echo "Syncing production assets to s3://${targetS3Bucket}/${prefix}..."
      - aws s3 sync ${outputDir}/ s3://${targetS3Bucket}/${prefix} --delete
      - echo "Build and upload completed successfully."
`;
    }

    if (artifactS3Bucket && artifactS3Key) {
      return `version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - echo "Preparing build environment..."
      - git clone --depth 1 --branch ${branch} \${REPO_URL} .
      - npm ci --include=dev || npm install --include=dev
  build:
    commands:
      - echo "Executing production build (${buildCmd})..."
      - ${buildCmd}
  post_build:
    commands:
      - echo "Archiving compiled build output from ${outputDir}..."
      - if [ -d "${outputDir}" ]; then tar -czf /tmp/artifacts.tar.gz -C ${outputDir} .; elif [ -d "dist" ]; then tar -czf /tmp/artifacts.tar.gz -C dist .; else tar -czf /tmp/artifacts.tar.gz .; fi
      - echo "Uploading build artifacts to s3://${artifactS3Bucket}/${artifactS3Key}..."
      - aws s3 cp /tmp/artifacts.tar.gz s3://${artifactS3Bucket}/${artifactS3Key}
      - echo "Build and upload completed successfully."
`;
    }

    // Default generic buildspec
    return `version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - git clone --depth 1 --branch ${branch} \${REPO_URL} .
      - npm ci --include=dev || npm install --include=dev
  build:
    commands:
      - ${buildCmd}
`;
  }

  /**
   * Sanitizes environment variables so secret keys are not leaked or overridden dangerously.
   */
  public sanitizeEnvironmentVariables(
    userEnvVars: Record<string, string> = {}
  ): Array<{ name: string; value: string; type: 'PLAINTEXT' }> {
    const list: Array<{ name: string; value: string; type: 'PLAINTEXT' }> = [];
    for (const [k, v] of Object.entries(userEnvVars)) {
      const upper = k.toUpperCase();
      if (
        upper.startsWith('AWS_') ||
        upper.startsWith('GITHUB_') ||
        upper === 'PATH' ||
        upper.startsWith('LD_')
      ) {
        continue;
      }
      list.push({ name: k, value: String(v), type: 'PLAINTEXT' });
    }
    return list;
  }

  /**
   * Executes an ephemeral, serverless isolated build in AWS CodeBuild.
   * Free Tier: Covered under 100 build minutes/month for build.general1.small ($0.00 idle cost).
   */
  public async executeBuild(params: CodeBuildJobParams): Promise<CodeBuildJobResult> {
    const {
      deploymentId,
      repoUrl,
      branch = 'main',
      target,
      analysis,
      userEnvVars = {},
      targetS3Bucket,
      targetS3Prefix,
      artifactS3Bucket,
      artifactS3Key,
      ecrRepositoryUri,
      dryRun = false,
      onLog,
      timeoutMinutes = 15,
    } = params;

    const buildspec = this.generateBuildspec({
      target,
      analysis,
      repoUrl,
      branch,
      targetS3Bucket,
      targetS3Prefix,
      artifactS3Bucket,
      artifactS3Key,
      ecrRepositoryUri,
    });

    if (dryRun) {
      onLog?.(
        `[DryRun] AWS CodeBuild project "${this.projectName}" invoked for ${repoUrl} [target=${target}].`
      );
      onLog?.(
        `[DryRun] Environment: Ubuntu 22.04 (Node.js 20, Docker in privilegedMode=true, compute=BUILD_GENERAL1_SMALL).`
      );
      onLog?.(
        `[DryRun] Phases simulated: PROVISIONING -> DOWNLOAD_SOURCE -> INSTALL -> BUILD -> POST_BUILD -> SUCCEEDED in 42ms.`
      );
      return {
        buildId: `${this.projectName}:mock-build-${deploymentId}`,
        buildStatus: 'SUCCEEDED',
        durationSeconds: 1,
        logsUrl: `https://${this.region}.console.aws.amazon.com/codesuite/codebuild/projects/${this.projectName}/build/mock-${deploymentId}`,
        artifactS3Uri: artifactS3Bucket
          ? `s3://${artifactS3Bucket}/${artifactS3Key || ''}`
          : targetS3Bucket
          ? `s3://${targetS3Bucket}/${targetS3Prefix || ''}`
          : undefined,
        ecrImageUri: ecrRepositoryUri,
      };
    }

    onLog?.(
      `Phase 2: Launching ephemeral AWS CodeBuild worker (Project: ${this.projectName}, Compute: BUILD_GENERAL1_SMALL, Privileged=true)...`
    );

    const envVars = [
      { name: 'REPO_URL', value: repoUrl, type: 'PLAINTEXT' as const },
      { name: 'DEPLOYMENT_ID', value: deploymentId, type: 'PLAINTEXT' as const },
      ...this.sanitizeEnvironmentVariables(userEnvVars),
    ];

    const startCmd = new StartBuildCommand({
      projectName: this.projectName,
      buildspecOverride: buildspec,
      environmentVariablesOverride: envVars,
      timeoutInMinutesOverride: timeoutMinutes,
    });

    const startRes = await this.client.send(startCmd);
    const buildId = startRes.build?.id;
    if (!buildId) {
      throw new Error(`Failed to initiate AWS CodeBuild build: no build ID returned.`);
    }

    onLog?.(`AWS CodeBuild worker running: ${buildId}`);

    // Poll for build completion
    const startTime = Date.now();
    const maxPollMs = timeoutMinutes * 60 * 1000;
    let buildObj: Build | undefined;

    while (Date.now() - startTime < maxPollMs) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const batchRes = await this.client.send(
        new BatchGetBuildsCommand({ ids: [buildId] })
      );
      buildObj = batchRes.builds?.[0];

      if (!buildObj) continue;

      const currentPhase = buildObj.currentPhase || 'IN_PROGRESS';
      const status = buildObj.buildStatus;

      onLog?.(`CodeBuild [${buildId}] Phase: ${currentPhase} (Status: ${status || 'IN_PROGRESS'})`);

      if (status && status !== 'IN_PROGRESS') {
        break;
      }
    }

    const finalStatus = buildObj?.buildStatus || 'TIMED_OUT';
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const logsUrl = buildObj?.logs?.deepLink;

    if (finalStatus !== 'SUCCEEDED') {
      const phaseFail = buildObj?.phases?.find((p) => p.phaseStatus === 'FAILED');
      const errorDetail = phaseFail
        ? `Phase "${phaseFail.phaseType}" failed: ${phaseFail.contexts?.[0]?.message || 'Unknown error'}`
        : `Build ended with status: ${finalStatus}`;
      onLog?.(`AWS CodeBuild failed: ${errorDetail}`);
      throw new Error(`AWS CodeBuild failed (${finalStatus}): ${errorDetail}`);
    }

    onLog?.(`AWS CodeBuild completed successfully in ${durationSeconds}s.`);

    return {
      buildId,
      buildStatus: 'SUCCEEDED',
      durationSeconds,
      logsUrl,
      artifactS3Uri: targetS3Bucket ? `s3://${targetS3Bucket}/${targetS3Prefix || ''}` : undefined,
      ecrImageUri: ecrRepositoryUri,
    };
  }
}

export const codeBuildService = new CodeBuildService();
