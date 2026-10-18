import fs from 'fs';
import path from 'path';
import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateOriginAccessControlCommand,
  DeleteDistributionCommand,
  DeleteOriginAccessControlCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetOriginAccessControlCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  BucketLocationConstraint,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AnalysisResult, DeploymentRecord, TrackedAwsResources } from '../types/deployment';
import { DeployContext, DeployerOutput, IDeployer } from './baseDeployer';

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
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export class S3CloudFrontDeployer implements IDeployer {
  public readonly target = 'S3_CLOUDFRONT' as const;

  public validateCompatibility(analysis: AnalysisResult): {
    compatible: boolean;
    reason?: string;
    remediation?: string;
  } {
    if (
      analysis.applicationType === 'node-server' ||
      analysis.applicationType === 'python-service' ||
      analysis.applicationType === 'serverless-api'
    ) {
      return {
        compatible: false,
        reason: `Repository was detected as "${analysis.framework}" (${analysis.applicationType}), which requires a server runtime and cannot run on static S3 + CloudFront hosting.`,
        remediation: 'Submit a static React/Vite frontend repository for Phase 1.',
      };
    }
    return { compatible: true };
  }

  public async deploy(ctx: DeployContext): Promise<DeployerOutput> {
    const region = process.env.AWS_REGION || 'us-east-1';
    const bucketPrefix = (process.env.S3_DEPLOYMENT_BUCKET_PREFIX || 'repo2cloud-static')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
    const bucketName = `${bucketPrefix}-${ctx.deployment.deploymentId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const keyPrefix = '';

    if (ctx.dryRun) {
      return this.deployDryRun(ctx, bucketName, keyPrefix);
    }

    const s3 = new S3Client({ region });
    const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

    // Task 5: Upload generated static assets to a private S3 bucket
    ctx.onLog(`Creating private S3 bucket "${bucketName}" in ${region}...`);
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
    ctx.onResourceCreated({ s3BucketName: bucketName, s3KeyPrefix: keyPrefix });

    ctx.onLog(
      `Uploading ${ctx.buildResult.generatedFiles.length} static asset(s) to private bucket s3://${bucketName}/...`
    );
    const BATCH_SIZE = 20;
    for (let i = 0; i < ctx.buildResult.generatedFiles.length; i += BATCH_SIZE) {
      const batch = ctx.buildResult.generatedFiles.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (relFile) => {
          const fullPath = path.join(ctx.buildResult.artifactDir, relFile);
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
    ctx.onLog('Uploaded all generated static assets to private S3 bucket.');

    // Task 6: Create a CloudFront distribution using S3 Origin Access Control (OAC)
    const oacName = `oac-${ctx.deployment.deploymentId}-${Date.now()}`;
    ctx.onLog(`Creating CloudFront Origin Access Control (${oacName})...`);
    const oacRes = await cloudfront.send(
      new CreateOriginAccessControlCommand({
        OriginAccessControlConfig: {
          Name: oacName,
          Description: `OAC for Repo2Cloud deployment ${ctx.deployment.deploymentId}`,
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
    const originId = `s3-origin-${ctx.deployment.deploymentId}`;
    const hasRealCustomDomainCert = Boolean(
      ctx.deployment.customHostname &&
        ctx.acmCertificateArn &&
        !ctx.acmCertificateArn.includes('123456789012')
    );

    if (ctx.deployment.customHostname && !hasRealCustomDomainCert) {
      ctx.onLog(
        `Note: "${ctx.deployment.customHostname}" uses a demo placeholder ACM ARN; provisioning live CloudFront distribution with default *.cloudfront.net TLS certificate.`
      );
    }

    ctx.onLog(
      `Creating CloudFront distribution linked to S3 origin ${s3OriginDomain}${
        hasRealCustomDomainCert ? ` with custom alias ${ctx.deployment.customHostname}` : ''
      } via OAC...`
    );
    const distRes = await cloudfront.send(
      new CreateDistributionCommand({
        DistributionConfig: {
          CallerReference: `${ctx.deployment.deploymentId}-${Date.now()}`,
          Comment: `Repo2Cloud static deployment for ${ctx.deployment.repoUrl}`,
          Enabled: true,
          DefaultRootObject: 'index.html',
          Aliases: hasRealCustomDomainCert
            ? {
                Quantity: 1,
                Items: [ctx.deployment.customHostname!],
              }
            : { Quantity: 0 },
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: originId,
                DomainName: s3OriginDomain,
                OriginAccessControlId: oacId,
                S3OriginConfig: {
                  OriginAccessIdentity: '',
                },
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: originId,
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
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
          },
          CustomErrorResponses: {
            Quantity: 2,
            Items: [
              {
                ErrorCode: 403,
                ResponsePagePath: '/index.html',
                ResponseCode: '200',
                ErrorCachingMinTTL: 10,
              },
              {
                ErrorCode: 404,
                ResponsePagePath: '/index.html',
                ResponseCode: '200',
                ErrorCachingMinTTL: 10,
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

    // Attach S3 Bucket Policy allowing ONLY this CloudFront distribution ARN via OAC
    ctx.onLog(`Attaching S3 bucket policy granting s3:GetObject to CloudFront distribution ${distributionId}...`);
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

    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucketName,
        Policy: JSON.stringify(bucketPolicy),
      })
    );

    // Task 7: Wait for CloudFront deployment
    ctx.onLog(`Waiting for CloudFront distribution ${distributionId} status to reach "Deployed"...`);
    for (let poll = 0; poll < 45; poll++) {
      const getRes = await cloudfront.send(
        new GetDistributionCommand({ Id: distributionId })
      );
      if (getRes.Distribution?.Status === 'Deployed') {
        ctx.onLog(`CloudFront distribution ${distributionId} is Deployed at https://${cloudFrontDomainName}.`);
        break;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }

    const resources: Partial<TrackedAwsResources> = {
      s3BucketName: bucketName,
      s3KeyPrefix: keyPrefix,
      cloudFrontDistributionId: distributionId,
      cloudFrontDomainName,
      cloudFrontOacId: oacId,
    };

    return {
      infrastructureUrl: `https://${cloudFrontDomainName}`,
      targetDnsName: cloudFrontDomainName,
      targetHostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
      resources,
    };
  }

  private async deployDryRun(
    ctx: DeployContext,
    bucketName: string,
    keyPrefix: string
  ): Promise<DeployerOutput> {
    const shortHash = ctx.deployment.deploymentId.replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
    const oacId = `E2OAC${shortHash.toUpperCase()}`;
    const distributionId = `E3CF${shortHash.toUpperCase()}`;
    const cloudFrontDomainName = `d${shortHash}.cloudfront.net`;

    ctx.onLog(
      `[DryRun] Task 5: Created private S3 bucket "${bucketName}" with BlockPublicAccess=true.`
    );
    ctx.onLog(
      `[DryRun] Task 5: Uploaded ${ctx.buildResult.generatedFiles.length} static asset(s) (${ctx.buildResult.generatedFiles.join(
        ', '
      )}) to s3://${bucketName}/.`
    );
    ctx.onLog(
      `[DryRun] Task 6: Created CloudFront Origin Access Control (${oacId}) with sigv4 signing and scoped S3 bucket policy.`
    );
    ctx.onLog(
      `[DryRun] Task 6 & 7: Created CloudFront distribution ${distributionId} and waited until Status="Deployed" (https://${cloudFrontDomainName}).`
    );

    const resources: Partial<TrackedAwsResources> = {
      s3BucketName: bucketName,
      s3KeyPrefix: keyPrefix,
      cloudFrontDistributionId: distributionId,
      cloudFrontDomainName,
      cloudFrontOacId: oacId,
    };
    ctx.onResourceCreated(resources);

    return {
      infrastructureUrl: `https://${cloudFrontDomainName}`,
      targetDnsName: cloudFrontDomainName,
      targetHostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
      resources,
    };
  }

  public async cleanup(
    record: DeploymentRecord,
    dryRun: boolean,
    onLog: (message: string) => void
  ): Promise<void> {
    const { s3BucketName, cloudFrontDistributionId, cloudFrontOacId } = record.resources;
    if (dryRun) {
      if (cloudFrontDistributionId) {
        onLog(`[DryRun] Disabled and deleted CloudFront distribution ${cloudFrontDistributionId}.`);
      }
      if (cloudFrontOacId) {
        onLog(`[DryRun] Deleted CloudFront Origin Access Control ${cloudFrontOacId}.`);
      }
      if (s3BucketName) {
        onLog(`[DryRun] Emptied and deleted private S3 bucket ${s3BucketName}.`);
      }
      return;
    }

    const region = process.env.AWS_REGION || 'us-east-1';

    // 1. Disable & delete CloudFront distribution if present
    if (cloudFrontDistributionId) {
      const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
      try {
        const cfgRes = await cloudfront.send(
          new GetDistributionConfigCommand({ Id: cloudFrontDistributionId })
        );
        let etag = cfgRes.ETag;
        const distConfig = cfgRes.DistributionConfig;

        if (distConfig && distConfig.Enabled) {
          onLog(`Disabling CloudFront distribution ${cloudFrontDistributionId}...`);
          distConfig.Enabled = false;
          const updateRes = await cloudfront.send(
            new UpdateDistributionCommand({
              Id: cloudFrontDistributionId,
              IfMatch: etag,
              DistributionConfig: distConfig,
            })
          );
          etag = updateRes.ETag;
          onLog(
            `CloudFront distribution ${cloudFrontDistributionId} disabled. Waiting for global edge propagation before deletion...`
          );

          for (let i = 0; i < 45; i++) {
            const getRes = await cloudfront.send(
              new GetDistributionCommand({ Id: cloudFrontDistributionId })
            );
            etag = getRes.ETag;
            if (getRes.Distribution?.Status === 'Deployed') {
              break;
            }
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
        const msg = err instanceof Error ? err.message : String(err);
        onLog(`CloudFront distribution cleanup note: ${msg}`);
      }
    }

    // 2. Delete CloudFront Origin Access Control (OAC)
    if (cloudFrontOacId) {
      const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
      try {
        const oacRes = await cloudfront.send(
          new GetOriginAccessControlCommand({ Id: cloudFrontOacId })
        );
        await cloudfront.send(
          new DeleteOriginAccessControlCommand({
            Id: cloudFrontOacId,
            IfMatch: oacRes.ETag,
          })
        );
        onLog(`Deleted CloudFront Origin Access Control ${cloudFrontOacId}.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        onLog(`CloudFront OAC cleanup note: ${msg}`);
      }
    }

    // 3. Empty and delete the private S3 bucket
    if (s3BucketName) {
      const s3 = new S3Client({ region });
      try {
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: s3BucketName }));
        for (const obj of listed.Contents || []) {
          if (obj.Key) {
            await s3.send(new DeleteObjectCommand({ Bucket: s3BucketName, Key: obj.Key }));
          }
        }
        onLog(`Emptied all objects from S3 bucket ${s3BucketName}.`);

        try {
          await s3.send(new DeleteBucketPolicyCommand({ Bucket: s3BucketName }));
        } catch {
          // Ignore if bucket policy was not attached
        }

        await s3.send(new DeleteBucketCommand({ Bucket: s3BucketName }));
        onLog(`Deleted private S3 bucket ${s3BucketName}.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        onLog(`S3 bucket cleanup note: ${msg}`);
      }
    }
  }
}

export const s3CloudFrontDeployer = new S3CloudFrontDeployer();
