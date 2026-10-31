import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateOriginAccessControlCommand,
  DeleteDistributionCommand,
  DeleteOriginAccessControlCommand,
  GetDistributionCommand,
  GetOriginAccessControlCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  BucketLocationConstraint,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { isolatedBuildRunner } from '../services/isolatedBuilder';
import {
  AnalysisResult,
  DeploymentRecord,
  WorkloadArchetype,
} from '../types/deployment';
import { DeployContext, DeployerOutput, IDeployer } from './baseDeployer';
import { lambdaApiGatewayDeployer } from './lambdaApiGatewayDeployer';

const CLOUDFRONT_HOSTED_ZONE_ID = 'Z2FDTNDATAQYW2';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export class FullstackServerlessDeployer implements IDeployer {
  public readonly target = 'FULLSTACK_SERVERLESS' as const;
  public readonly archetype: WorkloadArchetype = 'STATIC_EDGE';

  public validateCompatibility(_analysis: AnalysisResult): {
    compatible: boolean;
    reason?: string;
    remediation?: string;
  } {
    return { compatible: true };
  }

  public async deploy(ctx: DeployContext): Promise<DeployerOutput> {
    const region = process.env.AWS_REGION || 'us-east-1';
    const shortId = ctx.deployment.deploymentId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const safeRepo = ctx.deployment.repoName.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const bucketPrefix = (process.env.S3_DEPLOYMENT_BUCKET_PREFIX || 'repo2cloud-static')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    const bucketName = `${bucketPrefix}-${shortId}`;
    const functionName = `r2c-${safeRepo}-api-${shortId}`.slice(0, 64);
    const apiName = `r2c-api-${safeRepo}-${shortId}`;

    if (ctx.dryRun) {
      const mockCfId = `E${shortId.toUpperCase()}FS`;
      const mockCfDomain = `d${shortId.slice(0, 10)}.cloudfront.net`;
      const mockRoleArn = `arn:aws:iam::123456789012:role/repo2cloud-lambda-exec-role`;
      const mockApiId = `api${shortId.slice(0, 7)}`;
      const mockApiDomain = `${mockApiId}.execute-api.${region}.amazonaws.com`;
      const mockApiEndpoint = `https://${mockApiDomain}`;

      ctx.onLog(
        `[DryRun] Phase 10: Created private S3 bucket s3://${bucketName}/ and uploaded static frontend assets.`
      );
      ctx.onResourceCreated({ s3BucketName: bucketName, s3KeyPrefix: '' });

      ctx.onLog(
        `[DryRun] Phase 10: Packaged and deployed AWS Lambda Function "${functionName}" (Express via serverless-http).`
      );
      ctx.onResourceCreated({
        lambdaFunctionName: functionName,
        lambdaRoleArn: mockRoleArn,
      });

      ctx.onLog(
        `[DryRun] Phase 10: Provisioned Amazon API Gateway v2 HTTP API "${apiName}" ($default route -> ${functionName}).`
      );
      ctx.onResourceCreated({
        apiGatewayId: mockApiId,
        apiGatewayEndpoint: mockApiEndpoint,
      });

      ctx.onLog(
        `[DryRun] Phase 10: Created CloudFront Distribution (${mockCfId}) with dual origins: /* -> S3 (OAC) and /api/* -> API Gateway (${mockApiDomain}).`
      );
      ctx.onResourceCreated({
        cloudFrontDistributionId: mockCfId,
        cloudFrontDomainName: mockCfDomain,
      });

      return {
        infrastructureUrl: `https://${mockCfDomain}`,
        targetDnsName: mockCfDomain,
        targetHostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
        resources: {
          s3BucketName: bucketName,
          cloudFrontDistributionId: mockCfId,
          cloudFrontDomainName: mockCfDomain,
          lambdaFunctionName: functionName,
          lambdaRoleArn: mockRoleArn,
          apiGatewayId: mockApiId,
          apiGatewayEndpoint: mockApiEndpoint,
        },
      };
    }

    // ========================================================================
    // Live AWS Mode
    // 1. Upload Static Frontend to Private S3 Bucket
    // 2. Deploy Backend API to AWS Lambda + Amazon API Gateway v2
    // 3. Create Multi-Origin CloudFront Distribution (/* -> S3, /api/* -> API GW)
    // ========================================================================
    const s3 = new S3Client({ region });
    const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

    ctx.onLog(`Creating private S3 bucket "${bucketName}" in ${region}...`);
    try {
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucketName,
          ...(region !== 'us-east-1'
            ? {
                CreateBucketConfiguration: {
                  LocationConstraint: region as BucketLocationConstraint,
                },
              }
            : {}),
        })
      );
      await s3.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        })
      );
    } catch (err: unknown) {
      ctx.onLog(`S3 bucket notice: ${err instanceof Error ? err.message : String(err)}`);
    }
    ctx.onResourceCreated({ s3BucketName: bucketName, s3KeyPrefix: '' });

    // Determine frontend static export directory
    let staticDir = ctx.buildResult.artifactDir;
    const candidates = [
      path.join(ctx.buildResult.repoDir, 'frontend', 'out'),
      path.join(ctx.buildResult.repoDir, 'out'),
      path.join(ctx.buildResult.repoDir, 'dist'),
      ctx.buildResult.artifactDir,
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'index.html'))) {
        staticDir = c;
        break;
      }
    }

    const filesToUpload = this.listFilesRecursively(staticDir, staticDir);
    ctx.onLog(
      `Uploading ${filesToUpload.length} static frontend asset(s) to private S3 bucket s3://${bucketName}/...`
    );

    const BATCH_SIZE = 20;
    for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
      const batch = filesToUpload.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (relFile) => {
          const fullPath = path.join(staticDir, relFile);
          const s3Key = relFile.split(path.sep).join('/');
          const ext = path.extname(relFile).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          const cacheControl =
            ext === '.html'
              ? 'public, max-age=0, must-revalidate'
              : 'public, max-age=31536000, immutable';

          const body = fs.readFileSync(fullPath);
          return s3.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: s3Key,
              Body: body,
              ContentType: contentType,
              CacheControl: cacheControl,
            })
          );
        })
      );
    }
    ctx.onLog('Uploaded static frontend assets to private S3 bucket.');

    // Step 2: Deploy Backend to Lambda + API Gateway v2
    ctx.onLog(
      `Phase 10: Packaging and deploying serverless Express API to AWS Lambda (${functionName})...`
    );
    const lambdaDeployOutput = await lambdaApiGatewayDeployer.deploy({
      ...ctx,
      deployment: {
        ...ctx.deployment,
        targetConfig: {
          ...ctx.deployment.targetConfig,
          lambdaHandler: 'backend/dist/lambda.handler',
          runtime: 'nodejs20.x',
        },
      },
    });

    const apiGatewayEndpoint = lambdaDeployOutput.resources.apiGatewayEndpoint;
    const apiGatewayDomain = lambdaDeployOutput.targetDnsName;
    const lambdaRoleArn = lambdaDeployOutput.resources.lambdaRoleArn;
    const apiGatewayId = lambdaDeployOutput.resources.apiGatewayId;

    ctx.onResourceCreated({
      lambdaFunctionName: functionName,
      lambdaRoleArn,
      apiGatewayId,
      apiGatewayEndpoint,
    });

    // Step 3: CloudFront Distribution with Dual Origins
    const oacName = `oac-${shortId}-${Date.now()}`;
    ctx.onLog(`Creating CloudFront Origin Access Control (${oacName})...`);
    const oacRes = await cloudfront.send(
      new CreateOriginAccessControlCommand({
        OriginAccessControlConfig: {
          Name: oacName,
          Description: `OAC for fullstack deployment ${ctx.deployment.deploymentId}`,
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      })
    );
    const oacId = oacRes.OriginAccessControl?.Id;
    if (!oacId) {
      throw new Error('Failed to create CloudFront Origin Access Control.');
    }
    ctx.onResourceCreated({ cloudFrontOacId: oacId });

    const s3OriginDomain = `${bucketName}.s3.${region}.amazonaws.com`;
    const s3OriginId = `s3-static-${shortId}`;
    const apiOriginId = `apigw-api-${shortId}`;
    const hasRealCustomDomainCert = Boolean(
      ctx.deployment.customHostname &&
        ctx.acmCertificateArn &&
        !ctx.acmCertificateArn.includes('123456789012')
    );

    ctx.onLog(
      `Creating multi-origin CloudFront distribution (/* -> S3, /api/* -> ${apiGatewayDomain})...`
    );

    const distRes = await cloudfront.send(
      new CreateDistributionCommand({
        DistributionConfig: {
          CallerReference: `${ctx.deployment.deploymentId}-${Date.now()}`,
          Comment: `DeployMate Full-Stack Serverless for ${ctx.deployment.repoUrl}`,
          Enabled: true,
          DefaultRootObject: 'index.html',
          Aliases: hasRealCustomDomainCert
            ? {
                Quantity: 1,
                Items: [ctx.deployment.customHostname!],
              }
            : { Quantity: 0 },
          Origins: {
            Quantity: 2,
            Items: [
              {
                Id: s3OriginId,
                DomainName: s3OriginDomain,
                OriginAccessControlId: oacId,
                S3OriginConfig: {
                  OriginAccessIdentity: '',
                },
              },
              {
                Id: apiOriginId,
                DomainName: apiGatewayDomain,
                CustomOriginConfig: {
                  HTTPPort: 80,
                  HTTPSPort: 443,
                  OriginProtocolPolicy: 'https-only',
                  OriginSslProtocols: {
                    Quantity: 1,
                    Items: ['TLSv1.2'],
                  },
                },
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: s3OriginId,
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: {
              Quantity: 2,
              Items: ['GET', 'HEAD'],
              CachedMethods: {
                Quantity: 2,
                Items: ['GET', 'HEAD'],
              },
            },
            Compress: true,
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // Managed CachingOptimized
          },
          CacheBehaviors: {
            Quantity: 1,
            Items: [
              {
                PathPattern: '/api/*',
                TargetOriginId: apiOriginId,
                ViewerProtocolPolicy: 'redirect-to-https',
                AllowedMethods: {
                  Quantity: 7,
                  Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
                  CachedMethods: {
                    Quantity: 2,
                    Items: ['GET', 'HEAD'],
                  },
                },
                Compress: true,
                CachePolicyId: '4135ea2d-6df8-44a3-9df3-447a4428a86f', // Managed CachingDisabled
                OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // Managed AllViewerExceptHostHeader
              },
            ],
          },
          CustomErrorResponses: {
            Quantity: 2,
            Items: [
              {
                ErrorCode: 403,
                ResponsePagePath: '/index.html',
                ResponseCode: '200',
                ErrorCachingMinTTL: 5,
              },
              {
                ErrorCode: 404,
                ResponsePagePath: '/index.html',
                ResponseCode: '200',
                ErrorCachingMinTTL: 5,
              },
            ],
          },
          ViewerCertificate: hasRealCustomDomainCert
            ? {
                ACMCertificateArn: ctx.acmCertificateArn,
                SSLSupportMethod: 'sni-only',
                MinimumProtocolVersion: 'TLSv1.2_2021',
              }
            : {
                CloudFrontDefaultCertificate: true,
              },
        },
      })
    );

    const distributionId = distRes.Distribution?.Id;
    const distributionArn = distRes.Distribution?.ARN;
    const cloudFrontDomainName = distRes.Distribution?.DomainName;

    if (!distributionId || !cloudFrontDomainName || !distributionArn) {
      throw new Error('CloudFront did not return distribution details.');
    }

    ctx.onResourceCreated({
      cloudFrontDistributionId: distributionId,
      cloudFrontDomainName,
    });

    // Grant CloudFront OAC permission to S3
    const bucketPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowCloudFrontServicePrincipalReadOnly',
          Effect: 'Allow',
          Principal: {
            Service: 'cloudfront.amazonaws.com',
          },
          Action: 's3:GetObject',
          Resource: `arn:aws:s3:::${bucketName}/*`,
          Condition: {
            StringEquals: {
              'AWS:SourceArn': distributionArn,
            },
          },
        },
      ],
    };

    try {
      await s3.send(
        new PutBucketPolicyCommand({
          Bucket: bucketName,
          Policy: JSON.stringify(bucketPolicy),
        })
      );
    } catch (err: unknown) {
      ctx.onLog(`S3 bucket policy note: ${err instanceof Error ? err.message : String(err)}`);
    }

    ctx.onLog(
      `Successfully provisioned Zero-Cost Full-Stack Serverless distribution (${distributionId}) at https://${cloudFrontDomainName}.`
    );

    return {
      infrastructureUrl: `https://${cloudFrontDomainName}`,
      targetDnsName: cloudFrontDomainName,
      targetHostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
      resources: {
        s3BucketName: bucketName,
        cloudFrontDistributionId: distributionId,
        cloudFrontDomainName,
        lambdaFunctionName: functionName,
        lambdaRoleArn,
        apiGatewayId,
        apiGatewayEndpoint,
      },
    };
  }

  public async cleanup(
    deployment: DeploymentRecord,
    dryRun: boolean,
    onLog: (msg: string) => void
  ): Promise<void> {
    const {
      cloudFrontDistributionId,
      cloudFrontOacId,
      s3BucketName,
      apiGatewayId,
      lambdaFunctionName,
    } = deployment.resources;
    const region = process.env.AWS_REGION || 'us-east-1';

    if (dryRun) {
      if (cloudFrontDistributionId) onLog(`[DryRun] Disabled and deleted CloudFront distribution ${cloudFrontDistributionId}.`);
      if (cloudFrontOacId) onLog(`[DryRun] Deleted CloudFront Origin Access Control ${cloudFrontOacId}.`);
      if (s3BucketName) onLog(`[DryRun] Emptied and deleted private S3 bucket ${s3BucketName}.`);
      if (apiGatewayId) onLog(`[DryRun] Deleted Amazon API Gateway v2 HTTP API ${apiGatewayId}.`);
      if (lambdaFunctionName) onLog(`[DryRun] Deleted AWS Lambda Function ${lambdaFunctionName}.`);
      return;
    }

    // 1. CloudFront Distribution teardown
    if (cloudFrontDistributionId) {
      const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
      try {
        const getRes = await cloudfront.send(new GetDistributionCommand({ Id: cloudFrontDistributionId }));
        let etag = getRes.ETag;
        if (getRes.Distribution?.DistributionConfig?.Enabled) {
          const disabledConfig = {
            ...getRes.Distribution.DistributionConfig,
            Enabled: false,
          };
          const updateRes = await cloudfront.send(
            new UpdateDistributionCommand({
              Id: cloudFrontDistributionId,
              DistributionConfig: disabledConfig,
              IfMatch: etag,
            })
          );
          etag = updateRes.ETag;
          onLog(`Disabled CloudFront distribution ${cloudFrontDistributionId}; waiting for Deployed state...`);
          for (let poll = 0; poll < 30; poll++) {
            const check = await cloudfront.send(new GetDistributionCommand({ Id: cloudFrontDistributionId }));
            etag = check.ETag;
            if (check.Distribution?.Status === 'Deployed') break;
            await new Promise((r) => setTimeout(r, 4000));
          }
        }
        await cloudfront.send(
          new DeleteDistributionCommand({
            Id: cloudFrontDistributionId,
            IfMatch: etag,
          })
        );
        onLog(`Deleted CloudFront distribution ${cloudFrontDistributionId}.`);
      } catch (err: unknown) {
        onLog(`CloudFront cleanup note: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. CloudFront OAC teardown
    if (cloudFrontOacId) {
      const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
      try {
        const oacRes = await cloudfront.send(new GetOriginAccessControlCommand({ Id: cloudFrontOacId }));
        await cloudfront.send(
          new DeleteOriginAccessControlCommand({
            Id: cloudFrontOacId,
            IfMatch: oacRes.ETag,
          })
        );
        onLog(`Deleted CloudFront OAC ${cloudFrontOacId}.`);
      } catch (err: unknown) {
        onLog(`OAC cleanup note: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. S3 Bucket teardown
    if (s3BucketName) {
      const s3 = new S3Client({ region });
      try {
        let continuationToken: string | undefined;
        do {
          const listed = await s3.send(
            new ListObjectsV2Command({ Bucket: s3BucketName, ContinuationToken: continuationToken })
          );
          const keys = (listed.Contents || []).filter((o) => Boolean(o.Key)).map((o) => ({ Key: o.Key as string }));
          if (keys.length > 0) {
            await s3.send(new DeleteObjectsCommand({ Bucket: s3BucketName, Delete: { Objects: keys, Quiet: true } }));
          }
          continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (continuationToken);

        try {
          await s3.send(new DeleteBucketPolicyCommand({ Bucket: s3BucketName }));
        } catch {
          // ignore
        }
        await s3.send(new DeleteBucketCommand({ Bucket: s3BucketName }));
        onLog(`Deleted private S3 bucket ${s3BucketName}.`);
      } catch (err: unknown) {
        onLog(`S3 cleanup note: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. API Gateway & Lambda teardown
    await lambdaApiGatewayDeployer.cleanup(deployment, false, onLog);
  }

  private listFilesRecursively(dir: string, rootDir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const IGNORED = new Set(['node_modules', '.git', '.next', '.cache']);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.listFilesRecursively(full, rootDir));
      } else {
        results.push(path.relative(rootDir, full));
      }
    }
    return results;
  }
}

export const fullstackServerlessDeployer = new FullstackServerlessDeployer();
