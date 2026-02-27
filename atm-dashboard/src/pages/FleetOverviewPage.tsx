import { useEffect, useState, useCallback } from 'react';
import { useFleet } from '../context/FleetContext';
import StatusBadge from '../components/StatusBadge';
import type { HealthResponse, MetricsResponse, Server, IdleStatusResponse, IdleStatusWorker } from '../api';
import { post } from '../api';

interface ServerStatus {
  health: HealthResponse | null;
  metrics: MetricsResponse | null;
  reachable: boolean;
}

interface FleetOverviewPageProps {
  onSelectServer: (id: string) => void;
}

export default function FleetOverviewPage({ onSelectServer }: FleetOverviewPageProps) {
  const { servers } = useFleet();
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({});
  const [idleStatus, setIdleStatus] = useState<IdleStatusResponse | null>(null);

  const fetchAll = useCallback(async () => {
    const results: Record<string, ServerStatus> = {};
    const fetches: Promise<void>[] = [];

    for (const s of servers) {
      fetches.push(
        (async () => {
          try {
            const [healthRes, metricsRes] = await Promise.all([
              fetch(`${s.host}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
              fetch(`${s.host}/metrics`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
            ]);
            results[s.id] = { health: healthRes, metrics: metricsRes, reachable: !!healthRes };
          } catch {
            results[s.id] = { health: null, metrics: null, reachable: false };
          }
        })(),
      );
    }

    // Fetch idle-status from ATM (same origin)
    fetches.push(
      fetch('/fleet/idle-status', { signal: AbortSignal.timeout(5000) })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => setIdleStatus(data))
        .catch(() => setIdleStatus(null)),
    );

    await Promise.all(fetches);
    setStatuses(results);
  }, [servers]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Build a lookup from idle-status workers
  const idleWorkerMap = new Map<string, IdleStatusWorker>();
  if (idleStatus?.workers) {
    for (const w of idleStatus.workers) {
      idleWorkerMap.set(w.serverId, w);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Fleet Overview</h1>
        <div className="flex items-center gap-3">
          {idleStatus?.enabled && (
            <span className="text-xs text-gray-500">
              Idle timeout: {Math.round((idleStatus.config.idleTimeoutMs) / 60000)}m
            </span>
          )}
          <button onClick={fetchAll} className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors">
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {servers.map((s) => (
          <ServerCard
            key={s.id}
            server={s}
            status={statuses[s.id]}
            idleWorker={idleWorkerMap.get(s.id) ?? null}
            idleConfig={idleStatus?.config ?? null}
            onClick={() => onSelectServer(s.id)}
            onRefresh={fetchAll}
          />
        ))}
      </div>

      {servers.length === 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-8 text-center text-gray-500">
          No servers configured. Check ATM server environment variables.
        </div>
      )}
    </div>
  );
}

interface ServerCardProps {
  server: Server;
  status?: ServerStatus;
  idleWorker: IdleStatusWorker | null;
  idleConfig: { idleTimeoutMs: number; minRunning: number; pollIntervalMs: number } | null;
  onClick: () => void;
  onRefresh: () => void;
}

function ServerCard({ server, status, idleWorker, idleConfig, onClick, onRefresh }: ServerCardProps) {
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reachable = status?.reachable ?? false;
  const health = status?.health;
  const metrics = status?.metrics;

  const isGh = server.role === 'ghosthands';
  const ec2State = idleWorker?.ec2State ?? null;
  const isStopped = ec2State === 'stopped' || ec2State === 'terminated';
  const isRunning = ec2State === 'running';
  const isStopping = ec2State === 'stopping' || ec2State === 'shutting-down';
  const isPending = ec2State === 'pending';
  const isTransitioning = idleWorker?.transitioning || isStopping || isPending;

  // Non-GH servers (ATM) use reachable alone — they have no idle-monitor entry
  const effectivelyStopped = isGh ? isStopped : false;
  const effectivelyTransitioning = isGh ? isTransitioning : false;

  // Determine border color: stopped = gray, running+reachable = green, transitioning = yellow, else red
  let borderColor: string;
  if (effectivelyStopped) {
    borderColor = 'border-gray-600/30 hover:border-gray-600/50';
  } else if (effectivelyTransitioning) {
    borderColor = 'border-yellow-500/30 hover:border-yellow-500/50';
  } else if (reachable) {
    borderColor = 'border-green-500/30 hover:border-green-500/50';
  } else {
    borderColor = 'border-red-500/30 hover:border-red-500/50';
  }

  const secret = sessionStorage.getItem('atm-deploy-secret') || '';

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!secret) {
      setActionError('Set deploy secret on Kamal page first');
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      await post(`/fleet/${server.id}/wake`, {}, secret);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Wake failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!secret) {
      setActionError('Set deploy secret on Kamal page first');
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      await post(`/fleet/${server.id}/stop`, {}, secret);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Stop failed');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div
      onClick={onClick}
      className={`rounded-lg border ${borderColor} bg-gray-900/50 p-5 text-left transition-all hover:bg-gray-900/80 w-full cursor-pointer`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              effectivelyStopped ? 'bg-gray-500' : effectivelyTransitioning ? 'bg-yellow-400 animate-pulse' : reachable ? 'bg-green-400' : 'bg-red-400'
            }`}
          />
          <span className="text-sm font-semibold text-gray-200">{server.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {isGh && ec2State && <StatusBadge status={ec2State} size="sm" />}
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{server.environment}</span>
        </div>
      </div>

      <div className="text-xs text-gray-500 font-mono mb-3">
        {server.region} &middot; {server.ip || server.host.replace(/^https?:\/\//, '') || 'localhost'}
      </div>

      {/* EC2 idle timer for GH workers */}
      {isGh && idleWorker && isRunning && idleConfig && idleWorker.activeJobs === 0 && (
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="text-gray-500">Idle</span>
          <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-yellow-500/60"
              style={{ width: `${Math.min(100, (idleWorker.idleSinceMs / idleConfig.idleTimeoutMs) * 100)}%` }}
            />
          </div>
          <span className="text-gray-500 tabular-nums">
            {Math.round(idleWorker.idleSinceMs / 60000)}m / {Math.round(idleConfig.idleTimeoutMs / 60000)}m
          </span>
        </div>
      )}

      {/* EC2 state messages for GH workers */}
      {isGh && isStopped && (
        <div className="text-xs text-gray-400 mb-3 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
          </svg>
          EC2 instance {ec2State === 'terminated' ? 'terminated' : 'stopped'}
        </div>
      )}

      {isGh && isStopping && (
        <div className="text-xs text-yellow-400 mb-3 flex items-center gap-1.5 animate-pulse">
          <Spinner />
          Shutting down EC2 instance...
        </div>
      )}

      {isGh && isPending && (
        <div className="text-xs text-yellow-400 mb-3 flex items-center gap-1.5 animate-pulse">
          <Spinner />
          Starting EC2 instance...
        </div>
      )}

      {reachable && health && (
        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
          <div className="rounded bg-gray-800/60 p-2">
            <span className="text-gray-500">Status</span>
            <p className={`font-medium ${health.status === 'healthy' ? 'text-green-400' : 'text-yellow-400'}`}>{health.status}</p>
          </div>
          <div className="rounded bg-gray-800/60 p-2">
            <span className="text-gray-500">Workers</span>
            <p className="font-medium text-gray-200">{health.activeWorkers} active</p>
          </div>
        </div>
      )}

      {reachable && metrics && (
        <div className="space-y-1.5">
          <MiniBar label="CPU" percent={metrics.cpu.usagePercent} />
          <MiniBar label="MEM" percent={metrics.memory.usagePercent} />
          <MiniBar label="DISK" percent={metrics.disk.usagePercent} />
        </div>
      )}

      {!reachable && !effectivelyStopped && !effectivelyTransitioning && (
        <div className="text-xs text-red-400/80 mt-2">Server unreachable</div>
      )}

      {/* Start/Stop buttons — GH workers only, hidden during transitions */}
      {isGh && !isStopping && !isPending && (
        <div className="mt-3 flex items-center gap-2">
          {isStopped && (
            <button
              onClick={handleStart}
              disabled={actionLoading || !secret}
              className="px-3 py-1 text-xs font-medium rounded-md bg-green-600/20 text-green-400 border border-green-500/30 hover:bg-green-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {actionLoading ? (
                <span className="flex items-center gap-1.5">
                  <Spinner /> Starting...
                </span>
              ) : (
                'Start EC2'
              )}
            </button>
          )}
          {isRunning && (idleWorker?.activeJobs ?? 0) === 0 && (
            <button
              onClick={handleStop}
              disabled={actionLoading || !secret}
              className="px-3 py-1 text-xs font-medium rounded-md bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {actionLoading ? (
                <span className="flex items-center gap-1.5">
                  <Spinner /> Stopping...
                </span>
              ) : (
                'Stop EC2'
              )}
            </button>
          )}
          {!secret && (isStopped || isRunning) && (
            <span className="text-xs text-gray-600">Set secret on Kamal page</span>
          )}
          {actionError && <span className="text-xs text-red-400">{actionError}</span>}
        </div>
      )}
    </div>
  );
}

function MiniBar({ label, percent }: { label: string; percent: number }) {
  const color = percent >= 80 ? 'bg-red-500' : percent >= 60 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-500 w-8">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <span className="text-gray-500 tabular-nums w-10 text-right">{percent.toFixed(1)}%</span>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
