import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { get, post } from '../api';
import type { HealthResponse, MetricsResponse, VersionResponse, GhVersionInfo, IdleStatusResponse, IdleStatusWorker } from '../api';
import { useFleet } from '../context/FleetContext';
import StatusBadge from '../components/StatusBadge';

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function MetricBar({ label, value, total, unit, percent }: { label: string; value: number; total: number; unit: string; percent: number }) {
  const color = percent >= 80 ? 'bg-red-500' : percent >= 60 ? 'bg-yellow-500' : 'bg-green-500';
  const bgColor = percent >= 80 ? 'bg-red-500/10' : percent >= 60 ? 'bg-yellow-500/10' : 'bg-green-500/10';
  const textColor = percent >= 80 ? 'text-red-400' : percent >= 60 ? 'text-yellow-400' : 'text-green-400';

  return (
    <div className={`rounded-lg border border-gray-800 ${bgColor} p-4`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-300">{label}</span>
        <span className={`text-lg font-bold tabular-nums ${textColor}`}>{percent.toFixed(1)}%</span>
      </div>
      <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <div className="mt-1.5 text-xs text-gray-500 font-mono tabular-nums">
        {value.toFixed(1)} / {total.toFixed(1)} {unit}
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const { activeServer } = useFleet();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [idleStatus, setIdleStatus] = useState<IdleStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ec2ActionLoading, setEc2ActionLoading] = useState(false);
  const [ec2ActionError, setEc2ActionError] = useState<string | null>(null);

  const base = activeServer?.host ?? '';
  const isGh = activeServer?.role === 'ghosthands';

  const fetchAll = useCallback(async () => {
    if (!activeServer) return;
    try {
      const fetches: Promise<unknown>[] = [
        get<HealthResponse>('/health', base).catch(() => null),
        get<MetricsResponse>('/metrics', base).catch(() => null),
        get<VersionResponse>('/version', base).catch(() => null),
      ];
      // Fetch idle-status for GH workers (always from ATM origin, not proxied)
      if (isGh) {
        fetches.push(
          get<IdleStatusResponse>('/fleet/idle-status').catch(() => null),
        );
      }
      const [h, m, v, idle] = await Promise.all(fetches) as [
        HealthResponse | null, MetricsResponse | null, VersionResponse | null, IdleStatusResponse | null
      ];
      setHealth(h);
      setMetrics(m);
      setVersion(v);
      if (isGh) setIdleStatus(idle);
      // Only show error if health (the primary endpoint) failed
      setError(h ? null : 'Server health endpoint unreachable');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [activeServer, base, isGh]);

  useEffect(() => {
    setLoading(true);
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (!activeServer) {
    return (
      <div className="text-center py-20 text-gray-500">
        Select a server to view its overview.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <svg className="h-5 w-5 animate-spin mr-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading overview...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6">
        <h3 className="text-red-400 font-semibold mb-2">Connection Error</h3>
        <p className="text-red-300/80 text-sm mb-4">{error}</p>
        <button
          onClick={fetchAll}
          className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/30 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Server Status"
          value={<StatusBadge status={health?.status ?? 'unknown'} size="md" />}
        />
        <StatCard
          label="Worker"
          value={
            health?.workerStatus === 'idle' ? (
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                </span>
                <div>
                  <span className="text-lg font-bold text-green-400">Running</span>
                  <span className="text-lg text-gray-500 font-light mx-1">&middot;</span>
                  <span className="text-lg text-gray-400">Idle</span>
                  <p className="text-xs text-gray-500 mt-0.5">Healthy, awaiting jobs</p>
                </div>
              </div>
            ) : health?.activeWorkers ? (
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-cyan-400 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <div>
                  <span className="text-lg font-bold text-cyan-400">Running</span>
                  <span className="text-lg text-gray-500 font-light mx-1">&middot;</span>
                  <span className="text-lg text-cyan-300">{health.activeWorkers} Job{health.activeWorkers > 1 ? 's' : ''}</span>
                  <p className="text-xs text-gray-500 mt-0.5">Processing task{health.activeWorkers > 1 ? 's' : ''}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full h-2.5 w-2.5 bg-gray-500" />
                <span className="text-lg font-bold text-gray-400">Offline</span>
              </div>
            )
          }
        />
        <StatCard
          label="Deploy Safe"
          value={<StatusBadge status={health?.deploySafe ? 'yes' : 'no'} size="md" />}
        />
        <StatCard
          label="Uptime"
          value={
            <span className="text-2xl font-bold tabular-nums text-gray-100">
              {health ? formatUptime(health.uptimeMs) : '-'}
            </span>
          }
        />
      </div>

      {/* EC2 Instance Controls — GH workers only */}
      {isGh && <Ec2Panel
        serverId={activeServer?.id ?? ''}
        idleStatus={idleStatus}
        actionLoading={ec2ActionLoading}
        actionError={ec2ActionError}
        onAction={async (action) => {
          const secret = sessionStorage.getItem('atm-deploy-secret') || '';
          if (!secret) {
            setEc2ActionError('Set deploy secret on Kamal page first');
            return;
          }
          setEc2ActionLoading(true);
          setEc2ActionError(null);
          try {
            const endpoint = action === 'start'
              ? `/fleet/${activeServer!.id}/wake`
              : `/fleet/${activeServer!.id}/stop`;
            await post(endpoint, {}, secret);
            // Refresh after a brief delay to let state propagate
            setTimeout(fetchAll, 2000);
          } catch (err) {
            setEc2ActionError(err instanceof Error ? err.message : `${action} failed`);
          } finally {
            setEc2ActionLoading(false);
          }
        }}
      />}

      {/* Current Deploy */}
      {health?.currentDeploy && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 flex items-center gap-3">
          <svg className="h-5 w-5 text-yellow-400 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div>
            <p className="text-yellow-400 font-medium text-sm">Deploy In Progress</p>
            <p className="text-yellow-300/70 text-xs font-mono mt-0.5">{health.currentDeploy}</p>
          </div>
        </div>
      )}

      {/* Metrics */}
      {metrics?.cpu && metrics?.memory && metrics?.disk && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">System Resources</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MetricBar label="CPU" value={metrics.cpu.usagePercent} total={100} unit={`% (${metrics.cpu.cores} cores)`} percent={metrics.cpu.usagePercent} />
            <MetricBar label="Memory" value={metrics.memory.usedMb} total={metrics.memory.totalMb} unit="MB" percent={metrics.memory.usagePercent} />
            <MetricBar label="Disk" value={metrics.disk.usedGb} total={metrics.disk.totalGb} unit="GB" percent={metrics.disk.usagePercent} />
          </div>
        </div>
      )}

      {/* Version Info */}
      {version && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Version Info</h2>
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-500 text-xs uppercase tracking-wider">Deploy Server</span>
                <p className="font-mono text-gray-200 mt-1">{version.deployServer}</p>
              </div>
              <div>
                <span className="text-gray-500 text-xs uppercase tracking-wider">Version</span>
                <p className="font-mono text-gray-200 mt-1">{version.version}</p>
              </div>
              <div>
                <span className="text-gray-500 text-xs uppercase tracking-wider">GH Environment</span>
                <p className="font-mono text-gray-200 mt-1">
                  {version.ghosthands && typeof version.ghosthands === 'object' && 'environment' in version.ghosthands
                    ? (version.ghosthands as GhVersionInfo).environment
                    : 'unreachable'}
                </p>
              </div>
              <div>
                <span className="text-gray-500 text-xs uppercase tracking-wider">Server Uptime</span>
                <p className="font-mono text-gray-200 mt-1">{formatUptime(version.uptimeMs)}</p>
              </div>
            </div>
            {version.ghosthands && typeof version.ghosthands === 'object' && 'commit_sha' in version.ghosthands && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-4 pt-4 border-t border-gray-800">
                <div>
                  <span className="text-gray-500 text-xs uppercase tracking-wider">Commit SHA</span>
                  <p className="font-mono text-gray-200 mt-1 text-xs">{(version.ghosthands as GhVersionInfo).commit_sha.slice(0, 12)}</p>
                </div>
                <div>
                  <span className="text-gray-500 text-xs uppercase tracking-wider">Image Tag</span>
                  <p className="font-mono text-gray-200 mt-1 text-xs truncate" title={(version.ghosthands as GhVersionInfo).image_tag}>
                    {(version.ghosthands as GhVersionInfo).image_tag.slice(0, 20)}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500 text-xs uppercase tracking-wider">Build Time</span>
                  <p className="font-mono text-gray-200 mt-1 text-xs">{new Date((version.ghosthands as GhVersionInfo).build_time).toLocaleString()}</p>
                </div>
                <div>
                  <span className="text-gray-500 text-xs uppercase tracking-wider">GH Uptime</span>
                  <p className="font-mono text-gray-200 mt-1 text-xs">{formatUptime((version.ghosthands as GhVersionInfo).uptime_ms)}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* API / Worker Status */}
      {health && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Service Health</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-400">GH API</p>
                <p className="text-xs text-gray-600 mt-0.5">Port 3100</p>
              </div>
              <StatusBadge status={health.apiHealthy ? 'healthy' : 'degraded'} />
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-400">GH Worker</p>
                <p className="text-xs text-gray-600 mt-0.5">
                  Port 3101 — {health.workerStatus === 'idle' ? 'awaiting jobs' : health.activeWorkers ? `${health.activeWorkers} active` : health.workerStatus}
                </p>
              </div>
              <StatusBadge status={health.workerStatus === 'idle' ? 'running' : health.activeWorkers ? 'active' : health.workerStatus} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{label}</p>
      {value}
    </div>
  );
}

// ── EC2 Instance Panel ──────────────────────────────────────────────

function Ec2Panel({
  serverId,
  idleStatus,
  actionLoading,
  actionError,
  onAction,
}: {
  serverId: string;
  idleStatus: IdleStatusResponse | null;
  actionLoading: boolean;
  actionError: string | null;
  onAction: (action: 'start' | 'stop') => void;
}) {
  const worker = idleStatus?.workers?.find((w: IdleStatusWorker) => w.serverId === serverId) ?? null;
  const ec2State = worker?.ec2State ?? 'unknown';
  const isStopped = ec2State === 'stopped';
  const isRunning = ec2State === 'running';
  const isStopping = ec2State === 'stopping';
  const isPending = ec2State === 'pending';
  const activeJobs = worker?.activeJobs ?? 0;
  const secret = sessionStorage.getItem('atm-deploy-secret') || '';

  if (!idleStatus?.enabled) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">EC2 Instance</h2>
        <p className="text-xs text-gray-500">Idle monitor not enabled</p>
      </div>
    );
  }

  // Border color based on state
  const borderColor = isStopped
    ? 'border-gray-700'
    : isStopping || isPending
      ? 'border-yellow-500/30'
      : isRunning
        ? 'border-green-500/30'
        : 'border-gray-800';

  return (
    <div className={`rounded-lg border ${borderColor} bg-gray-900/50 p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">EC2 Instance</h2>
        <StatusBadge status={ec2State} size="md" />
      </div>

      {/* State-specific messages */}
      {isStopping && (
        <div className="flex items-center gap-2 text-yellow-400 text-sm mb-3 animate-pulse">
          <Spinner />
          Shutting down EC2 instance...
        </div>
      )}

      {isPending && (
        <div className="flex items-center gap-2 text-yellow-400 text-sm mb-3 animate-pulse">
          <Spinner />
          Starting EC2 instance...
        </div>
      )}

      {isStopped && (
        <div className="flex items-center gap-2 text-gray-400 text-sm mb-3">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
          </svg>
          Instance is stopped. Start it to resume processing jobs.
        </div>
      )}

      {/* Idle timer */}
      {isRunning && idleStatus?.config && worker && activeJobs === 0 && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>Idle timer</span>
            <span className="tabular-nums">
              {Math.round(worker.idleSinceMs / 60000)}m / {Math.round(idleStatus.config.idleTimeoutMs / 60000)}m until auto-stop
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-yellow-500/60 transition-all duration-1000"
              style={{ width: `${Math.min(100, (worker.idleSinceMs / idleStatus.config.idleTimeoutMs) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Instance details */}
      {worker && (
        <div className="grid grid-cols-3 gap-4 text-xs mb-3">
          <div>
            <span className="text-gray-500">Instance ID</span>
            <p className="font-mono text-gray-300 mt-0.5">{worker.instanceId ?? 'N/A'}</p>
          </div>
          <div>
            <span className="text-gray-500">Public IP</span>
            <p className="font-mono text-gray-300 mt-0.5">{worker.ip}</p>
          </div>
          <div>
            <span className="text-gray-500">Active Jobs</span>
            <p className={`font-mono mt-0.5 ${activeJobs > 0 ? 'text-cyan-400 font-bold' : 'text-gray-300'}`}>{activeJobs}</p>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!isStopping && !isPending && (
        <div className="flex items-center gap-3 pt-2 border-t border-gray-800">
          {isStopped && (
            <button
              onClick={() => onAction('start')}
              disabled={actionLoading || !secret}
              className="px-4 py-1.5 text-sm font-medium rounded-lg bg-green-600/20 text-green-400 border border-green-500/30 hover:bg-green-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {actionLoading ? (
                <span className="flex items-center gap-1.5"><Spinner /> Starting...</span>
              ) : (
                'Start EC2'
              )}
            </button>
          )}
          {isRunning && activeJobs === 0 && (
            <button
              onClick={() => onAction('stop')}
              disabled={actionLoading || !secret}
              className="px-4 py-1.5 text-sm font-medium rounded-lg bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {actionLoading ? (
                <span className="flex items-center gap-1.5"><Spinner /> Stopping...</span>
              ) : (
                'Stop EC2'
              )}
            </button>
          )}
          {isRunning && activeJobs > 0 && (
            <span className="text-xs text-gray-500">Worker has active jobs -- drain before stopping</span>
          )}
          {!secret && (isStopped || isRunning) && (
            <span className="text-xs text-gray-600">Enter deploy secret on Kamal tab to enable controls</span>
          )}
          {actionError && <span className="text-xs text-red-400">{actionError}</span>}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
