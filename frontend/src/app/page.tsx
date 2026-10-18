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
  fetchObservabilityMetrics,
  fetchSecurityStatus,
  getDeploymentStatus,
  listDeployments,
  ObservabilityMetrics,
  retryFailedDeployment,
  SecurityGuardrailsStatus,
} from '@/lib/api';

type ThemeMode = 'aurora' | 'aws-sunset' | 'oceanic';
type ActiveViewTab = 'deploy' | 'topology' | 'comparison';

const SAMPLE_REPOS: Array<{
  label: string;
  url: string;
  tag: string;
  badgeColor: string;
  icon: string;
}> = [
  {
    label: 'nmahendran-aws/sprout',
    url: 'https://github.com/nmahendran-aws/sprout',
    tag: 'Static HTML/JS → S3 + CloudFront',
    badgeColor: 'from-cyan-500/20 to-blue-500/20 text-cyan-300 border-cyan-500/40',
    icon: '⚡',
  },
  {
    label: 'example/vite-app',
    url: 'https://github.com/example/vite-app',
    tag: 'Vite + React → S3 + CloudFront',
    badgeColor: 'from-sky-500/20 to-indigo-500/20 text-sky-300 border-sky-500/40',
    icon: '⚛️',
  },
  {
    label: 'example/express-docker-api',
    url: 'https://github.com/example/express-docker-api',
    tag: 'Express + Docker → ECS Fargate',
    badgeColor: 'from-amber-500/20 to-orange-500/20 text-amber-300 border-amber-500/40',
    icon: '🐳',
  },
  {
    label: 'example/serverless-lambda-api',
    url: 'https://github.com/example/serverless-lambda-api',
    tag: 'Serverless → Lambda + API GW',
    badgeColor: 'from-violet-500/20 to-fuchsia-500/20 text-violet-300 border-violet-500/40',
    icon: 'λ',
  },
  {
    label: 'example/nextjs-ssr-app',
    url: 'https://github.com/example/nextjs-ssr-app',
    tag: 'Next.js SSR → AWS Amplify',
    badgeColor: 'from-rose-500/20 to-pink-500/20 text-rose-300 border-rose-500/40',
    icon: '▲',
  },
];

const DEFAULT_TARGET_META: Array<{
  target: DeploymentTarget;
  title: string;
  subtitle: string;
  phaseBadge: string;
  isLiveReady: boolean;
  icon: string;
  accentGradient: string;
  activeBorder: string;
  badgeClass: string;
  barColor: string;
  awsServices: string[];
  estBaseMonthlyCost: number;
}> = [
  {
    target: 'S3_CLOUDFRONT',
    title: 'S3 + CloudFront (OAC)',
    subtitle: 'Private S3 Bucket + Global CDN Edge',
    phaseBadge: 'Phase 1–3 Active',
    isLiveReady: true,
    icon: '🌐',
    accentGradient: 'from-cyan-500/20 via-blue-500/10 to-transparent',
    activeBorder: 'border-cyan-400 shadow-lg shadow-cyan-500/20 ring-1 ring-cyan-400/50',
    badgeClass: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    barColor: 'bg-gradient-to-r from-cyan-400 to-blue-500',
    awsServices: ['Private S3 Bucket', 'CloudFront OAC SigV4', 'ACM TLS (us-east-1)', 'Route 53 Alias'],
    estBaseMonthlyCost: 0.85,
  },
  {
    target: 'ECS_FARGATE',
    title: 'ECS Fargate + ALB',
    subtitle: 'Docker Container + Application Load Balancer',
    phaseBadge: 'Phase 4 Active',
    isLiveReady: true,
    icon: '🐳',
    accentGradient: 'from-amber-500/20 via-orange-500/10 to-transparent',
    activeBorder: 'border-amber-400 shadow-lg shadow-amber-500/20 ring-1 ring-amber-400/50',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    barColor: 'bg-gradient-to-r from-amber-400 to-orange-500',
    awsServices: ['Amazon ECR Repo', 'ECS Fargate 0.25 vCPU', 'Application Load Balancer', 'Route 53 Alias'],
    estBaseMonthlyCost: 8.5,
  },
  {
    target: 'LAMBDA_API_GATEWAY',
    title: 'Lambda + API Gateway',
    subtitle: 'Serverless Function + HTTP API v2',
    phaseBadge: 'Phase 5 Active',
    isLiveReady: true,
    icon: '⚡',
    accentGradient: 'from-violet-500/20 via-fuchsia-500/10 to-transparent',
    activeBorder: 'border-violet-400 shadow-lg shadow-violet-500/20 ring-1 ring-violet-400/50',
    badgeClass: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
    barColor: 'bg-gradient-to-r from-violet-400 to-fuchsia-500',
    awsServices: ['PKZIP In-Memory Bundle', 'IAM Execution Role', 'AWS Lambda (Node/Py)', 'API Gateway v2 ($default)'],
    estBaseMonthlyCost: 0.0,
  },
  {
    target: 'AMPLIFY',
    title: 'AWS Amplify Hosting',
    subtitle: 'Managed Full-Stack & Next.js SSR',
    phaseBadge: 'Phase 6 Active',
    isLiveReady: true,
    icon: '🚀',
    accentGradient: 'from-rose-500/20 via-pink-500/10 to-transparent',
    activeBorder: 'border-rose-400 shadow-lg shadow-rose-500/20 ring-1 ring-rose-400/50',
    badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
    barColor: 'bg-gradient-to-r from-rose-400 to-pink-500',
    awsServices: ['Auto amplify.yml Spec', 'Amplify WEB_COMPUTE', 'Managed SSR Edge', 'Route 53 Custom Domain'],
    estBaseMonthlyCost: 1.5,
  },
];

const THEME_CONFIG: Record<
  ThemeMode,
  {
    name: string;
    bgMain: string;
    orb1: string;
    orb2: string;
    orb3: string;
    primaryBtn: string;
    headerBadge: string;
  }
> = {
  aurora: {
    name: 'Obsidian Velvet',
    bgMain: 'bg-[#090a0f]',
    orb1: 'bg-purple-600/15',
    orb2: 'bg-indigo-500/15',
    orb3: 'bg-emerald-500/10',
    primaryBtn: 'from-purple-500 via-indigo-500 to-emerald-400',
    headerBadge: 'from-purple-500/20 to-indigo-500/20 text-purple-200 border-purple-500/30',
  },
  'aws-sunset': {
    name: 'Midnight Amber',
    bgMain: 'bg-[#0a0a0e]',
    orb1: 'bg-amber-500/15',
    orb2: 'bg-rose-600/15',
    orb3: 'bg-orange-500/15',
    primaryBtn: 'from-amber-500 via-orange-500 to-rose-500',
    headerBadge: 'from-amber-500/20 to-rose-500/20 text-amber-200 border-amber-500/30',
  },
  oceanic: {
    name: 'Emerald Matrix',
    bgMain: 'bg-[#070908]',
    orb1: 'bg-emerald-500/15',
    orb2: 'bg-teal-500/15',
    orb3: 'bg-lime-500/10',
    primaryBtn: 'from-emerald-500 via-teal-500 to-emerald-400',
    headerBadge: 'from-emerald-500/20 to-teal-500/20 text-emerald-200 border-emerald-500/30',
  },
};

export default function Phase3DeployPage() {
  const [theme, setTheme] = useState<ThemeMode>('aurora');
  const [activeTab, setActiveTab] = useState<ActiveViewTab>('deploy');

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
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<'ALL' | 'SUCCESS' | 'ERROR'>('ALL');

  // Interactive Cost Simulator State (for Topology & Judge Demo View)
  const [monthlyBandwidthGb, setMonthlyBandwidthGb] = useState(250);
  const [teamSeats, setTeamSeats] = useState(5);

  const currentTheme = THEME_CONFIG[theme];
  const activeTargetMeta =
    DEFAULT_TARGET_META.find((t) => t.target === selectedTarget) || DEFAULT_TARGET_META[0];

  const refreshHistory = useCallback(async () => {
    try {
      const [res, sec, obs] = await Promise.all([
        listDeployments(),
        fetchSecurityStatus().catch(() => null),
        fetchObservabilityMetrics().catch(() => null),
      ]);
      setHistory(res.deployments);
      if (sec) setSecurityStatus(sec);
      if (obs) setMetrics(obs);
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

  async function handleRetry(deploymentId: string) {
    setError(null);
    setRetryingId(deploymentId);
    setIsDeploying(true);
    try {
      const res = await retryFailedDeployment(deploymentId);
      setDeployment(res.deployment);
      await refreshHistory();
    } catch (err: unknown) {
      setIsDeploying(false);
      setError(err instanceof Error ? err.message : 'Failed to retry deployment');
    } finally {
      setRetryingId(null);
    }
  }

  function handleCopy(urlToCopy: string) {
    navigator.clipboard.writeText(urlToCopy);
    setCopiedUrl(urlToCopy);
    setTimeout(() => setCopiedUrl(null), 2000);
  }

  // Cost Calculation for Judge Demo Simulator
  const repo2CloudMonthlyCost = Math.round(
    (activeTargetMeta.estBaseMonthlyCost + Math.max(0, monthlyBandwidthGb - 100) * 0.085) * 100
  ) / 100;
  const vercelMonthlyCost =
    teamSeats * 20 + Math.max(0, Math.ceil((monthlyBandwidthGb - 100) / 100)) * 40;
  const netlifyMonthlyCost =
    teamSeats * 19 + Math.max(0, Math.ceil((monthlyBandwidthGb - 100) / 100)) * 55;

  return (
    <div className={`min-h-screen ${currentTheme.bgMain} text-slate-100 relative overflow-hidden transition-colors duration-500`}>
      {/* Ambient Animated Background Glow Orbs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
        <div
          className={`absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full ${currentTheme.orb1} blur-[130px] animate-float`}
        />
        <div
          className={`absolute top-1/3 -right-32 w-[440px] h-[440px] rounded-full ${currentTheme.orb2} blur-[130px] animate-float`}
          style={{ animationDelay: '1.5s' }}
        />
        <div
          className={`absolute -bottom-40 left-1/3 w-[520px] h-[520px] rounded-full ${currentTheme.orb3} blur-[140px] animate-float`}
          style={{ animationDelay: '3s' }}
        />
      </div>

      {/* Sticky Glass Header */}
      <header className="border-b border-white/10 bg-slate-950/70 backdrop-blur-xl sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div
              className={`h-11 w-11 rounded-xl bg-gradient-to-br ${currentTheme.primaryBtn} animate-gradient-x p-[1px] shadow-lg shadow-indigo-500/20`}
            >
              <div className="h-full w-full rounded-[11px] bg-slate-950/80 flex items-center justify-center font-extrabold text-sm tracking-tighter bg-clip-text text-transparent bg-gradient-to-br from-white via-cyan-200 to-emerald-300">
                DM
              </div>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-extrabold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-slate-100 to-cyan-300">
                  DeployMate
                </h1>
                <span
                  className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-gradient-to-r ${currentTheme.headerBadge} border shadow-sm`}
                >
                  ✨ Autonomous Multi-Target AWS Cloud Engine
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                S3 + CloudFront OAC &bull; ECS Fargate &bull; Lambda + API GW v2 &bull; AWS Amplify &bull; Route 53 (<span className="text-cyan-300 font-mono">*.maas-fam.com</span>)
              </p>
            </div>
          </div>

          {/* Right Controls: View Switcher + Live Theme Selector */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Navigation Pills */}
            <div className="flex items-center bg-slate-900/90 p-1 rounded-xl border border-white/10">
              <button
                type="button"
                onClick={() => setActiveTab('deploy')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                  activeTab === 'deploy'
                    ? `bg-gradient-to-r ${currentTheme.primaryBtn} text-white shadow`
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <span>🚀</span> Deploy Studio
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('topology')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                  activeTab === 'topology'
                    ? `bg-gradient-to-r ${currentTheme.primaryBtn} text-white shadow`
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <span>🕸️</span> Topology &amp; Cost ROI
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('comparison')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                  activeTab === 'comparison'
                    ? `bg-gradient-to-r ${currentTheme.primaryBtn} text-white shadow`
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <span>🏆</span> vs. Vercel / Netlify
              </button>
            </div>

            {/* Color Theme Switcher */}
            <div className="flex items-center gap-1.5 bg-slate-900/90 px-2.5 py-1.5 rounded-xl border border-white/10">
              <span className="text-[10px] uppercase tracking-wider text-slate-400 mr-1">
                Theme:
              </span>
              {(Object.keys(THEME_CONFIG) as ThemeMode[]).map((tKey) => (
                <button
                  key={tKey}
                  type="button"
                  onClick={() => setTheme(tKey)}
                  title={THEME_CONFIG[tKey].name}
                  className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition ${
                    theme === tKey
                      ? 'bg-white/15 text-white border border-white/30 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {THEME_CONFIG[tKey].name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-7 space-y-6 relative z-10">
        {/* Top Real-Time Telemetry & Guardrails Ribbon */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="rounded-2xl bg-gradient-to-br from-emerald-500/15 via-slate-900/90 to-slate-900/90 border border-emerald-500/30 p-4 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
                Platform Success Rate
              </span>
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
            </div>
            <div className="text-2xl font-extrabold text-white font-mono mt-1">
              {metrics ? `${metrics.successRatePercent}%` : '100%'}{' '}
              <span className="text-xs font-normal text-emerald-300/90">
                ({metrics?.totalDeployments ?? history.length} deployments)
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Zero unverified URLs &bull; Strict TLS check
            </div>
          </div>

          <div className="rounded-2xl bg-gradient-to-br from-cyan-500/15 via-slate-900/90 to-slate-900/90 border border-cyan-500/30 p-4 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                Active AWS Stacks
              </span>
              <span className="text-xs font-mono text-cyan-300">us-east-1</span>
            </div>
            <div className="text-2xl font-extrabold text-white font-mono mt-1">
              {securityStatus
                ? `${securityStatus.quotas.activeLiveDeployments}/${securityStatus.quotas.maxActiveLiveDeployments}`
                : `${history.filter((d) => d.status === 'LIVE').length}/20`}{' '}
              <span className="text-xs font-normal text-cyan-300/90">live quota</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              One-click full AWS teardown &amp; DNS release
            </div>
          </div>

          <div className="rounded-2xl bg-gradient-to-br from-amber-500/15 via-slate-900/90 to-slate-900/90 border border-amber-500/30 p-4 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                Self-Healing Engine
              </span>
              <span className="text-xs">⚡</span>
            </div>
            <div className="text-2xl font-extrabold text-white font-mono mt-1">
              Autonomous{' '}
              <span className="text-xs font-normal text-amber-300/90">
                ({metrics?.selfHealingRecoveries ?? 0} auto-heals)
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Auto-remediates lockfiles, ports &amp; outputs
            </div>
          </div>

          <div className="rounded-2xl bg-gradient-to-br from-fuchsia-500/15 via-slate-900/90 to-slate-900/90 border border-fuchsia-500/30 p-4 shadow-lg backdrop-blur">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-fuchsia-300">
                Zero-Trust Sandbox
              </span>
              <span className="text-xs">🛡️</span>
            </div>
            <div className="text-base font-bold text-white font-mono mt-1.5 truncate">
              AWS_* Stripped &bull; Symlink Guard
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              Blocks credential exfiltration &amp; shell injection
            </div>
          </div>
        </div>

        {/* TAB 2: INTERACTIVE AWS TOPOLOGY & COST CALCULATOR */}
        {activeTab === 'topology' && (
          <div className="space-y-6">
            {/* Live Interactive Architecture Flow */}
            <div className="rounded-2xl bg-slate-900/80 border border-white/10 p-6 shadow-2xl backdrop-blur space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <span>🕸️</span> Interactive End-to-End AWS Provisioning Topology
                  </h2>
                  <p className="text-xs text-slate-400">
                    Click any target below to inspect the live AWS cloud primitives provisioned in your account.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {DEFAULT_TARGET_META.map((m) => (
                    <button
                      key={m.target}
                      type="button"
                      onClick={() => setSelectedTarget(m.target)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition flex items-center gap-1.5 ${
                        selectedTarget === m.target
                          ? m.badgeClass
                          : 'bg-slate-950/70 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <span>{m.icon}</span> {m.title}
                    </button>
                  ))}
                </div>
              </div>

              {/* 5-Stage Visual Pipeline Diagram */}
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-stretch pt-2">
                <div className="rounded-xl bg-slate-950/90 border border-indigo-500/40 p-4 flex flex-col justify-between">
                  <div className="text-xs font-bold text-indigo-300 uppercase">1. Git Clone &amp; AST Scan</div>
                  <div className="text-sm font-semibold text-white mt-2">Repository Analyzer</div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Inspects <code className="text-indigo-300">package.json</code>, Dockerfiles &amp; framework signatures with weighted confidence scoring.
                  </p>
                  <div className="mt-3 text-[10px] font-mono text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded">
                    POST /api/analyze
                  </div>
                </div>

                <div className="rounded-xl bg-slate-950/90 border border-fuchsia-500/40 p-4 flex flex-col justify-between">
                  <div className="text-xs font-bold text-fuchsia-300 uppercase">2. Phase 7 Sandbox</div>
                  <div className="text-sm font-semibold text-white mt-2">Isolated Builder</div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Strips <code className="text-fuchsia-300">AWS_SECRET_*</code> env vars, blocks shell metacharacters, and verifies symlink containment.
                  </p>
                  <div className="mt-3 text-[10px] font-mono text-fuchsia-400 bg-fuchsia-500/10 px-2 py-1 rounded">
                    Zero Credential Leak
                  </div>
                </div>

                <div className={`rounded-xl bg-gradient-to-b ${activeTargetMeta.accentGradient} bg-slate-950/90 border ${activeTargetMeta.activeBorder} p-4 flex flex-col justify-between`}>
                  <div className="text-xs font-bold text-cyan-300 uppercase">
                    3. {activeTargetMeta.target}
                  </div>
                  <div className="text-sm font-semibold text-white mt-1 flex items-center gap-1.5">
                    <span>{activeTargetMeta.icon}</span> {activeTargetMeta.title}
                  </div>
                  <ul className="text-[11px] text-slate-200 mt-2 space-y-1 font-mono">
                    {activeTargetMeta.awsServices.map((svc, idx) => (
                      <li key={idx}>• {svc}</li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-xl bg-slate-950/90 border border-amber-500/40 p-4 flex flex-col justify-between">
                  <div className="text-xs font-bold text-amber-300 uppercase">4. Global DNS &amp; TLS</div>
                  <div className="text-sm font-semibold text-white mt-2">Route 53 + ACM</div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Atomic RFC-1123 reservation + Wildcard ACM TLS in <code className="text-amber-300">us-east-1</code> + A/AAAA Alias record.
                  </p>
                  <div className="mt-3 text-[10px] font-mono text-amber-300 bg-amber-500/10 px-2 py-1 rounded">
                    *.maas-fam.com
                  </div>
                </div>

                <div className="rounded-xl bg-slate-950/90 border border-emerald-500/40 p-4 flex flex-col justify-between">
                  <div className="text-xs font-bold text-emerald-300 uppercase">5. Live Verification</div>
                  <div className="text-sm font-semibold text-white mt-2">HTTPS Probe &amp; Heal</div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Verifies HTTP 200 over TLS before unlocking URL. Auto-triggers Phase 8 Self-Healing if build fails.
                  </p>
                  <div className="mt-3 text-[10px] font-mono text-emerald-300 bg-emerald-500/10 px-2 py-1 rounded">
                    status === LIVE
                  </div>
                </div>
              </div>
            </div>

            {/* Interactive Cloud Economics & Cost Simulator */}
            <div className="rounded-2xl bg-slate-900/80 border border-white/10 p-6 shadow-2xl backdrop-blur space-y-5">
              <div>
                <h3 className="text-base font-bold text-white">
                  💰 Interactive Cloud Cost &amp; Seat Tax Calculator (DeployMate vs. Vercel vs. Netlify)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Drag the sliders to show judges how much teams save by deploying directly to raw AWS primitives without per-seat or bandwidth markups.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4 bg-slate-950/80 p-4 rounded-xl border border-slate-800">
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-slate-300 font-medium">Engineering Team Size (Seats):</span>
                      <span className="font-mono font-bold text-cyan-300">{teamSeats} Developers</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={25}
                      value={teamSeats}
                      onChange={(e) => setTeamSeats(Number(e.target.value))}
                      className="w-full accent-cyan-400 cursor-pointer"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-slate-300 font-medium">Monthly Egress Bandwidth (GB):</span>
                      <span className="font-mono font-bold text-emerald-300">{monthlyBandwidthGb} GB / mo</span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={1000}
                      step={50}
                      value={monthlyBandwidthGb}
                      onChange={(e) => setMonthlyBandwidthGb(Number(e.target.value))}
                      className="w-full accent-emerald-400 cursor-pointer"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl bg-gradient-to-b from-emerald-500/20 to-slate-950 border border-emerald-400/50 p-4 flex flex-col justify-between">
                    <div className="text-xs font-bold text-emerald-300 uppercase">DeployMate (AWS)</div>
                    <div className="text-2xl font-extrabold text-white font-mono my-2">
                      ${repo2CloudMonthlyCost}
                      <span className="text-xs font-normal text-slate-400">/mo</span>
                    </div>
                    <div className="text-[11px] text-emerald-200">
                      $0 seat tax &bull; Raw AWS CloudFront/S3 rates
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 flex flex-col justify-between">
                    <div className="text-xs font-bold text-slate-400 uppercase">Vercel Pro</div>
                    <div className="text-2xl font-extrabold text-rose-300 font-mono my-2">
                      ${vercelMonthlyCost}
                      <span className="text-xs font-normal text-slate-500">/mo</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      $20/user seat + $40/100GB overage
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 flex flex-col justify-between">
                    <div className="text-xs font-bold text-slate-400 uppercase">Netlify Pro</div>
                    <div className="text-2xl font-extrabold text-amber-300 font-mono my-2">
                      ${netlifyMonthlyCost}
                      <span className="text-xs font-normal text-slate-500">/mo</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      $19/user seat + $55/100GB overage
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: HEAD-TO-HEAD JUDGE COMPARISON MATRIX */}
        {activeTab === 'comparison' && (
          <div className="rounded-2xl bg-slate-900/80 border border-white/10 p-6 shadow-2xl backdrop-blur space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-white">
                  🏆 Why DeployMate Beats Vercel &amp; Netlify
                </h2>
                <p className="text-xs text-slate-400">
                  Vercel and Netlify rent you a costly wrapper around AWS. DeployMate gives you Vercel&apos;s 1-click DX directly inside your own AWS account.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('deploy')}
                className={`px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r ${currentTheme.primaryBtn} text-white shadow`}
              >
                Launch Live Deployment &rarr;
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-300 uppercase tracking-wider">
                    <th className="py-3 px-4">Capability</th>
                    <th className="py-3 px-4 text-emerald-300 bg-emerald-500/10 rounded-t-xl">
                      🚀 DeployMate (Ours)
                    </th>
                    <th className="py-3 px-4 text-slate-400">▲ Vercel</th>
                    <th className="py-3 px-4 text-slate-400">◆ Netlify</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  <tr>
                    <td className="py-3.5 px-4 font-semibold text-white">Supported Architectures</td>
                    <td className="py-3.5 px-4 bg-emerald-500/5 text-emerald-200 font-medium">
                      4 Native AWS Targets (S3+CloudFront, ECS Fargate, Lambda+API GW, Amplify SSR)
                    </td>
                    <td className="py-3.5 px-4 text-slate-400">Static &amp; Serverless Functions only (No Docker/ECS)</td>
                    <td className="py-3.5 px-4 text-slate-400">Static &amp; Serverless Functions only (No Containers)</td>
                  </tr>
                  <tr>
                    <td className="py-3.5 px-4 font-semibold text-white">Long-Running Containers &amp; WebSockets</td>
                    <td className="py-3.5 px-4 bg-emerald-500/5 text-emerald-200 font-medium">
                      ✓ Native ECS Fargate + ALB (Zero cold starts, stateful connections)
                    </td>
                    <td className="py-3.5 px-4 text-rose-300">✕ Hard execution timeouts; no stateful containers</td>
                    <td className="py-3.5 px-4 text-rose-300">✕ Function timeout limits; no Docker hosting</td>
                  </tr>
                  <tr>
                    <td className="py-3.5 px-4 font-semibold text-white">Self-Healing Build Recovery</td>
                    <td className="py-3.5 px-4 bg-emerald-500/5 text-emerald-200 font-medium">
                      ✓ Phase 8 Self-Healing Engine (Auto-fixes lockfiles, ports, output dirs &amp; Dockerfiles)
                    </td>
                    <td className="py-3.5 px-4 text-slate-400">✕ Build fails; manual developer debugging</td>
                    <td className="py-3.5 px-4 text-slate-400">✕ Build fails; manual YAML/TOML edits</td>
                  </tr>
                  <tr>
                    <td className="py-3.5 px-4 font-semibold text-white">Infrastructure Ownership (BYOC)</td>
                    <td className="py-3.5 px-4 bg-emerald-500/5 text-emerald-200 font-medium">
                      ✓ 100% Native AWS Resources in your own AWS account (Zero lock-in)
                    </td>
                    <td className="py-3.5 px-4 text-slate-400">✕ Proprietary black-box wrapper</td>
                    <td className="py-3.5 px-4 text-slate-400">✕ Proprietary black-box wrapper</td>
                  </tr>
                  <tr>
                    <td className="py-3.5 px-4 font-semibold text-white">One-Click Full AWS Teardown</td>
                    <td className="py-3.5 px-4 bg-emerald-500/5 text-emerald-200 font-medium">
                      ✓ Cleans S3, CloudFront, OAC, ECR, ECS, Lambda, Amplify &amp; releases Route 53 DNS
                    </td>
                    <td className="py-3.5 px-4 text-slate-400">Project deletion only</td>
                    <td className="py-3.5 px-4 text-slate-400">Site deletion only</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 1: MAIN AUTONOMOUS DEPLOYMENT STUDIO */}
        {activeTab === 'deploy' && (
          <form
            onSubmit={handleDeploy}
            className="rounded-3xl bg-slate-900/75 border border-white/10 p-6 sm:p-7 shadow-2xl backdrop-blur-xl space-y-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    Step 1
                  </span>
                  <h2 className="text-base sm:text-lg font-bold text-white">
                    Inspect GitHub Repository &amp; Auto-Detect Cloud Stack
                  </h2>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Paste any public GitHub URL or click an interactive preset below to run deep repository analysis.
                </p>
              </div>
              {analysis && (
                <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 border border-emerald-400/40 shadow">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
                  <span className="text-xs font-bold text-emerald-200">
                    AI Match: {analysis.recommendedTarget} ({Math.round(analysis.confidence * 100)}% Fit)
                  </span>
                </div>
              )}
            </div>

            {/* Colorful Interactive Sample Presets */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider mr-1">
                ⚡ Quick Demo Presets:
              </span>
              {SAMPLE_REPOS.map((preset) => {
                const isCurrent = repoUrl === preset.url;
                return (
                  <button
                    key={preset.url}
                    type="button"
                    onClick={() => {
                      setRepoUrl(preset.url);
                      void runAnalysis(preset.url, branch);
                    }}
                    className={`text-xs px-3 py-1.5 rounded-xl border transition-all duration-200 flex items-center gap-1.5 ${
                      isCurrent
                        ? `bg-gradient-to-r ${preset.badgeColor} shadow-md scale-[1.02]`
                        : 'bg-slate-950/80 border-slate-800 text-slate-300 hover:border-slate-600 hover:bg-slate-900'
                    }`}
                  >
                    <span>{preset.icon}</span>
                    <span className="font-mono font-semibold">{preset.label}</span>
                    <span className="text-[10px] opacity-80 hidden sm:inline">({preset.tag})</span>
                  </button>
                );
              })}
            </div>

            {/* Repository URL + Branch + Analyze Button */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-7 space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                  GitHub Repository URL
                </label>
                <input
                  type="url"
                  required
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/nmahendran-aws/sprout"
                  className="w-full rounded-xl bg-slate-950/90 border border-slate-700/80 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/40 transition"
                />
              </div>

              <div className="sm:col-span-2 space-y-1.5">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                  Git Branch
                </label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="w-full rounded-xl bg-slate-950/90 border border-slate-700/80 px-3 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400 transition"
                />
              </div>

              <div className="sm:col-span-3 flex items-end">
                <button
                  type="button"
                  disabled={isAnalyzing || !repoUrl.trim()}
                  onClick={() => void runAnalysis(repoUrl, branch)}
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-gradient-to-r from-indigo-500/30 via-cyan-500/30 to-emerald-500/30 hover:from-indigo-500/40 hover:to-emerald-500/40 text-cyan-100 border border-cyan-400/40 shadow-lg transition disabled:opacity-50"
                >
                  {isAnalyzing ? '✨ Scanning AST & Signals...' : '🔍 Inspect & Recommend'}
                </button>
              </div>
            </div>

            {/* Phase 3 Pre-Deployment Analysis Summary Card */}
            {analysis && (
              <div className="rounded-2xl bg-gradient-to-r from-slate-950 via-indigo-950/30 to-slate-950 border border-indigo-500/30 p-4 space-y-3 shadow-inner">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <span className="text-cyan-400">●</span> Detected Framework:{' '}
                      <span className="text-emerald-300 font-mono">{analysis.framework}</span>
                    </span>
                    <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                      {analysis.applicationType}
                    </span>
                    {analysis.runtime && analysis.runtime !== 'unknown' && (
                      <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30">
                        {analysis.runtime}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400"
                        style={{ width: `${Math.round(analysis.confidence * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs font-mono font-bold text-emerald-300">
                      {Math.round(analysis.confidence * 100)}% Confidence
                    </span>
                  </div>
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
                        className="text-[11px] px-2.5 py-0.5 rounded-lg bg-slate-900/90 border border-cyan-500/25 text-cyan-200 font-mono"
                      >
                        ✓ {sig.signal}
                      </span>
                    ))}
                  </div>
                )}

                {analysis.warnings && analysis.warnings.length > 0 && (
                  <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 space-y-1">
                    {analysis.warnings.map((w, idx) => (
                      <div key={idx}>⚠ {w}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Phase 3 Multi-Target Selector Cards */}
            <div className="space-y-3 pt-3 border-t border-white/10">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    Step 2
                  </span>
                  <label className="block text-sm font-bold text-white">
                    Select AWS Target Architecture (4-Target Autonomous Engine)
                  </label>
                </div>
                <span className="text-[11px] text-slate-400">
                  Click any card to switch target &amp; view its live AWS resource pipeline
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                {DEFAULT_TARGET_META.map((meta) => {
                  const optionScore = analysis?.targetOptions?.find(
                    (o) => o.target === meta.target
                  );
                  const isRecommended = analysis?.recommendedTarget === meta.target;
                  const isSelected = selectedTarget === meta.target;
                  const fitPercent = optionScore?.fitScore ?? (isRecommended ? 95 : 40);

                  return (
                    <button
                      key={meta.target}
                      type="button"
                      onClick={() => setSelectedTarget(meta.target)}
                      className={`text-left rounded-2xl p-4 border transition-all duration-200 flex flex-col justify-between gap-3 bg-gradient-to-b ${
                        meta.accentGradient
                      } ${
                        isSelected
                          ? `${meta.activeBorder} bg-slate-900/95 scale-[1.01]`
                          : 'bg-slate-950/80 border-slate-800/90 hover:border-slate-600'
                      }`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-lg">{meta.icon}</span>
                          {isRecommended ? (
                            <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-emerald-500/25 text-emerald-300 border border-emerald-400/50 shadow">
                              ★ Best Fit
                            </span>
                          ) : (
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${meta.badgeClass}`}>
                              {meta.phaseBadge}
                            </span>
                          )}
                        </div>

                        <div>
                          <div className="text-sm font-bold text-white">{meta.title}</div>
                          <p className="text-[11px] text-slate-400 mt-0.5">{meta.subtitle}</p>
                        </div>

                        {optionScore && (
                          <p className="text-[11px] text-slate-300 leading-snug pt-0.5">
                            {optionScore.reason}
                          </p>
                        )}
                      </div>

                      {/* Animated Fit Score Progress Bar */}
                      <div className="space-y-1.5 pt-2 border-t border-white/10">
                        <div className="flex items-center justify-between text-[10px] font-mono">
                          <span className="text-slate-400">Architecture Fit</span>
                          <span className="font-bold text-white">{fitPercent}%</span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className={`h-full ${meta.barColor} transition-all duration-500`}
                            style={{ width: `${fitPercent}%` }}
                          />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Mini Live AWS Service Pill Bar for Selected Target */}
              <div className="rounded-xl bg-slate-950/90 border border-white/10 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-400 font-medium">
                    Provisioning Blueprint for <strong className="text-white">{activeTargetMeta.title}</strong>:
                  </span>
                  {activeTargetMeta.awsServices.map((svc, idx) => (
                    <span
                      key={idx}
                      className={`text-[11px] font-mono px-2.5 py-0.5 rounded-lg border ${activeTargetMeta.badgeClass}`}
                    >
                      {svc}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('topology')}
                  className="text-[11px] font-semibold text-cyan-300 hover:underline"
                >
                  View Full Topology &amp; Cost ROI &rarr;
                </button>
              </div>
            </div>

            {/* Phase 3 Dynamic Target-Specific Configuration Fields */}
            <div className="rounded-2xl bg-slate-950/85 border border-white/10 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase bg-violet-500/20 text-violet-300 border border-violet-500/30">
                    Step 3
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    Target Configuration ({selectedTarget})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowEnvEditor((v) => !v)}
                  className="text-xs px-3 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-cyan-500/30 transition"
                >
                  {showEnvEditor
                    ? 'Hide Environment Variables'
                    : `🔐 Configure Env Vars (${envPairs.length})`}
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
                      className="w-full rounded-xl bg-slate-900 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
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
                      className="w-full rounded-xl bg-slate-900 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-cyan-400"
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
                      className="w-full rounded-xl bg-slate-900 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-amber-400"
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
                      className="w-full rounded-xl bg-slate-900 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-amber-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] text-slate-400">
                      Fargate Compute Profile
                    </label>
                    <input
                      type="text"
                      disabled
                      value="0.25 vCPU / 512 MB (Auto-Dockerfile)"
                      className="w-full rounded-xl bg-slate-900/60 border border-slate-800 px-3.5 py-2 text-xs text-amber-300 font-mono"
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
                      className="w-full rounded-xl bg-slate-900 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-violet-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] text-slate-400">
                      AWS Lambda Runtime
                    </label>
                    <select
                      value={runtime}
                      onChange={(e) => setRuntime(e.target.value)}
                      className="w-full rounded-xl bg-slate-900 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-violet-400"
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
                      className="w-full rounded-xl bg-slate-900 border border-slate-800 px-3.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-rose-400"
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
                      className="w-full rounded-xl bg-slate-900/60 border border-slate-800 px-3.5 py-2 text-xs text-rose-300 font-mono"
                    />
                  </div>
                </div>
              )}

              {/* Collapsible Environment Variables Editor */}
              {showEnvEditor && (
                <div className="pt-3 border-t border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-slate-300">
                      Sanitized Build/Runtime Environment Variables (<code className="text-rose-300">AWS_*</code> keys automatically stripped)
                    </span>
                    <button
                      type="button"
                      onClick={() => setEnvPairs([...envPairs, { key: '', value: '' }])}
                      className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-200"
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
                        placeholder="NEXT_PUBLIC_API_URL"
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
            <div className="space-y-2.5 pt-3 border-t border-white/10">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    Step 4
                  </span>
                  <label className="block text-sm font-bold text-white">
                    Custom Subdomain &amp; Route 53 DNS (Optional)
                  </label>
                </div>
                <span className="text-[11px] text-slate-400">
                  Wildcard ACM Certificate in <code className="text-emerald-300">us-east-1</code> + Route 53 A/AAAA Alias
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
                <div className="sm:col-span-6 flex items-center rounded-xl bg-slate-950/90 border border-slate-700/80 px-3.5 py-2.5 focus-within:border-emerald-400 transition">
                  <span className="text-xs text-emerald-400 select-none mr-1 font-mono font-semibold">
                    https://
                  </span>
                  <input
                    type="text"
                    value={subdomain}
                    onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                    placeholder="sprout (leave empty for default AWS URL)"
                    className="w-full bg-transparent text-sm text-white focus:outline-none font-mono"
                  />
                </div>

                <div className="sm:col-span-6">
                  <select
                    value={selectedDomain}
                    onChange={(e) => setSelectedDomain(e.target.value)}
                    className="w-full rounded-xl bg-slate-950/90 border border-slate-700/80 px-3.5 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-emerald-400"
                  >
                    {domains.map((d) => (
                      <option key={d.domain} value={d.domain}>
                        .{d.domain} {d.hasWildcardCert ? '✓ (Wildcard ACM TLS Ready)' : '(ACM DNS Validation)'}
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
                    <div className="text-xs px-3.5 py-2 rounded-xl border bg-emerald-500/10 border-emerald-500/30 text-emerald-300">
                      ✓ <strong>https://{subdomainCheck.customHostname}</strong> passes RFC-1123 validation and is available for atomic Route 53 reservation.
                    </div>
                  );
                }

                if (isOwnedByCurrentDeployment) {
                  return (
                    <div className="text-xs px-3.5 py-2 rounded-xl border bg-cyan-500/10 border-cyan-500/30 text-cyan-200">
                      ✓ <strong>https://{subdomainCheck.customHostname}</strong> is currently bound to your active deployment ({deployment?.deploymentId}).
                    </div>
                  );
                }

                return (
                  <div className="text-xs px-3.5 py-2 rounded-xl border bg-rose-500/10 border-rose-500/30 text-rose-300">
                    ✕ {subdomainCheck.error}
                  </div>
                );
              })()}
            </div>

            {error && (
              <div className="rounded-xl bg-rose-500/15 border border-rose-500/40 p-3.5 text-xs text-rose-200">
                <strong>Deployment Error: </strong>
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
              className={`w-full py-3.5 px-6 rounded-2xl font-bold text-sm text-white bg-gradient-to-r ${currentTheme.primaryBtn} animate-gradient-x shadow-xl shadow-indigo-500/20 hover:scale-[1.005] active:scale-[0.995] transition-all disabled:opacity-50`}
            >
              {isDeploying
                ? '🚀 Provisioning Live AWS Infrastructure...'
                : subdomain.trim()
                ? `🚀 Deploy to ${selectedTarget} → https://${subdomain.trim()}.${selectedDomain}`
                : `🚀 Deploy to ${selectedTarget} (Provision Live AWS Stack)`}
            </button>
          </form>
        )}

        {/* Active Deployment Status & Live URL Panel */}
        {deployment && (
          <div className="rounded-3xl bg-slate-900/85 border border-white/15 p-6 sm:p-7 shadow-2xl backdrop-blur-xl space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono text-xs px-2.5 py-1 rounded-lg bg-slate-950 text-cyan-300 border border-cyan-500/30">
                    {deployment.deploymentId}
                  </span>
                  <span
                    className={`text-xs font-bold px-3 py-1 rounded-full border ${
                      deployment.status === 'LIVE'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50 shadow-sm shadow-emerald-500/20'
                        : deployment.status === 'FAILED'
                        ? 'bg-rose-500/20 text-rose-300 border-rose-400/50'
                        : deployment.status === 'DELETED'
                        ? 'bg-slate-800 text-slate-300 border-slate-600'
                        : 'bg-amber-500/20 text-amber-300 border-amber-400/50 animate-pulse'
                    }`}
                  >
                    {deployment.status === 'LIVE' ? '● LIVE ON AWS' : deployment.status}
                  </span>
                  <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-indigo-500/15 text-indigo-200 border border-indigo-500/30">
                    {deployment.target}
                  </span>
                  <span
                    className={`text-xs font-mono px-2.5 py-1 rounded-lg ${
                      deployment.dryRun
                        ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    }`}
                  >
                    {deployment.dryRun ? 'Dry-Run Mode' : '⚡ Live AWS Mode'}
                  </span>
                </div>
                <p className="text-sm text-slate-300 mt-2 font-mono">
                  {deployment.repoUrl}
                  {deployment.customHostname && (
                    <span className="text-cyan-300 ml-2 font-bold">
                      &rarr; https://{deployment.customHostname}
                    </span>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-2.5">
                {deployment.status === 'FAILED' && (
                  <button
                    type="button"
                    disabled={retryingId === deployment.deploymentId}
                    onClick={() => handleRetry(deployment.deploymentId)}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 shadow-lg hover:opacity-95 transition disabled:opacity-50"
                  >
                    {retryingId === deployment.deploymentId
                      ? '⚡ Self-Healing Build...'
                      : '⚡ Auto-Heal & Retry'}
                  </button>
                )}
                {deployment.status !== 'DELETED' && (
                  <button
                    type="button"
                    disabled={deletingId === deployment.deploymentId}
                    onClick={() => handleDelete(deployment.deploymentId)}
                    className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition disabled:opacity-50"
                  >
                    {deletingId === deployment.deploymentId
                      ? 'Deleting AWS Stack...'
                      : '🗑️ Teardown AWS Stack'}
                  </button>
                )}
              </div>
            </div>

            {/* Phase 8: 4-Stage Autonomous Pipeline Checklist Progress Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              {[
                {
                  label: '1. AST & Repo Scan',
                  done: deployment.checklist?.repositoryAnalyzed,
                },
                {
                  label: '2. Zero-Trust Build',
                  done: deployment.checklist?.buildCompleted,
                },
                {
                  label: '3. AWS Provisioned',
                  done: deployment.checklist?.cloudResourcesConfigured,
                },
                {
                  label: '4. TLS & DNS Verified',
                  done: deployment.checklist?.httpsAndDomainVerified,
                },
              ].map((step, idx) => (
                <div
                  key={idx}
                  className={`rounded-xl px-3.5 py-2.5 border font-mono flex items-center justify-between transition-all ${
                    step.done
                      ? 'bg-gradient-to-r from-emerald-500/20 to-cyan-500/10 border-emerald-400/40 text-emerald-200 shadow-sm'
                      : 'bg-slate-950/70 border-slate-800 text-slate-400'
                  }`}
                >
                  <span>{step.label}</span>
                  <span className="text-sm font-bold">{step.done ? '✓' : '⋯'}</span>
                </div>
              ))}
            </div>

            {/* Phase 8 Remediation Guidance if FAILED */}
            {deployment.status === 'FAILED' && deployment.error && (
              <div className="rounded-2xl bg-rose-500/10 border border-rose-500/30 p-4 text-xs space-y-2">
                <div className="font-bold text-rose-300">
                  ✕ Failure in {deployment.error.phase} ({deployment.error.code}):{' '}
                  {deployment.error.message}
                </div>
                {deployment.error.remediation && (
                  <div className="text-amber-200 bg-amber-500/10 border border-amber-500/30 p-2.5 rounded-xl">
                    💡 <strong>Self-Healing Diagnosis:</strong>{' '}
                    {deployment.error.remediation}
                  </div>
                )}
              </div>
            )}

            {/* Verified URLs (Only shown once status === LIVE) */}
            {deployment.status === 'LIVE' && deployment.url ? (
              <div className="rounded-2xl bg-gradient-to-r from-emerald-500/15 via-cyan-500/10 to-indigo-500/15 border border-emerald-400/40 p-5 space-y-3 shadow-lg">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-emerald-300 font-bold flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
                      {deployment.customHostname
                        ? 'Verified Custom HTTPS Subdomain URL (Route 53 + ACM)'
                        : 'Verified AWS HTTPS Edge URL'}
                    </div>
                    <a
                      href={deployment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-lg font-mono font-bold text-white underline hover:text-cyan-300 break-all mt-1 inline-block"
                    >
                      {deployment.url}
                    </a>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => handleCopy(deployment.url!)}
                      className="px-3.5 py-2 rounded-xl bg-slate-950/90 hover:bg-slate-900 text-xs font-semibold text-slate-200 border border-white/15"
                    >
                      {copiedUrl === deployment.url ? '✓ Copied!' : '📋 Copy URL'}
                    </button>
                    <a
                      href={deployment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 hover:opacity-95 text-xs font-extrabold text-slate-950 shadow-md"
                    >
                      Open Live Site &rarr;
                    </a>
                  </div>
                </div>

                {/* Also show underlying CloudFront distribution URL when custom domain is used */}
                {deployment.infrastructureUrl &&
                  deployment.infrastructureUrl !== deployment.url && (
                    <div className="pt-2.5 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-slate-300">
                        Underlying AWS CloudFront Edge Distribution:{' '}
                        <a
                          href={deployment.infrastructureUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-cyan-300 underline"
                        >
                          {deployment.infrastructureUrl}
                        </a>
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy(deployment.infrastructureUrl!)}
                        className="text-cyan-300 hover:text-white font-mono"
                      >
                        {copiedUrl === deployment.infrastructureUrl
                          ? '✓ Copied!'
                          : 'Copy CloudFront URL'}
                      </button>
                    </div>
                  )}
              </div>
            ) : deployment.status === 'DELETED' ? (
              <div className="rounded-2xl bg-slate-950 border border-slate-800 p-4 text-xs text-slate-300">
                ✓ AWS infrastructure (S3 bucket, CloudFront distribution, OAC, and Route 53 Alias record) has been cleanly torn down and subdomain reservation released.
              </div>
            ) : (
              <div className="rounded-2xl bg-slate-950/90 border border-amber-500/30 p-4 flex items-center justify-between">
                <span className="text-xs text-slate-300">
                  Live URL gated (<code className="text-amber-300">url: null</code>) until AWS Edge, ACM TLS, and Route 53 health probes return HTTP 200
                </span>
                <span className="text-xs font-mono font-semibold text-amber-300 animate-pulse">
                  Verifying HTTPS endpoint...
                </span>
              </div>
            )}

            {/* Provisioned AWS & Route 53 Resources */}
            {deployment.target === 'AMPLIFY' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/90 border border-rose-500/30 p-3.5">
                  <div className="text-rose-300 font-semibold">AWS Amplify App ID</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.amplifyAppId || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-rose-500/30 p-3.5">
                  <div className="text-rose-300 font-semibold">Amplify Branch &amp; Compute</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.amplifyBranchName
                      ? `${deployment.resources.amplifyBranchName} (WEB_COMPUTE SSR)`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-rose-500/30 p-3.5">
                  <div className="text-rose-300 font-semibold">Route 53 Custom Domain / CDN</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.route53RecordName
                      ? `${deployment.resources.route53RecordName} → Amplify`
                      : deployment.infrastructureUrl || 'Default (*.amplifyapp.com)'}
                  </div>
                </div>
              </div>
            ) : deployment.target === 'LAMBDA_API_GATEWAY' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/90 border border-violet-500/30 p-3.5">
                  <div className="text-violet-300 font-semibold">AWS Lambda Function</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.lambdaFunctionName || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-violet-500/30 p-3.5">
                  <div className="text-violet-300 font-semibold">API Gateway v2 (HTTP API)</div>
                  <div
                    className="font-mono text-slate-200 mt-1 truncate"
                    title={deployment.resources.apiGatewayEndpoint}
                  >
                    {deployment.resources.apiGatewayId
                      ? `${deployment.resources.apiGatewayId} ($default)`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-violet-500/30 p-3.5">
                  <div className="text-violet-300 font-semibold">IAM Execution Role &amp; Route 53</div>
                  <div
                    className="font-mono text-slate-200 mt-1 truncate"
                    title={deployment.resources.lambdaRoleArn}
                  >
                    {deployment.resources.route53RecordName
                      ? `${deployment.resources.route53RecordName} → API GW`
                      : deployment.resources.lambdaRoleArn || 'Pending...'}
                  </div>
                </div>
              </div>
            ) : deployment.target === 'ECS_FARGATE' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/90 border border-amber-500/30 p-3.5">
                  <div className="text-amber-300 font-semibold">Amazon ECR Repository &amp; Image</div>
                  <div className="font-mono text-slate-200 mt-1 truncate" title={deployment.resources.ecrRepositoryUri}>
                    {deployment.resources.ecrRepositoryUri || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-amber-500/30 p-3.5">
                  <div className="text-amber-300 font-semibold">ECS Fargate Cluster &amp; Service</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.ecsServiceName
                      ? `${deployment.resources.ecsClusterName} / ${deployment.resources.ecsServiceName}`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-amber-500/30 p-3.5">
                  <div className="text-amber-300 font-semibold">ALB Target Group &amp; Route 53 Alias</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.route53RecordName
                      ? `${deployment.resources.route53RecordName} → ALB`
                      : deployment.resources.albTargetGroupArn || 'Pending...'}
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-950/90 border border-cyan-500/30 p-3.5">
                  <div className="text-cyan-300 font-semibold">Private S3 Bucket</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.s3BucketName || 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-cyan-500/30 p-3.5">
                  <div className="text-cyan-300 font-semibold">CloudFront Distribution &amp; OAC</div>
                  <div className="font-mono text-slate-200 mt-1 truncate">
                    {deployment.resources.cloudFrontDistributionId
                      ? `${deployment.resources.cloudFrontDistributionId} (${deployment.resources.cloudFrontOacId})`
                      : 'Pending...'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-950/90 border border-cyan-500/30 p-3.5">
                  <div className="text-cyan-300 font-semibold">Route 53 Alias &amp; ACM (us-east-1)</div>
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

            {/* Step-by-Step Audit Log Stream with Filter Pills */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <span>📟 Real-Time Telemetry &amp; Audit Stream</span>
                  <span className="text-[11px] font-mono text-slate-400">
                    ({deployment.auditLogs.length} events)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {(['ALL', 'SUCCESS', 'ERROR'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setLogFilter(f)}
                      className={`px-2.5 py-0.5 rounded-md text-[10px] font-mono font-semibold transition ${
                        logFilter === f
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                          : 'bg-slate-950 text-slate-400 hover:text-white'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl bg-slate-950/95 border border-slate-800 p-4 max-h-64 overflow-y-auto font-mono text-xs space-y-1.5 shadow-inner">
                {deployment.auditLogs
                  .filter((l) => logFilter === 'ALL' || l.level === logFilter)
                  .map((log, i) => (
                    <div key={i} className="flex items-start gap-2.5">
                      <span className="text-slate-500 shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-cyan-300 shrink-0 text-[10px]">
                        {log.phase}
                      </span>
                      <span
                        className={
                          log.level === 'ERROR'
                            ? 'text-rose-400'
                            : log.level === 'SUCCESS'
                            ? 'text-emerald-300 font-semibold'
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
          <div className="rounded-3xl bg-slate-900/75 border border-white/10 p-6 shadow-2xl backdrop-blur-xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                  <span>🗂️</span> Active &amp; Historical AWS Deployments
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Click any deployment to inspect its telemetry stream, or teardown its AWS resources and release its Route 53 subdomain.
                </p>
              </div>
            </div>

            <div className="space-y-2.5">
              {history.map((item) => (
                <div
                  key={item.deploymentId}
                  className="rounded-2xl bg-slate-950/85 hover:bg-slate-950 border border-slate-800/90 hover:border-slate-700 p-4 flex flex-wrap items-center justify-between gap-3 transition"
                >
                  <div
                    className="space-y-1 cursor-pointer"
                    onClick={() => setDeployment(item)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-bold text-cyan-300">
                        {item.deploymentId}
                      </span>
                      <span
                        className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${
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
                      <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 text-indigo-300 border border-slate-800">
                        {item.target}
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
                      className="px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700"
                    >
                      Inspect Logs
                    </button>
                    {item.status !== 'DELETED' && (
                      <button
                        type="button"
                        disabled={deletingId === item.deploymentId}
                        onClick={() => handleDelete(item.deploymentId)}
                        className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 disabled:opacity-50"
                      >
                        {deletingId === item.deploymentId
                          ? 'Deleting...'
                          : 'Teardown AWS'}
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
