'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  createStaticDeployment,
  deleteDeploymentInfrastructure,
  DeploymentRecord,
  fetchDomainsAndCheckSubdomain,
  getDeploymentStatus,
  listDeployments,
} from '@/lib/api';

export default function Phase2DeployPage() {
  const [repoUrl, setRepoUrl] = useState('https://github.com/example/vite-app');
  const [subdomain, setSubdomain] = useState('demo');
  const [domains, setDomains] = useState<Array<{ domain: string; hasWildcardCert: boolean }>>([
    { domain: 'repo2cloud.dev', hasWildcardCert: true },
    { domain: 'technica2026.cloud', hasWildcardCert: false },
  ]);
  const [selectedDomain, setSelectedDomain] = useState('repo2cloud.dev');
  const [subdomainCheck, setSubdomainCheck] = useState<{
    valid: boolean;
    available: boolean;
    customHostname?: string;
    error?: string;
  } | null>(null);

  const [deployment, setDeployment] = useState<DeploymentRecord | null>(null);
  const [history, setHistory] = useState<DeploymentRecord[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await listDeployments();
      setHistory(res.deployments);
    } catch {
      // Ignore if backend is restarting
    }
  }, []);

  // Load server-controlled domains and deployment history on mount
  useEffect(() => {
    fetchDomainsAndCheckSubdomain()
      .then((res) => {
        if (res.domains.length > 0) {
          setDomains(res.domains);
          setSelectedDomain(res.domains[0].domain);
        }
      })
      .catch(() => {});
    void refreshHistory();
  }, [refreshHistory]);

  // Live validate subdomain format & reservation availability
  useEffect(() => {
    if (!subdomain.trim()) {
      setSubdomainCheck(null);
      return;
    }
    const timer = setTimeout(() => {
      fetchDomainsAndCheckSubdomain(subdomain.trim(), selectedDomain)
        .then((res) => {
          if (res.subdomainCheck) {
            setSubdomainCheck(res.subdomainCheck);
          }
        })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [subdomain, selectedDomain]);

  // Poll GET /api/deploy/:id until status reaches LIVE, FAILED, or DELETED
  useEffect(() => {
    if (!deployment) return;
    if (
      deployment.status === 'LIVE' ||
      deployment.status === 'FAILED' ||
      deployment.status === 'DELETED'
    ) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const res = await getDeploymentStatus(deployment.deploymentId);
        setDeployment(res.deployment);
        if (
          res.deployment.status === 'LIVE' ||
          res.deployment.status === 'FAILED' ||
          res.deployment.status === 'DELETED'
        ) {
          setIsDeploying(false);
          void refreshHistory();
        }
      } catch {
        // Ignore transient polling error
      }
    }, 500);

    return () => clearInterval(timer);
  }, [deployment, refreshHistory]);

  async function handleDeploy(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsDeploying(true);
    try {
      const res = await createStaticDeployment({
        repoUrl: repoUrl.trim(),
        subdomain: subdomain.trim() || undefined,
        domain: subdomain.trim() ? selectedDomain : undefined,
      });
      setDeployment(res.deployment);
      void refreshHistory();
      if (subdomain.trim()) {
        const checkRes = await fetchDomainsAndCheckSubdomain(subdomain.trim(), selectedDomain);
        if (checkRes.subdomainCheck) setSubdomainCheck(checkRes.subdomainCheck);
      }
    } catch (err: unknown) {
      setIsDeploying(false);
      setError(err instanceof Error ? err.message : 'Failed to start deployment');
    }
  }

  async function handleDelete(deploymentId: string) {
    setError(null);
    setDeletingId(deploymentId);
    try {
      const res = await deleteDeploymentInfrastructure(deploymentId);
      if (deployment?.deploymentId === deploymentId) {
        setDeployment(res.deployment);
      }
      await refreshHistory();
      if (subdomain.trim()) {
        const checkRes = await fetchDomainsAndCheckSubdomain(subdomain.trim(), selectedDomain);
        if (checkRes.subdomainCheck) setSubdomainCheck(checkRes.subdomainCheck);
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete AWS infrastructure'
      );
    } finally {
      setDeletingId(null);
    }
  }

  function handleCopy(url: string) {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  }

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100">
      <header className="border-b border-slate-800 bg-[#0b1120]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-400 flex items-center justify-center font-bold text-slate-950">
              R2C
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-white">Repo2Cloud</h1>
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Phase 1 + Phase 2 — S3/CloudFront + Route 53 Subdomains
                </span>
              </div>
              <p className="text-xs text-slate-400">
                GitHub Repo → Isolated Build → S3 + CloudFront OAC → ACM Cert (us-east-1) → Route 53 Alias HTTPS URL
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Phase 1 & Phase 2 Deployment Form */}
        <form
          onSubmit={handleDeploy}
          className="rounded-2xl bg-[#0e1628] border border-slate-800 p-6 shadow-xl space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-white">
                Deploy Static Site with Branded Route 53 HTTPS Subdomain
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Configure your GitHub repository and choose a custom subdomain from the server-controlled domain list.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                Recommended Target: S3_CLOUDFRONT
              </span>
            </div>
          </div>

          {/* Field 1: GitHub Repository URL */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium uppercase tracking-wider text-slate-300">
              1. GitHub Repository URL
            </label>
            <input
              type="url"
              required
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/example/vite-app"
              className="w-full rounded-xl bg-slate-950 border border-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Fields 2 & 3: Subdomain + Server-Controlled Route 53 Domain */}
          <div className="space-y-2 pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-300">
                2. Custom Subdomain &amp; Route 53 Domain (Optional)
              </label>
              <span className="text-[11px] text-slate-400">
                ACM TLS Certificate in <code>us-east-1</code> + Route 53 Alias
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
              <div className="sm:col-span-6 flex items-center rounded-xl bg-slate-950 border border-slate-800 px-3 py-2.5">
                <span className="text-xs text-slate-500 select-none mr-1 font-mono">
                  https://
                </span>
                <input
                  type="text"
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                  placeholder="demo (leave empty for default CloudFront domain)"
                  className="w-full bg-transparent text-sm text-white focus:outline-none font-mono"
                />
              </div>

              <div className="sm:col-span-6">
                <select
                  value={selectedDomain}
                  onChange={(e) => setSelectedDomain(e.target.value)}
                  className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                >
                  {domains.map((d) => (
                    <option key={d.domain} value={d.domain}>
                      .{d.domain} {d.hasWildcardCert ? '(Wildcard ACM Ready)' : '(ACM DNS Validation)'}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Live Subdomain Validation & Duplicate Reservation Check */}
            {subdomain.trim() && subdomainCheck && (
              <div
                className={`text-xs px-3 py-2 rounded-lg border ${
                  subdomainCheck.valid && subdomainCheck.available
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                {subdomainCheck.valid && subdomainCheck.available
                  ? `✓ https://${subdomainCheck.customHostname} passes RFC-1123 hostname validation and is available for reservation.`
                  : `✕ ${subdomainCheck.error}`}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-xl bg-rose-500/15 border border-rose-500/40 p-3 text-xs text-rose-200">
              <strong>Error: </strong>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={
              isDeploying ||
              Boolean(
                subdomain.trim() &&
                  subdomainCheck &&
                  (!subdomainCheck.valid || !subdomainCheck.available)
              )
            }
            className="w-full py-3 px-6 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-indigo-500 to-emerald-500 hover:opacity-95 transition disabled:opacity-50"
          >
            {isDeploying
              ? 'Building, Provisioning & Configuring Route 53...'
              : subdomain.trim()
              ? `Deploy to S3 + CloudFront → https://${subdomain.trim()}.${selectedDomain}`
              : 'Deploy to S3 + CloudFront'}
          </button>
        </form>

        {/* Active Deployment Status & Live URL Card */}
        {deployment && (
          <div className="rounded-2xl bg-[#0e1628] border border-slate-800 p-6 shadow-xl space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-white">
                  Deployment Status ({deployment.deploymentId})
                </h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  Custom Hostname: {deployment.customHostname || 'None (Default CloudFront URL)'}
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <span
                  className={`text-xs font-mono font-bold px-3 py-1 rounded-full border ${
                    deployment.status === 'LIVE'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : deployment.status === 'FAILED'
                      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                      : deployment.status === 'DELETED'
                      ? 'bg-slate-800 text-slate-400 border-slate-700'
                      : 'bg-sky-500/20 text-sky-300 border-sky-500/40 animate-pulse'
                  }`}
                >
                  {deployment.status}
                </span>

                {deployment.status !== 'DELETED' && (
                  <button
                    type="button"
                    disabled={deletingId === deployment.deploymentId}
                    onClick={() => void handleDelete(deployment.deploymentId)}
                    className="px-3.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-xs font-semibold border border-rose-500/40 transition disabled:opacity-50"
                  >
                    {deletingId === deployment.deploymentId
                      ? 'Deleting AWS Resources...'
                      : 'Delete & Clean Up AWS Infrastructure'}
                  </button>
                )}
              </div>
            </div>

            {/* API Response Preview */}
            <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 font-mono text-xs text-slate-300 overflow-x-auto">
              <pre>
                {JSON.stringify(
                  {
                    deploymentId: deployment.deploymentId,
                    status: deployment.status,
                    target: deployment.target,
                    customHostname: deployment.customHostname || null,
                    url: deployment.status === 'LIVE' ? deployment.url : null,
                  },
                  null,
                  2
                )}
              </pre>
            </div>

            {/* Phase 1 & 2 Verification Checklist */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              {[
                {
                  done: deployment.checklist.repositoryAnalyzed,
                  label: 'Repository validated & package.json inspected',
                },
                {
                  done: deployment.checklist.buildCompleted,
                  label: 'Built in isolated worker (AWS credentials stripped)',
                },
                {
                  done: deployment.checklist.cloudResourcesConfigured,
                  label: 'Private S3 bucket & CloudFront OAC provisioned',
                },
                {
                  done: deployment.checklist.httpsAndDomainVerified,
                  label: 'ACM TLS cert (us-east-1), Route 53 Alias & HTTPS verified',
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-2.5 rounded-lg bg-slate-950/70 border border-slate-800/80 p-3"
                >
                  <span
                    className={`h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                      item.done
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        : 'bg-slate-900 text-slate-500 border border-slate-800'
                    }`}
                  >
                    {item.done ? '✓' : '·'}
                  </span>
                  <span className={item.done ? 'text-slate-100' : 'text-slate-400'}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Final Verified Live URL Banner */}
            {deployment.status === 'LIVE' && deployment.url && (
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/40 p-4 space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-emerald-300">
                  ● Live HTTPS URL Verified
                </div>

                <div className="flex items-center justify-between gap-3 bg-slate-950 rounded-lg p-3 border border-emerald-500/30">
                  <a
                    href={deployment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono font-bold text-emerald-300 hover:underline truncate"
                  >
                    {deployment.url}
                  </a>
                  <button
                    type="button"
                    onClick={() => handleCopy(deployment.url!)}
                    className="px-3 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 text-xs font-medium border border-emerald-500/30"
                  >
                    {copiedUrl === deployment.url ? 'Copied!' : 'Copy URL'}
                  </button>
                </div>

                {deployment.infrastructureUrl &&
                  deployment.infrastructureUrl !== deployment.url && (
                    <div className="flex items-center justify-between gap-2 text-xs font-mono text-slate-300 bg-slate-950/70 rounded-lg px-3 py-2 border border-slate-800">
                      <span>
                        CloudFront Distribution URL:{' '}
                        <a
                          href={deployment.infrastructureUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-300 hover:underline"
                        >
                          {deployment.infrastructureUrl}
                        </a>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy(deployment.infrastructureUrl!)}
                        className="text-[11px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                      >
                        {copiedUrl === deployment.infrastructureUrl ? 'Copied!' : 'Copy CloudFront URL'}
                      </button>
                    </div>
                  )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono text-slate-400 pt-1">
                  <div>S3 Bucket: {deployment.resources.s3BucketName}</div>
                  <div>CloudFront ID: {deployment.resources.cloudFrontDistributionId}</div>
                  <div>OAC ID: {deployment.resources.cloudFrontOacId}</div>
                  <div>
                    Route 53 Record: {deployment.resources.route53RecordName || 'None'}
                  </div>
                </div>
              </div>
            )}

            {/* Audit Logs */}
            <div className="rounded-xl bg-slate-950 border border-slate-800 p-3.5 max-h-56 overflow-y-auto font-mono text-[11px] space-y-1">
              {deployment.auditLogs.map((log, i) => (
                <div key={i}>
                  <span className="text-slate-500">
                    [{new Date(log.timestamp).toLocaleTimeString()}]
                  </span>{' '}
                  <span className="text-sky-300">[{log.phase}]</span>{' '}
                  <span className="text-slate-200">{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Deployment History & Cleanup Table */}
        {history.length > 0 && (
          <section className="rounded-2xl bg-[#0e1628] border border-slate-800 p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-white">
                  Deployments &amp; Infrastructure Cleanup
                </h3>
                <p className="text-xs text-slate-400">
                  Deleting a deployment tears down S3, CloudFront, and Route 53 records and frees the reserved subdomain
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refreshHistory()}
                className="px-3 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300"
              >
                Refresh
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 uppercase tracking-wider text-[11px]">
                    <th className="py-2.5 px-3">ID</th>
                    <th className="py-2.5 px-3">Repository</th>
                    <th className="py-2.5 px-3">Subdomain</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {history.map((item) => (
                    <tr key={item.deploymentId} className="hover:bg-slate-900/40">
                      <td className="py-2.5 px-3 font-mono text-slate-200">
                        {item.deploymentId}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-300">
                        {item.repoOwner}/{item.repoName}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-indigo-300">
                        {item.customHostname || '—'}
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`px-2 py-0.5 rounded-full font-mono text-[11px] font-semibold ${
                            item.status === 'LIVE'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : item.status === 'FAILED'
                              ? 'bg-rose-500/20 text-rose-300'
                              : item.status === 'DELETED'
                              ? 'bg-slate-800 text-slate-400'
                              : 'bg-sky-500/20 text-sky-300'
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() => setDeployment(item)}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                        >
                          Inspect
                        </button>
                        {item.status !== 'DELETED' && (
                          <button
                            type="button"
                            disabled={deletingId === item.deploymentId}
                            onClick={() => void handleDelete(item.deploymentId)}
                            className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/30 disabled:opacity-50"
                          >
                            {deletingId === item.deploymentId ? 'Deleting...' : 'Delete AWS Infra'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
