'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AnalysisResult,
  analyzeRepository,
  createStaticDeployment,
  deleteDeploymentInfrastructure,
  DeploymentRecord,
  DeploymentTarget,
  fetchDomainsAndCheckSubdomain,
  fetchSecurityStatus,
  getDeploymentStatus,
  listDeployments,
  SecurityGuardrailsStatus,
} from '@/lib/api';

const SAMPLE_REPOS: Array<{ label: string; url: string; tag: string }> = [
  {
    label: 'nmahendran-aws/sprout',
    url: 'https://github.com/nmahendran-aws/sprout',
    tag: 'Static HTML/JS -> S3 + CloudFront',
  },
  {
    label: 'example/vite-app',
    url: 'https://github.com/example/vite-app',
    tag: 'Vite + React -> S3 + CloudFront',
  },
  {
    label: 'example/express-docker-api',
    url: 'https://github.com/example/express-docker-api',
    tag: 'Express + Docker -> ECS Fargate',
  },
  {
    label: 'example/serverless-lambda-api',
    url: 'https://github.com/example/serverless-lambda-api',
    tag: 'Serverless -> Lambda + API GW',
  },
  {
    label: 'example/nextjs-ssr-app',
    url: 'https://github.com/example/nextjs-ssr-app',
    tag: 'Next.js SSR -> AWS Amplify',
  },
];

const DEFAULT_TARGET_META: Array<{
  target: DeploymentTarget;
  title: string;
  subtitle: string;
  phaseBadge: string;
  isLiveReady: boolean;
}> = [
  {
    target: 'S3_CLOUDFRONT',
    title: 'S3 + CloudFront (OAC)',
    subtitle: 'Private S3 Bucket + Global CDN Edge',
    phaseBadge: 'Phase 1–3 Active',
    isLiveReady: true,
  },
  {
    target: 'ECS_FARGATE',
    title: 'ECS Fargate + ALB',
    subtitle: 'Docker Container + Application Load Balancer',
    phaseBadge: 'Phase 4 Active',
    isLiveReady: true,
  },
  {
    target: 'LAMBDA_API_GATEWAY',
    title: 'Lambda + API Gateway',
    subtitle: 'Serverless Function + HTTP API v2',
    phaseBadge: 'Phase 5 Active',
    isLiveReady: true,
  },
  {
    target: 'AMPLIFY',
    title: 'AWS Amplify Hosting',
    subtitle: 'Managed Full-Stack & Next.js SSR',
    phaseBadge: 'Phase 6 Active',
    isLiveReady: true,
  },
];

export default function Phase3DeployPage() {
  const [repoUrl, setRepoUrl] = useState('https://github.com/nmahendran-aws/sprout');
  const [branch, setBranch] = useState('main');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Phase 3 Dynamic Target & Target-Specific Form State
  const [selectedTarget, setSelectedTarget] = useState<DeploymentTarget>('S3_CLOUDFRONT');
  const [buildCommandOverride, setBuildCommandOverride] = useState('');
  const [outputDirOverride, setOutputDirOverride] = useState('');
  const [containerPort, setContainerPort] = useState(3000);
  const [healthCheckPath, setHealthCheckPath] = useState('/health');
  const [lambdaHandler, setLambdaHandler] = useState('index.handler');
  const [runtime, setRuntime] = useState('nodejs20.x');
  const [showEnvEditor, setShowEnvEditor] = useState(false);
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([
    { key: 'NODE_ENV', value: 'production' },
  ]);

  // Phase 2 Custom Subdomain & Route 53 State
  const [subdomain, setSubdomain] = useState('');
  const [domains, setDomains] = useState<Array<{ domain: string; hasWildcardCert: boolean }>>([
    { domain: 'maas-fam.com', hasWildcardCert: true },
  ]);
  const [selectedDomain, setSelectedDomain] = useState('maas-fam.com');
  const [subdomainCheck, setSubdomainCheck] = useState<{
    valid: boolean;
    available: boolean;
    customHostname?: string;
    error?: string;
  } | null>(null);

  // Active Deployment & History State
  const [deployment, setDeployment] = useState<DeploymentRecord | null>(null);
  const [history, setHistory] = useState<DeploymentRecord[]>([]);
  const [securityStatus, setSecurityStatus] = useState<SecurityGuardrailsStatus | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      const [res, sec] = await Promise.all([
        listDeployments(),
        fetchSecurityStatus().catch(() => null),
      ]);
      setHistory(res.deployments);
      if (sec) setSecurityStatus(sec);
    } catch {
      // Ignore if backend is restarting
    }
  }, []);

  const runAnalysis = useCallback(
    async (targetUrl: string, targetBranch?: string) => {
      if (!targetUrl.trim()) return;
      setIsAnalyzing(true);
      setError(null);
      try {
        const res = await analyzeRepository(targetUrl.trim(), targetBranch || branch);
        setAnalysis(res.analysis);
        setSelectedTarget(res.analysis.recommendedTarget);
        setBuildCommandOverride(res.analysis.buildCommand || '');
        setOutputDirOverride(res.analysis.outputDirectory || '');
        if (res.analysis.suggestedContainerPort) {
          setContainerPort(res.analysis.suggestedContainerPort);
        }
        if (res.analysis.suggestedHealthCheckPath) {
          setHealthCheckPath(res.analysis.suggestedHealthCheckPath);
        }
        if (res.analysis.suggestedLambdaHandler) {
          setLambdaHandler(res.analysis.suggestedLambdaHandler);
        }
        if (res.analysis.runtime && res.analysis.runtime !== 'unknown') {
          setRuntime(res.analysis.runtime);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to inspect repository');
      } finally {
        setIsAnalyzing(false);
      }
    },
    [branch]
  );

  // Load server-controlled domains, history, and initial repository inspection on mount
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
    void runAnalysis('https://github.com/nmahendran-aws/sprout', 'main');
  }, [refreshHistory, runAnalysis]);

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

    const envVarsObj: Record<string, string> = {};
    for (const pair of envPairs) {
      if (pair.key.trim()) {
        envVarsObj[pair.key.trim()] = pair.value;
      }
    }

    try {
      const res = await createStaticDeployment({
        repoUrl: repoUrl.trim(),
        target: selectedTarget,
        branch: branch.trim() || 'main',
        subdomain: subdomain.trim() || undefined,
        domain: subdomain.trim() ? selectedDomain : undefined,
        buildCommandOverride: buildCommandOverride.trim() || undefined,
        outputDirOverride: outputDirOverride.trim() || undefined,
        containerPort,
        healthCheckPath,
        lambdaHandler,
        runtime,
        envVars: Object.keys(envVarsObj).length > 0 ? envVarsObj : undefined,
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
      setError(err instanceof Error ? err.message : 'Failed to delete AWS infrastructure');
    } finally {
      setDeletingId(null);
    }
  }

  function handleCopy(urlToCopy: string) {
    navigator.clipboard.writeText(urlToCopy);
    setCopiedUrl(urlToCopy);
    setTimeout(() => setCopiedUrl(null), 2000);
  }

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-[#0b1120]/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-500 to-emerald-400 flex items-center justify-center font-bold text-slate-950">
              R2C
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-lg tracking-tight text-white">Repo2Cloud</h1>
                <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  Phase 1–7: All 4 AWS Targets + Build Isolation &amp; Cost Guardrails
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Multi-Target Recommendation Engine + S3/CF + ECS Fargate + Lambda + Amplify + Route 53 (maas-fam.com)
              </p>
            </div>
          </div>
          <span className="text-xs font-mono text-slate-400">
            API: <code>POST /api/analyze</code> &bull; <code>POST /api/deploy</code>
          </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Phase 7 Build Isolation, Security Guardrails & Cost Quotas Banner */}
        <div className="rounded-xl bg-[#0b1324] border border-emerald-500/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-emerald-300 uppercase tracking-wider">
              🛡 Phase 7 Guardrails Active:
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300 font-mono">
              AWS_* &amp; GITHUB_* Stripped
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300 font-mono">
              --ignore-scripts
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300 font-mono">
              Symlink &amp; Path Traversal Blocked
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300 font-mono">
              Cmd Injection Filter
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-slate-300">
            <span>
              Live Quota:{' '}
              <strong className="text-emerald-300">
                {securityStatus
                  ? `${securityStatus.quotas.activeLiveDeployments}/${securityStatus.quotas.maxActiveLiveDeployments}`
                  : `${history.filter((d) => d.status === 'LIVE').length}/20`}
              </strong>
            </span>
            <span>&bull;</span>
            <span>
              Max Repo: <strong>{securityStatus?.quotas.maxArchiveSizeMb ?? 100}MB</strong>
            </span>
            <span>&bull;</span>
            <span>
              Timeout: <strong>{securityStatus?.quotas.maxBuildDurationSec ?? 180}s</strong>
            </span>
          </div>
        </div>

        {/* Phase 1, 2 & 3 Dynamic Deployment Form */}
        <form
          onSubmit={handleDeploy}
          className="rounded-2xl bg-[#0e1628] border border-slate-800 p-6 shadow-xl space-y-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-white">
                1. Inspect GitHub Repository &amp; Select AWS Architecture
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Paste any public GitHub URL or click a sample below to inspect its stack and auto-configure the recommended AWS target.
              </p>
            </div>
            {analysis && (
              <span className="text-[11px] font-semibold uppercase px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                Recommended: {analysis.recommendedTarget} ({Math.round(analysis.confidence * 100)}% Match)
              </span>
            )}
          </div>

          {/* Sample Presets to test Phase 3 Recommendation Engine */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-400 uppercase tracking-wider mr-1">
              Test Presets:
            </span>
            {SAMPLE_REPOS.map((preset) => (
              <button
                key={preset.url}
                type="button"
                onClick={() => {
                  setRepoUrl(preset.url);
                  void runAnalysis(preset.url, branch);
                }}
                className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                  repoUrl === preset.url
                    ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-200'
                    : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <span className="font-mono font-semibold">{preset.label}</span>{' '}
                <span className="text-[10px] text-slate-400">({preset.tag})</span>
              </button>
            ))}
          </div>

          {/* Repository URL + Branch + Analyze Button */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-7 space-y-1">
              <label className="block text-[11px] font-medium uppercase tracking-wider text-slate-300">
                GitHub Repository URL
              </label>
              <input
                type="url"
                required
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/nmahendran-aws/sprout"
                className="w-full rounded-xl bg-slate-950 border border-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="sm:col-span-2 space-y-1">
              <label className="block text-[11px] font-medium uppercase tracking-wider text-slate-300">
                Branch
              </label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="sm:col-span-3 flex items-end">
              <button
                type="button"
                disabled={isAnalyzing || !repoUrl.trim()}
                onClick={() => void runAnalysis(repoUrl, branch)}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-500/40 transition disabled:opacity-50"
              >
                {isAnalyzing ? 'Inspecting Repo...' : '🔍 Inspect & Recommend'}
              </button>
            </div>
          </div>

          {/* Phase 3 Pre-Deployment Analysis Summary Card */}
          {analysis && (
            <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-white">
                    Detected Stack: <span className="text-emerald-300">{analysis.framework}</span>
                  </span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    {analysis.applicationType}
                  </span>
                  {analysis.runtime && analysis.runtime !== 'unknown' && (
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                      {analysis.runtime}
                    </span>
                  )}
                </div>
                <span className="text-xs font-mono text-emerald-400">
                  Confidence: {Math.round(analysis.confidence * 100)}%
                </span>
              </div>

              {analysis.aiExplanation && (
                <p className="text-xs text-slate-300 leading-relaxed">
                  {analysis.aiExplanation.replace(/\*\*/g, '')}
                </p>
              )}

              {analysis.signalsDetected && analysis.signalsDetected.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {analysis.signalsDetected.map((sig, idx) => (
                    <span
                      key={idx}
                      title={sig.description}
                      className="text-[11px] px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 text-slate-300 font-mono"
                    >
                      ✓ {sig.signal}
                    </span>
                  ))}
                </div>
              )}

              {analysis.warnings && analysis.warnings.length > 0 && (
                <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 space-y-1">
                  {analysis.warnings.map((w, idx) => (
                    <div key={idx}>⚠ {w}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Phase 3 Multi-Target Selector Cards */}
          <div className="space-y-2 pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-300">
                2. Select AWS Target Architecture (Phase 3 Multi-Target Engine)
              </label>
              <span className="text-[11px] text-slate-400">
                Form fields below adapt dynamically to your chosen target
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {DEFAULT_TARGET_META.map((meta) => {
                const optionScore = analysis?.targetOptions?.find(
                  (o) => o.target === meta.target
                );
                const isRecommended = analysis?.recommendedTarget === meta.target;
                const isSelected = selectedTarget === meta.target;

                return (
                  <button
                    key={meta.target}
                    type="button"
                    onClick={() => setSelectedTarget(meta.target)}
                    className={`text-left rounded-xl p-3.5 border transition flex flex-col justify-between gap-2 ${
                      isSelected
                        ? 'bg-indigo-500/15 border-indigo-400 shadow-lg shadow-indigo-500/10'
                        : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-bold text-white">{meta.title}</span>
                        {isRecommended && (
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">{meta.subtitle}</p>
                      {optionScore && (
                        <p className="text-[11px] text-slate-300 leading-snug pt-1">
                          {optionScore.reason}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-[10px] font-mono">
                      <span
                        className={
                          meta.isLiveReady ? 'text-emerald-400 font-semibold' : 'text-amber-300'
                        }
                      >
                        {meta.phaseBadge}
                      </span>
                      {optionScore && (
                        <span className="text-slate-400">Fit: {optionScore.fitScore}%</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Phase 3 Dynamic Target-Specific Configuration Fields */}
          <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                3. Dynamic Configuration for {selectedTarget}
              </span>
              <button
                type="button"
                onClick={() => setShowEnvEditor((v) => !v)}
                className="text-xs text-slate-300 hover:text-white underline"
              >
                {showEnvEditor ? 'Hide Environment Variables' : `+ Configure Env Vars (${envPairs.length})`}
              </button>
            </div>

            {selectedTarget === 'S3_CLOUDFRONT' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    Build Command (Leave empty if pre-built static HTML/JS)
                  </label>
                  <input
                    type="text"
                    value={buildCommandOverride}
                    onChange={(e) => setBuildCommandOverride(e.target.value)}
                    placeholder="npm run build"
                    className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    Publish / Output Directory (e.g., dist, build, out, .)
                  </label>
                  <input
                    type="text"
                    value={outputDirOverride}
                    onChange={(e) => setOutputDirOverride(e.target.value)}
                    placeholder="dist"
                    className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            )}

            {selectedTarget === 'ECS_FARGATE' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    Container Port (EXPOSE)
                  </label>
                  <input
                    type="number"
                    value={containerPort}
                    onChange={(e) => setContainerPort(Number(e.target.value) || 3000)}
                    className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    ALB Health Check Path
                  </label>
                  <input
                    type="text"
                    value={healthCheckPath}
                    onChange={(e) => setHealthCheckPath(e.target.value)}
                    placeholder="/health"
                    className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    Fargate Task Size
                  </label>
                  <input
                    type="text"
                    disabled
                    value="0.25 vCPU / 512 MB (Auto-Dockerfile)"
                    className="w-full rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2 text-xs text-slate-400 font-mono"
                  />
                </div>
              </div>
            )}

            {selectedTarget === 'LAMBDA_API_GATEWAY' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    Lambda Handler (file.export)
                  </label>
                  <input
                    type="text"
                    value={lambdaHandler}
                    onChange={(e) => setLambdaHandler(e.target.value)}
                    placeholder="index.handler"
                    className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    AWS Lambda Runtime
                  </label>
                  <select
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value)}
                    className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  >
                    <option value="nodejs20.x">nodejs20.x</option>
                    <option value="nodejs18.x">nodejs18.x</option>
                    <option value="python3.12">python3.12</option>
                  </select>
                </div>
              </div>
            )}

            {selectedTarget === 'AMPLIFY' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    Build Command
                  </label>
                  <input
                    type="text"
                    value={buildCommandOverride}
                    onChange={(e) => setBuildCommandOverride(e.target.value)}
                    placeholder="npm run build"
                    className="w-full rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] text-slate-400">
                    Amplify Platform Mode
                  </label>
                  <input
                    type="text"
                    disabled
                    value="WEB_COMPUTE (Next.js SSR / Full-Stack)"
                    className="w-full rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2 text-xs text-slate-400 font-mono"
                  />
                </div>
              </div>
            )}

            {/* Collapsible Environment Variables Editor */}
            {showEnvEditor && (
              <div className="pt-3 border-t border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-300">
                    Sanitized Build/Runtime Environment Variables (AWS_* keys blocked)
                  </span>
                  <button
                    type="button"
                    onClick={() => setEnvPairs([...envPairs, { key: '', value: '' }])}
                    className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                  >
                    + Add Variable
                  </button>
                </div>
                {envPairs.map((pair, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={pair.key}
                      onChange={(e) => {
                        const copy = [...envPairs];
                        copy[idx].key = e.target.value;
                        setEnvPairs(copy);
                      }}
                      placeholder="VITE_API_URL"
                      className="w-1/3 rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1.5 text-xs text-white font-mono"
                    />
                    <input
                      type="text"
                      value={pair.value}
                      onChange={(e) => {
                        const copy = [...envPairs];
                        copy[idx].value = e.target.value;
                        setEnvPairs(copy);
                      }}
                      placeholder="https://api.maas-fam.com"
                      className="flex-1 rounded-lg bg-slate-900 border border-slate-800 px-2.5 py-1.5 text-xs text-white font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setEnvPairs(envPairs.filter((_, i) => i !== idx))}
                      className="text-xs text-rose-400 hover:text-rose-300 px-2"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Phase 2: Custom Subdomain & Route 53 Domain */}
          <div className="space-y-2 pt-2 border-t border-slate-800/80">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium uppercase tracking-wider text-slate-300">
                4. Custom Subdomain &amp; Route 53 Domain (Optional)
              </label>
              <span className="text-[11px] text-slate-400">
                Wildcard ACM Certificate in <code>us-east-1</code> + Route 53 A/AAAA Alias
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
                  placeholder="sprout (leave empty for default CloudFront URL)"
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
            {subdomain.trim() && subdomainCheck && (() => {
              const isOwnedByCurrentDeployment =
                Boolean(
                  deployment &&
                    subdomainCheck.customHostname &&
                    deployment.customHostname === subdomainCheck.customHostname &&
                    deployment.status !== 'DELETED' &&
                    deployment.status !== 'FAILED'
                );

              if (subdomainCheck.valid && subdomainCheck.available) {
                return (
                  <div className="text-xs px-3 py-2 rounded-lg border bg-emerald-500/10 border-emerald-500/30 text-emerald-300">
                    ✓ https://{subdomainCheck.customHostname} passes RFC-1123 hostname validation and is available for reservation.
                  </div>
                );
              }

              if (isOwnedByCurrentDeployment) {
                return (
                  <div className="text-xs px-3 py-2 rounded-lg border bg-indigo-500/10 border-indigo-500/30 text-indigo-300">
                    ✓ https://{subdomainCheck.customHostname} is reserved by your active deployment ({deployment?.deploymentId}). Enter a different subdomain above if you want to launch a second deployment.
                  </div>
                );
              }

              return (
                <div className="text-xs px-3 py-2 rounded-lg border bg-rose-500/10 border-rose-500/30 text-rose-300">
                  ✕ {subdomainCheck.error}
                </div>
              );
            })()}
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
              ? 'Deploying to AWS...'
              : subdomain.trim()
              ? `Deploy to ${selectedTarget} -> https://${subdomain.trim()}.${selectedDomain}`
              : `Deploy to ${selectedTarget} (CloudFront HTTPS URL)`}
          </button>
        </form>

        {/* Active Deployment Status & Live URL Panel */}
        {deployment && (
          <div className="rounded-2xl bg-[#0e1628] border border-slate-800 p-6 shadow-xl space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-xs text-slate-400">
                    {deployment.deploymentId}
                  </span>
                  <span
                    className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${
                      deployment.status === 'LIVE'
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : deployment.status === 'FAILED'
                        ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                        : deployment.status === 'DELETED'
                        ? 'bg-slate-700/40 text-slate-300 border-slate-600'
                        : 'bg-amber-500/15 text-amber-300 border-amber-500/30 animate-pulse'
                    }`}
                  >
                    {deployment.status}
                  </span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                    {deployment.target}
                  </span>
                  <span
                    className={`text-xs font-mono px-2 py-0.5 rounded ${
                      deployment.dryRun
                        ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    }`}
                  >
                    {deployment.dryRun ? 'Dry-Run Mode' : 'Live AWS Mode'}
                  </span>
                </div>
                <p className="text-sm text-slate-300 mt-1 font-mono">
                  {deployment.repoUrl}
                  {deployment.customHostname && (
                    <span className="text-indigo-300 ml-2">
                      &rarr; https://{deployment.customHostname}
                    </span>
                  )}
                </p>
              </div>

              {deployment.status !== 'DELETED' && (
                <button
                  type="button"
                  disabled={deletingId === deployment.deploymentId}
                  onClick={() => handleDelete(deployment.deploymentId)}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition disabled:opacity-50"
                >
                  {deletingId === deployment.deploymentId
                    ? 'Deleting AWS Resources...'
                    : 'Delete AWS Infrastructure'}
                </button>
              )}
            </div>

            {/* Verified URLs (Only shown once status === LIVE) */}
            {deployment.status === 'LIVE' && deployment.url ? (
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-emerald-300 font-semibold">
                      {deployment.customHostname
                        ? 'Verified Custom HTTPS Subdomain URL (Route 53 + ACM)'
                        : 'Verified CloudFront HTTPS URL'}
                    </div>
                    <a
                      href={deployment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-base font-mono font-semibold text-white underline hover:text-emerald-300 break-all"
                    >
                      {deployment.url}
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopy(deployment.url!)}
                      className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 border border-slate-700"
                    >
                      {copiedUrl === deployment.url ? 'Copied!' : 'Copy URL'}
                    </button>
                    <a
                      href={deployment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-xs font-semibold text-slate-950"
                    >
                      Open Live Site &rarr;
                    </a>
                  </div>
                </div>

                {/* Also show underlying CloudFront distribution URL when custom domain is used */}
                {deployment.infrastructureUrl &&
                  deployment.infrastructureUrl !== deployment.url && (
                    <div className="pt-2 border-t border-emerald-500/20 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-slate-300">
                        Underlying CloudFront Distribution (Always Reachable):{' '}
                        <a
                          href={deployment.infrastructureUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-emerald-300 underline"
                        >
                          {deployment.infrastructureUrl}
                        </a>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy(deployment.infrastructureUrl!)}
                        className="text-slate-300 hover:text-white font-mono"
                      >
                        {copiedUrl === deployment.infrastructureUrl
                          ? 'Copied!'
                          : 'Copy CloudFront URL'}
                      </button>
                    </div>
                  )}
              </div>
            ) : deployment.status === 'DELETED' ? (
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 text-xs text-slate-300">
                ✓ AWS infrastructure (S3 bucket, CloudFront distribution, OAC, and Route 53 Alias record) has been deleted and subdomain reservation released.
              </div>
            ) : (
              <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4 flex items-center justify-between">
                <span className="text-xs text-slate-400">
                  Live URL (<code>url: null</code> until CloudFront, ACM TLS, and Route 53 checks pass)
                </span>
                <span className="text-xs font-mono text-amber-300">
                  Waiting for verification...
                </span>
              </div>
            )}

            {/* Provisioned AWS & Route 53 Resources */}
            {deployment.target === 'AMPLIFY' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">AWS Amplify App ID</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.amplifyAppId || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">Amplify Branch &amp; Compute</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.amplifyBranchName
                      ? `${deployment.resources.amplifyBranchName} (WEB_COMPUTE SSR)`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">Route 53 Custom Domain / CDN</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.route53RecordName
                      ? `${deployment.resources.route53RecordName} -> Amplify`
                      : deployment.infrastructureUrl || 'Default (*.amplifyapp.com)'}
                  </div>
                </div>
              </div>
            ) : deployment.target === 'LAMBDA_API_GATEWAY' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">AWS Lambda Function</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.lambdaFunctionName || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">API Gateway v2 (HTTP API)</div>
                  <div
                    className="font-mono text-slate-200 mt-1 truncate"
                    title={deployment.resources.apiGatewayEndpoint}
                  >
                    {deployment.resources.apiGatewayId
                      ? `${deployment.resources.apiGatewayId} ($default)`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">IAM Execution Role &amp; Route 53</div>
                  <div
                    className="font-mono text-slate-200 mt-1 truncate"
                    title={deployment.resources.lambdaRoleArn}
                  >
                    {deployment.resources.route53RecordName
                      ? `${deployment.resources.route53RecordName} -> API GW`
                      : deployment.resources.lambdaRoleArn || 'Pending...'}
                  </div>
                </div>
              </div>
            ) : deployment.target === 'ECS_FARGATE' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">Amazon ECR Repository &amp; Image</div>
                  <div className="font-mono text-slate-200 mt-1 truncate" title={deployment.resources.ecrRepositoryUri}>
                    {deployment.resources.ecrRepositoryUri || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">ECS Fargate Cluster &amp; Service</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.ecsServiceName
                      ? `${deployment.resources.ecsClusterName} / ${deployment.resources.ecsServiceName}`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">ALB Target Group &amp; Route 53 Alias</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.route53RecordName
                      ? `${deployment.resources.route53RecordName} -> ALB`
                      : deployment.resources.albTargetGroupArn || 'Pending...'}
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">Private S3 Bucket</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.s3BucketName || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">CloudFront Distribution &amp; OAC</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.cloudFrontDistributionId
                      ? `${deployment.resources.cloudFrontDistributionId} (${deployment.resources.cloudFrontOacId})`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 p-3">
                  <div className="text-slate-400">Route 53 Alias &amp; ACM (us-east-1)</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.route53RecordName
                      ? `${deployment.resources.route53RecordName} (${deployment.resources.route53HostedZoneId})`
                      : deployment.customHostname
                      ? `Reserved: ${deployment.customHostname}`
                      : 'Default (*.cloudfront.net)'}
                  </div>
                </div>
              </div>
            )}

            {/* Step-by-Step Audit Log Stream */}
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Pipeline Execution Log
              </div>
              <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 max-h-64 overflow-y-auto font-mono text-xs space-y-1.5">
                {deployment.auditLogs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-slate-500 shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 shrink-0">
                      {log.phase}
                    </span>
                    <span
                      className={
                        log.level === 'ERROR'
                          ? 'text-rose-400'
                          : log.level === 'SUCCESS'
                          ? 'text-emerald-300'
                          : 'text-slate-300'
                      }
                    >
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Recent Deployments Table with Delete Option */}
        {history.length > 0 && (
          <div className="rounded-2xl bg-[#0e1628] border border-slate-800 p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                  Deployment History &amp; Infrastructure Cleanup
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Click any deployment to inspect its logs, or delete its AWS resources and release its reserved Route 53 subdomain.
                </p>
              </div>
            </div>

            <div className="space-y-2.5">
              {history.map((item) => (
                <div
                  key={item.deploymentId}
                  className="rounded-xl bg-slate-950/90 border border-slate-800 p-3.5 flex flex-wrap items-center justify-between gap-3"
                >
                  <div
                    className="space-y-1 cursor-pointer"
                    onClick={() => setDeployment(item)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-indigo-300">
                        {item.deploymentId}
                      </span>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                          item.status === 'LIVE'
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : item.status === 'DELETED'
                            ? 'bg-slate-800 text-slate-400 border-slate-700'
                            : item.status === 'FAILED'
                            ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                            : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                        }`}
                      >
                        {item.status}
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        {item.customHostname
                          ? `https://${item.customHostname}`
                          : item.resources.s3BucketName || item.repoName}
                      </span>
                    </div>
                    {item.url && item.status === 'LIVE' && (
                      <div className="text-xs font-mono text-emerald-300">
                        {item.url}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDeployment(item)}
                      className="px-2.5 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-200"
                    >
                      Inspect
                    </button>
                    {item.status !== 'DELETED' && (
                      <button
                        type="button"
                        disabled={deletingId === item.deploymentId}
                        onClick={() => handleDelete(item.deploymentId)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 disabled:opacity-50"
                      >
                        {deletingId === item.deploymentId
                          ? 'Deleting...'
                          : 'Delete Infrastructure'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
