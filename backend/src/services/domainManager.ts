import crypto from 'crypto';
import https from 'https';
import { ConfiguredDomain, DeploymentTarget } from '../types/deployment';

/**
 * Official AWS Global Hosted Zone ID for CloudFront Alias records in Route 53.
 */
export const CLOUDFRONT_HOSTED_ZONE_ID = 'Z2FDTNDATAQYW2';

const DEMO_PLACEHOLDER_ZONES = new Set([
  'Z0123456789ABCDEF',
  'Z9876543210FEDCBA',
  'Z0000000000DEMO',
]);

export interface DomainProvisionResult {
  customHostname: string;
  acmCertificateArn: string;
  route53HostedZoneId: string;
  route53RecordName: string;
  route53TargetDnsName: string;
  route53TargetHostedZoneId: string;
  httpsUrl: string;
}

export class SharedDomainManager {
  public isPlaceholderDomainConfig(domainConfig?: ConfiguredDomain): boolean {
    if (!domainConfig) return true;
    return DEMO_PLACEHOLDER_ZONES.has(domainConfig.hostedZoneId);
  }

  /**
   * Phase 2 Task 4: Request or configure a TLS certificate in ACM for the hostname.
   * For CloudFront, the certificate MUST be in us-east-1.
   */
  public async ensureTlsCertificate(params: {
    subdomain: string;
    domainConfig: ConfiguredDomain;
    target: DeploymentTarget;
    dryRun: boolean;
    onLog?: (msg: string) => void;
  }): Promise<string> {
    const fullHostname = `${params.subdomain}.${params.domainConfig.domain}`;
    const forCloudFront =
      params.target === 'S3_CLOUDFRONT' || params.target === 'AMPLIFY';
    const region = forCloudFront ? 'us-east-1' : process.env.AWS_REGION || 'us-east-1';

    if (params.dryRun || this.isPlaceholderDomainConfig(params.domainConfig)) {
      const mockArn =
        params.domainConfig.acmCertificateArn ||
        `arn:aws:acm:us-east-1:123456789012:certificate/acm-${params.subdomain}-${Date.now()}`;
      params.onLog?.(
        `[DryRun / Demo Zone] Task 4: Configured ACM TLS certificate in us-east-1 (${mockArn}) for ${fullHostname}.`
      );
      return mockArn;
    }

    // If a pre-validated wildcard ACM certificate ARN in us-east-1 is configured, reuse it
    if (
      params.domainConfig.acmCertificateArn &&
      !params.domainConfig.acmCertificateArn.includes('123456789012')
    ) {
      params.onLog?.(
        `Task 4: Using configured wildcard ACM certificate in us-east-1 (${params.domainConfig.acmCertificateArn}) for ${fullHostname}.`
      );
      return params.domainConfig.acmCertificateArn;
    }

    // Check ACM in us-east-1 for an existing ISSUED certificate covering fullHostname or *.domain
    const wildcardDomain = `*.${params.domainConfig.domain}`;
    try {
      const listRaw = await this.signedAwsRequest({
        service: 'acm',
        region,
        method: 'POST',
        host: `acm.${region}.amazonaws.com`,
        path: '/',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'CertificateManager.ListCertificates',
        },
        body: JSON.stringify({ CertificateStatuses: ['ISSUED'] }),
      });
      const listParsed = JSON.parse(listRaw) as {
        CertificateSummaryList?: Array<{
          CertificateArn?: string;
          DomainName?: string;
          SubjectAlternativeNameSummaries?: string[];
        }>;
      };
      const existing = listParsed.CertificateSummaryList?.find(
        (c) =>
          c.DomainName === fullHostname ||
          c.DomainName === wildcardDomain ||
          c.SubjectAlternativeNameSummaries?.includes(fullHostname) ||
          c.SubjectAlternativeNameSummaries?.includes(wildcardDomain)
      );
      if (existing?.CertificateArn) {
        params.onLog?.(
          `Task 4: Found existing ISSUED ACM certificate in ${region} (${existing.CertificateArn}) covering ${fullHostname}.`
        );
        return existing.CertificateArn;
      }
    } catch {
      // Fall through to requesting a new certificate
    }

    params.onLog?.(
      `Task 4: Requesting wildcard ACM TLS certificate (${wildcardDomain}) in ${region} (CloudFront requires us-east-1) for ${fullHostname}...`
    );

    const reqPayload = JSON.stringify({
      DomainName: wildcardDomain,
      SubjectAlternativeNames: [params.domainConfig.domain],
      ValidationMethod: 'DNS',
    });

    const reqRes = await this.signedAwsRequest({
      service: 'acm',
      region,
      method: 'POST',
      host: `acm.${region}.amazonaws.com`,
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'CertificateManager.RequestCertificate',
      },
      body: reqPayload,
    });

    const parsedReq = JSON.parse(reqRes) as { CertificateArn?: string };
    const certificateArn = parsedReq.CertificateArn;
    if (!certificateArn) {
      throw new Error(`ACM did not return a CertificateArn for ${wildcardDomain}.`);
    }

    // Poll ACM for the DNS validation CNAME record
    let validationName: string | undefined;
    let validationValue: string | undefined;

    for (let attempt = 0; attempt < 10; attempt++) {
      const descRaw = await this.signedAwsRequest({
        service: 'acm',
        region,
        method: 'POST',
        host: `acm.${region}.amazonaws.com`,
        path: '/',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'CertificateManager.DescribeCertificate',
        },
        body: JSON.stringify({ CertificateArn: certificateArn }),
      });

      const desc = JSON.parse(descRaw) as {
        Certificate?: {
          Status?: string;
          DomainValidationOptions?: Array<{
            ResourceRecord?: { Name?: string; Value?: string };
          }>;
        };
      };

      const record = desc.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
      if (record?.Name && record?.Value) {
        validationName = record.Name;
        validationValue = record.Value;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (validationName && validationValue) {
      params.onLog?.(
        `Task 4: Upserting ACM DNS validation CNAME (${validationName}) in Route 53 zone ${params.domainConfig.hostedZoneId}...`
      );
      await this.changeRoute53RecordXml(
        params.domainConfig.hostedZoneId,
        `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Comment>ACM DNS validation for ${fullHostname}</Comment>
    <Changes>
      <Change>
        <Action>UPSERT</Action>
        <ResourceRecordSet>
          <Name>${validationName}</Name>
          <Type>CNAME</Type>
          <TTL>60</TTL>
          <ResourceRecords>
            <ResourceRecord><Value>${validationValue}</Value></ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`
      );
    }

    params.onLog?.(`Task 7: Polling ACM certificate ${certificateArn} until status is ISSUED...`);
    for (let poll = 0; poll < 35; poll++) {
      const descRaw = await this.signedAwsRequest({
        service: 'acm',
        region,
        method: 'POST',
        host: `acm.${region}.amazonaws.com`,
        path: '/',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'CertificateManager.DescribeCertificate',
        },
        body: JSON.stringify({ CertificateArn: certificateArn }),
      });

      const desc = JSON.parse(descRaw) as {
        Certificate?: { Status?: string };
      };
      const status = desc.Certificate?.Status;
      if (status === 'ISSUED') {
        params.onLog?.(`ACM TLS certificate validated and ISSUED for ${fullHostname}.`);
        return certificateArn;
      }
      if (status === 'FAILED' || status === 'REVOKED') {
        throw new Error(`ACM certificate validation failed with status: ${status}`);
      }
      await new Promise((r) => setTimeout(r, 4000));
    }

    throw new Error(
      `Timed out waiting for ACM certificate validation for ${fullHostname}. Tip: pre-validate a wildcard ACM cert (*.${params.domainConfig.domain}) in us-east-1 for instant attachment.`
    );
  }

  /**
   * Phase 2 Tasks 6 & 7: Create the Route 53 Alias record pointing to CloudFront
   * and poll until DNS readiness is INSYNC.
   */
  public async configureRoute53AliasRecord(params: {
    subdomain: string;
    domainConfig: ConfiguredDomain;
    targetDnsName: string;
    targetHostedZoneId?: string;
    acmCertificateArn: string;
    dryRun: boolean;
    onLog?: (msg: string) => void;
  }): Promise<DomainProvisionResult> {
    const customHostname = `${params.subdomain}.${params.domainConfig.domain}`;
    const targetHostedZoneId = params.targetHostedZoneId || CLOUDFRONT_HOSTED_ZONE_ID;
    const normalizedTargetDns = params.targetDnsName
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    const dnsWithDot = normalizedTargetDns.endsWith('.')
      ? normalizedTargetDns
      : `${normalizedTargetDns}.`;

    if (params.dryRun || this.isPlaceholderDomainConfig(params.domainConfig)) {
      params.onLog?.(
        `[DryRun / Demo Zone] Task 6: Created Route 53 ALIAS A record: ${customHostname} -> ${dnsWithDot} (Zone: ${params.domainConfig.hostedZoneId}).`
      );
      params.onLog?.(
        `[DryRun / Demo Zone] Task 7: Route 53 DNS status INSYNC for ${customHostname}.`
      );
      return {
        customHostname,
        acmCertificateArn: params.acmCertificateArn,
        route53HostedZoneId: params.domainConfig.hostedZoneId,
        route53RecordName: customHostname,
        route53TargetDnsName: normalizedTargetDns,
        route53TargetHostedZoneId: targetHostedZoneId,
        httpsUrl: `https://${customHostname}`,
      };
    }

    params.onLog?.(
      `Task 6: Creating Route 53 Alias record ${customHostname} -> ${dnsWithDot} in Hosted Zone ${params.domainConfig.hostedZoneId}...`
    );

    const xmlRes = await this.changeRoute53RecordXml(
      params.domainConfig.hostedZoneId,
      `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Comment>Repo2Cloud Phase 2 Alias for ${customHostname}</Comment>
    <Changes>
      <Change>
        <Action>UPSERT</Action>
        <ResourceRecordSet>
          <Name>${customHostname}</Name>
          <Type>A</Type>
          <AliasTarget>
            <HostedZoneId>${targetHostedZoneId}</HostedZoneId>
            <DNSName>${dnsWithDot}</DNSName>
            <EvaluateTargetHealth>false</EvaluateTargetHealth>
          </AliasTarget>
        </ResourceRecordSet>
      </Change>
      <Change>
        <Action>UPSERT</Action>
        <ResourceRecordSet>
          <Name>${customHostname}</Name>
          <Type>AAAA</Type>
          <AliasTarget>
            <HostedZoneId>${targetHostedZoneId}</HostedZoneId>
            <DNSName>${dnsWithDot}</DNSName>
            <EvaluateTargetHealth>false</EvaluateTargetHealth>
          </AliasTarget>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`
    );

    const changeIdMatch = xmlRes.match(/<Id>\/change\/([^<]+)<\/Id>/);
    const changeId = changeIdMatch?.[1];
    if (changeId) {
      params.onLog?.(`Task 7: Polling Route 53 change ${changeId} until status is INSYNC...`);
      for (let i = 0; i < 20; i++) {
        const getXml = await this.signedAwsRequest({
          service: 'route53',
          region: 'us-east-1',
          method: 'GET',
          host: 'route53.amazonaws.com',
          path: `/2013-04-01/change/${changeId}`,
          headers: {},
          body: '',
        });
        if (getXml.includes('<Status>INSYNC</Status>')) {
          params.onLog?.(`Task 7: Route 53 Alias record for ${customHostname} is INSYNC.`);
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    return {
      customHostname,
      acmCertificateArn: params.acmCertificateArn,
      route53HostedZoneId: params.domainConfig.hostedZoneId,
      route53RecordName: customHostname,
      route53TargetDnsName: normalizedTargetDns,
      route53TargetHostedZoneId: targetHostedZoneId,
      httpsUrl: `https://${customHostname}`,
    };
  }

  /**
   * Phase 2 Task 8: Verify that the HTTPS URL works over TLS before marking LIVE.
   */
  public async verifyHttpsEndpoint(
    url: string,
    dryRun: boolean,
    isPlaceholderZone: boolean,
    fallbackCloudFrontUrl: string,
    onLog?: (msg: string) => void
  ): Promise<void> {
    if (dryRun) {
      onLog?.(`[DryRun] Task 8: Verified HTTPS 200 OK and valid TLS certificate at ${url}.`);
      return;
    }

    const urlToVerify = isPlaceholderZone ? fallbackCloudFrontUrl : url;
    onLog?.(`Task 8: Verifying live HTTPS reachability at ${urlToVerify}...`);

    for (let attempt = 1; attempt <= 12; attempt++) {
      // For custom subdomains, verify TLS SNI + Host header directly against the CloudFront edge first
      // so the backend never triggers a premature OS DNS lookup that could cache NXDOMAIN on local VPN DNS.
      if (urlToVerify !== fallbackCloudFrontUrl && fallbackCloudFrontUrl) {
        const sniStatus = await this.verifyCustomDomainViaCloudFrontSni(
          urlToVerify,
          fallbackCloudFrontUrl
        );
        if (sniStatus && sniStatus >= 200 && sniStatus < 500) {
          onLog?.(
            `Task 8: Verified ${urlToVerify} TLS certificate (SNI) and HTTP ${sniStatus} via CloudFront edge.`
          );
          return;
        }
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(urlToVerify, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.status >= 200 && res.status < 500) {
          onLog?.(`Task 8: Verified ${urlToVerify} responded over HTTPS with HTTP ${res.status}.`);
          return;
        }
      } catch {
        // Retry while DNS/CloudFront edge propagates
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    throw new Error(`Endpoint ${urlToVerify} did not respond over HTTPS within verification window.`);
  }

  private verifyCustomDomainViaCloudFrontSni(
    customHttpsUrl: string,
    cloudFrontHttpsUrl: string
  ): Promise<number | null> {
    return new Promise((resolve) => {
      try {
        const customHost = new URL(customHttpsUrl).hostname;
        const cfHost = new URL(cloudFrontHttpsUrl).hostname;

        const req = https.request(
          {
            hostname: cfHost,
            port: 443,
            path: '/',
            method: 'GET',
            servername: customHost,
            headers: {
              Host: customHost,
            },
            timeout: 6000,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode || null);
          }
        );

        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
        req.end();
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Deletes the Route 53 Alias record when a deployment is cleaned up.
   */
  public async deleteRoute53AliasRecord(params: {
    hostedZoneId?: string;
    recordName?: string;
    targetDnsName?: string;
    targetHostedZoneId?: string;
    dryRun: boolean;
    onLog?: (msg: string) => void;
  }): Promise<void> {
    if (!params.hostedZoneId || !params.recordName || !params.targetDnsName) {
      return;
    }

    if (params.dryRun || DEMO_PLACEHOLDER_ZONES.has(params.hostedZoneId)) {
      params.onLog?.(
        `[DryRun / Demo Zone] Deleted Route 53 ALIAS record ${params.recordName} from zone ${params.hostedZoneId}.`
      );
      return;
    }

    const dnsName = params.targetDnsName.endsWith('.')
      ? params.targetDnsName
      : `${params.targetDnsName}.`;

    for (const recordType of ['A', 'AAAA']) {
      try {
        await this.changeRoute53RecordXml(
          params.hostedZoneId,
          `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Comment>Repo2Cloud cleanup for ${params.recordName} (${recordType})</Comment>
    <Changes>
      <Change>
        <Action>DELETE</Action>
        <ResourceRecordSet>
          <Name>${params.recordName}</Name>
          <Type>${recordType}</Type>
          <AliasTarget>
            <HostedZoneId>${params.targetHostedZoneId || CLOUDFRONT_HOSTED_ZONE_ID}</HostedZoneId>
            <DNSName>${dnsName}</DNSName>
            <EvaluateTargetHealth>false</EvaluateTargetHealth>
          </AliasTarget>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`
        );
      } catch {
        // Ignore if record type was already removed
      }
    }
    params.onLog?.(`Deleted Route 53 ALIAS A/AAAA records for ${params.recordName}.`);
  }

  private async changeRoute53RecordXml(hostedZoneId: string, xmlBody: string): Promise<string> {
    const cleanZoneId = hostedZoneId.replace(/^\/hostedzone\//, '');
    return this.signedAwsRequest({
      service: 'route53',
      region: 'us-east-1',
      method: 'POST',
      host: 'route53.amazonaws.com',
      path: `/2013-04-01/hostedzone/${cleanZoneId}/rrset`,
      headers: {
        'content-type': 'application/xml',
      },
      body: xmlBody,
    });
  }

  /**
   * Executes an AWS SigV4-signed HTTPS request against ACM or Route 53.
   */
  private async signedAwsRequest(opts: {
    service: string;
    region: string;
    method: 'GET' | 'POST';
    host: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<string> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for live Route 53 / ACM calls.');
    }

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = crypto.createHash('sha256').update(opts.body, 'utf8').digest('hex');

    const canonicalHeadersMap: Record<string, string> = {
      host: opts.host,
      'x-amz-date': amzDate,
      ...Object.fromEntries(
        Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])
      ),
    };
    if (sessionToken) {
      canonicalHeadersMap['x-amz-security-token'] = sessionToken;
    }

    const sortedHeaderKeys = Object.keys(canonicalHeadersMap).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k}:${canonicalHeadersMap[k]}\n`)
      .join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      opts.method,
      opts.path,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const hmac = (key: Buffer | string, data: string) =>
      crypto.createHmac('sha256', key).update(data, 'utf8').digest();

    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, opts.region);
    const kService = hmac(kRegion, opts.service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto
      .createHmac('sha256', kSigning)
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const requestHeaders: Record<string, string> = {
      ...canonicalHeadersMap,
      Authorization: authorizationHeader,
    };

    const res = await fetch(`https://${opts.host}${opts.path}`, {
      method: opts.method,
      headers: requestHeaders,
      body: opts.method === 'POST' ? opts.body : undefined,
    });

    const responseText = await res.text();
    if (!res.ok) {
      throw new Error(
        `AWS ${opts.service.toUpperCase()} API error (${res.status}): ${responseText.slice(0, 400)}`
      );
    }
    return responseText;
  }
}

export const sharedDomainManager = new SharedDomainManager();
