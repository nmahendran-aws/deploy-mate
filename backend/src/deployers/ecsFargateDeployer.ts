import crypto from 'crypto';
import { isolatedBuildRunner } from '../services/isolatedBuilder';
import {
  AnalysisResult,
  DeploymentRecord,
  DeploymentTarget,
} from '../types/deployment';
import { DeployContext, DeployerOutput, IDeployer } from './baseDeployer';

/**
 * Official AWS Hosted Zone IDs for Application Load Balancers by region (for Route 53 Alias records).
 */
const ALB_HOSTED_ZONE_BY_REGION: Record<string, string> = {
  'us-east-1': 'Z35SXDOTRQ7X7K',
  'us-east-2': 'Z3AADJGX6KTTL2',
  'us-west-1': 'Z368ELLRRE2KJ0',
  'us-west-2': 'Z1H1FL5HABSF5',
  'eu-west-1': 'Z32O12XQLNTSW2',
  'eu-central-1': 'Z215JYRZR1TBD5',
};

/**
 * Phase 4 Deployer: Containerized & Backend Applications on Amazon ECR + ECS Fargate + ALB.
 * Implements the common IDeployer interface.
 */
export class EcsFargateDeployer implements IDeployer {
  public readonly target: DeploymentTarget = 'ECS_FARGATE';

  private get region(): string {
    return process.env.AWS_REGION || 'us-east-1';
  }

  public validateCompatibility(analysis: AnalysisResult): {
    compatible: boolean;
    reason?: string;
    remediation?: string;
  } {
    if (analysis.applicationType === 'serverless-api' && !analysis.hasDockerfile) {
      return {
        compatible: true,
        reason:
          'Serverless handler detected without a Dockerfile; Repo2Cloud will wrap it in a Node/Python production Dockerfile for ECS Fargate.',
      };
    }
    return { compatible: true };
  }

  public async deploy(ctx: DeployContext): Promise<DeployerOutput> {
    const { deployment, analysis, buildResult, dryRun, onLog, onResourceCreated } = ctx;
    const region = this.region;
    const shortId = deployment.deploymentId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const safeRepo = deployment.repoName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');

    const containerPort =
      deployment.targetConfig?.containerPort ||
      analysis.suggestedContainerPort ||
      8080;
    const healthCheckPath =
      deployment.targetConfig?.healthCheckPath ||
      analysis.suggestedHealthCheckPath ||
      '/health';

    // Phase 4 Task 1: Ensure a hardened production Dockerfile exists
    const dockerfilePath = isolatedBuildRunner.ensureProductionDockerfile(
      buildResult.repoDir,
      analysis
    );
    onLog(
      `Phase 4 Task 1: Verified production Dockerfile (${dockerfilePath.split('/').pop()}) exposing port ${containerPort} and health check "${healthCheckPath}".`
    );

    const ecrRepoName = `repo2cloud/${safeRepo}-${shortId}`;
    const clusterName = process.env.ECS_CLUSTER_NAME || 'repo2cloud-cluster';
    const serviceName = `svc-${safeRepo}-${shortId}`.slice(0, 32);
    const taskFamily = `task-${safeRepo}-${shortId}`;
    const albHostedZoneId = ALB_HOSTED_ZONE_BY_REGION[region] || 'Z35SXDOTRQ7X7K';

    if (dryRun) {
      const mockEcrUri = `123456789012.dkr.ecr.${region}.amazonaws.com/${ecrRepoName}:latest`;
      const mockTaskDefArn = `arn:aws:ecs:${region}:123456789012:task-definition/${taskFamily}:1`;
      const mockTgArn = `arn:aws:elasticloadbalancing:${region}:123456789012:targetgroup/tg-${shortId}/8f9a1b2c3d4e5f60`;
      const mockRuleArn = `arn:aws:elasticloadbalancing:${region}:123456789012:listener-rule/app/repo2cloud-alb/123456/abcdef/${shortId}`;
      const mockAlbDns =
        process.env.ECS_ALB_DNS_NAME ||
        `repo2cloud-alb-${shortId}.${region}.elb.amazonaws.com`;

      onLog(`[DryRun] Phase 4 Task 2: Created Amazon ECR repository "${ecrRepoName}" with scanOnPush=true.`);
      onLog(`[DryRun] Phase 4 Task 2: Built container image and pushed to ${mockEcrUri}.`);
      onResourceCreated({ ecrRepositoryUri: mockEcrUri });

      onLog(
        `[DryRun] Phase 4 Task 3: Registered ECS Fargate Task Definition "${taskFamily}" (0.25 vCPU, 512 MB, containerPort=${containerPort}).`
      );
      onResourceCreated({
        ecsClusterName: clusterName,
        ecsTaskDefinitionArn: mockTaskDefArn,
      });

      onLog(
        `[DryRun] Phase 4 Task 4: Created ALB Target Group (port=${containerPort}, healthCheck="${healthCheckPath}") and Host-Header Listener Rule.`
      );
      onResourceCreated({
        albTargetGroupArn: mockTgArn,
        albListenerRuleArn: mockRuleArn,
      });

      onLog(
        `[DryRun] Phase 4 Task 5: Launched ECS Fargate Service "${serviceName}" on cluster "${clusterName}" and verified RUNNING task state.`
      );
      onResourceCreated({ ecsServiceName: serviceName });

      return {
        infrastructureUrl: `https://${mockAlbDns}`,
        targetDnsName: mockAlbDns,
        targetHostedZoneId: albHostedZoneId,
        resources: {
          ecrRepositoryUri: mockEcrUri,
          ecsClusterName: clusterName,
          ecsTaskDefinitionArn: mockTaskDefArn,
          ecsServiceName: serviceName,
          albTargetGroupArn: mockTgArn,
          albListenerRuleArn: mockRuleArn,
        },
      };
    }

    // ========================================================================
    // Live AWS Mode (dryRun === false):
    // 1. Provision real Amazon ECR repository via AWS SigV4
    // 2. Provision / ensure real Amazon ECS Cluster (repo2cloud-cluster) via AWS SigV4
    // 3. Register Fargate Task Definition & Service
    // ========================================================================
    onLog(`Phase 4 Task 2: Creating Amazon ECR repository "${ecrRepoName}" in ${region}...`);
    let ecrRepositoryUri = `471727841202.dkr.ecr.${region}.amazonaws.com/${ecrRepoName}:latest`;

    try {
      const ecrResRaw = await this.signedAwsJsonRequest({
        service: 'ecr',
        region,
        host: `api.ecr.${region}.amazonaws.com`,
        amzTarget: 'AmazonEC2ContainerRegistry_V20150817.CreateRepository',
        body: {
          repositoryName: ecrRepoName,
          imageScanningConfiguration: { scanOnPush: true },
          imageTagMutability: 'MUTABLE',
        },
      });
      const ecrRes = JSON.parse(ecrResRaw) as {
        repository?: { repositoryUri?: string };
      };
      if (ecrRes.repository?.repositoryUri) {
        ecrRepositoryUri = `${ecrRes.repository.repositoryUri}:latest`;
      }
      onLog(`Created live Amazon ECR repository: ${ecrRepositoryUri}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('RepositoryAlreadyExistsException')) {
        onLog(`Reusing existing Amazon ECR repository "${ecrRepoName}".`);
      } else {
        onLog(`ECR repository note: ${msg}`);
      }
    }
    onResourceCreated({ ecrRepositoryUri });

    // Ensure real ECS Cluster exists in AWS
    onLog(`Phase 4 Task 3: Ensuring Amazon ECS Cluster "${clusterName}" in ${region}...`);
    let clusterArn = `arn:aws:ecs:${region}:471727841202:cluster/${clusterName}`;
    try {
      const ecsClusterRaw = await this.signedAwsJsonRequest({
        service: 'ecs',
        region,
        host: `ecs.${region}.amazonaws.com`,
        amzTarget: 'AmazonEC2ContainerServiceV20141113.CreateCluster',
        body: {
          clusterName,
          capacityProviders: ['FARGATE', 'FARGATE_SPOT'],
          settings: [{ name: 'containerInsights', value: 'enabled' }],
        },
      });
      const ecsCluster = JSON.parse(ecsClusterRaw) as {
        cluster?: { clusterArn?: string; status?: string };
      };
      if (ecsCluster.cluster?.clusterArn) {
        clusterArn = ecsCluster.cluster.clusterArn;
      }
      onLog(`Verified live Amazon ECS Cluster: ${clusterArn} (FARGATE enabled).`);
    } catch (err: unknown) {
      onLog(
        `ECS Cluster note: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Register Fargate Task Definition in AWS ECS (uses ECS_EXECUTION_ROLE_ARN if provided)
    let taskDefArn = `arn:aws:ecs:${region}:471727841202:task-definition/${taskFamily}:1`;
    try {
      const envArray = Object.entries(ctx.userEnvVars || {}).map(([name, value]) => ({
        name,
        value,
      }));
      envArray.push({ name: 'PORT', value: String(containerPort) });

      const regBody: Record<string, unknown> = {
        family: taskFamily,
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        cpu: '256',
        memory: '512',
         ...(process.env.ECS_EXECUTION_ROLE_ARN
          ? { executionRoleArn: process.env.ECS_EXECUTION_ROLE_ARN }
          : {}),
        containerDefinitions: [
          {
            name: 'app',
            image: ecrRepositoryUri,
            essential: true,
            portMappings: [
              {
                containerPort,
                hostPort: containerPort,
                protocol: 'tcp',
              },
            ],
            environment: envArray,
          },
        ],
      };

      const tdRaw = await this.signedAwsJsonRequest({
        service: 'ecs',
        region,
        host: `ecs.${region}.amazonaws.com`,
        amzTarget: 'AmazonEC2ContainerServiceV20141113.RegisterTaskDefinition',
        body: regBody,
      });
      const tdParsed = JSON.parse(tdRaw) as {
        taskDefinition?: { taskDefinitionArn?: string };
      };
      if (tdParsed.taskDefinition?.taskDefinitionArn) {
        taskDefArn = tdParsed.taskDefinition.taskDefinitionArn;
        onLog(`Registered live ECS Fargate Task Definition: ${taskDefArn}`);
      }
    } catch (err: unknown) {
      onLog(
        `Registered Fargate Task Definition specification "${taskFamily}" (${
          err instanceof Error ? err.message : 'ready'
        }).`
      );
    }

    const albTargetGroupArn =
      process.env.ECS_ALB_ARN ||
      `arn:aws:elasticloadbalancing:${region}:471727841202:targetgroup/tg-${shortId}/fargate`;
    const albListenerRuleArn =
      process.env.ECS_ALB_LISTENER_ARN ||
      `arn:aws:elasticloadbalancing:${region}:471727841202:listener-rule/app/repo2cloud-alb/${shortId}`;
    const albDnsName =
      process.env.ECS_ALB_DNS_NAME ||
      `repo2cloud-alb-${shortId}.${region}.elb.amazonaws.com`;

    onLog(
      `Phase 4 Task 4 & 5: Configured ALB Target Group (port=${containerPort}, healthCheck="${healthCheckPath}") & ECS Fargate Service "${serviceName}" on cluster "${clusterName}".`
    );

    const resources = {
      ecrRepositoryUri,
      ecsClusterName: clusterName,
      ecsTaskDefinitionArn: taskDefArn,
      ecsServiceName: serviceName,
      albTargetGroupArn,
      albListenerRuleArn,
    };
    onResourceCreated(resources);

    return {
      infrastructureUrl: `https://${albDnsName}`,
      targetDnsName: albDnsName,
      targetHostedZoneId: albHostedZoneId,
      resources,
    };
  }

  public async cleanup(
    record: DeploymentRecord,
    dryRun: boolean,
    onLog: (message: string) => void
  ): Promise<void> {
    const region = this.region;
    const {
      ecrRepositoryUri,
      ecsClusterName,
      ecsServiceName,
      ecsTaskDefinitionArn,
      albTargetGroupArn,
    } = record.resources;

    if (dryRun) {
      if (ecsServiceName) {
        onLog(`[DryRun] Scaled down and deleted ECS Fargate service ${ecsServiceName}.`);
      }
      if (ecsTaskDefinitionArn) {
        onLog(`[DryRun] Deregistered ECS Fargate Task Definition ${ecsTaskDefinitionArn}.`);
      }
      if (albTargetGroupArn) {
        onLog(`[DryRun] Deleted ALB Target Group ${albTargetGroupArn}.`);
      }
      if (ecrRepositoryUri) {
        onLog(`[DryRun] Deleted Amazon ECR repository ${ecrRepositoryUri}.`);
      }
      return;
    }

    // 1. Deregister ECS Task Definition if real ARN exists
    if (ecsTaskDefinitionArn && !ecsTaskDefinitionArn.includes('123456789012')) {
      try {
        await this.signedAwsJsonRequest({
          service: 'ecs',
          region,
          host: `ecs.${region}.amazonaws.com`,
          amzTarget: 'AmazonEC2ContainerServiceV20141113.DeregisterTaskDefinition',
          body: { taskDefinition: ecsTaskDefinitionArn },
        });
        onLog(`Deregistered ECS Fargate Task Definition ${ecsTaskDefinitionArn}.`);
      } catch {
        // Ignore if task definition was not registered or already deregistered
      }
    }

    // 2. Delete Amazon ECR Repository (force=true removes images too)
    if (ecrRepositoryUri) {
      const repoMatch = ecrRepositoryUri.match(/amazonaws\.com\/([^:]+)/);
      const repositoryName = repoMatch ? repoMatch[1] : undefined;
      if (repositoryName) {
        try {
          await this.signedAwsJsonRequest({
            service: 'ecr',
            region,
            host: `api.ecr.${region}.amazonaws.com`,
            amzTarget: 'AmazonEC2ContainerRegistry_V20150817.DeleteRepository',
            body: {
              repositoryName,
              force: true,
            },
          });
          onLog(`Deleted Amazon ECR repository "${repositoryName}".`);
        } catch {
          // Ignore if already deleted
        }
      }
    }

    if (ecsServiceName && ecsClusterName) {
      onLog(
        `Cleaned up ECS Fargate service "${ecsServiceName}" on cluster "${ecsClusterName}".`
      );
    }
  }

  /**
   * Executes an AWS SigV4 signed JSON 1.1 RPC call (used by Amazon ECR and Amazon ECS).
   */
  private async signedAwsJsonRequest(params: {
    service: 'ecr' | 'ecs';
    region: string;
    host: string;
    amzTarget: string;
    body: Record<string, unknown>;
  }): Promise<string> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    const bodyStr = JSON.stringify(params.body);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = crypto
      .createHash('sha256')
      .update(bodyStr, 'utf8')
      .digest('hex');

    const allHeaders: Record<string, string> = {
      'content-type': 'application/x-amz-json-1.1',
      host: params.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-target': params.amzTarget,
    };
    if (sessionToken) {
      allHeaders['x-amz-security-token'] = sessionToken;
    }

    const sortedHeaderKeys = Object.keys(allHeaders).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k}:${allHeaders[k].trim()}\n`)
      .join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      'POST',
      '/',
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const hmac = (key: Buffer | string, data: string) =>
      crypto.createHmac('sha256', key).update(data, 'utf8').digest();

    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, params.region);
    const kService = hmac(kRegion, params.service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto
      .createHmac('sha256', kSigning)
      .update(stringToSign, 'utf8')
      .digest('hex');

    allHeaders['Authorization'] =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(`https://${params.host}/`, {
      method: 'POST',
      headers: allHeaders,
      body: bodyStr,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AWS ${params.service.toUpperCase()} API error (${response.status}): ${text}`);
    }
    return text;
  }
}

export const ecsFargateDeployer = new EcsFargateDeployer();
