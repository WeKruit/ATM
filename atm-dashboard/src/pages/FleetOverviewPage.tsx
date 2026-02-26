import { useEffect, useState, useCallback } from 'react';
import { useFleet } from '../context/FleetContext';
import type { HealthResponse, MetricsResponse, Server } from '../api';

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

  const fetchAll = useCallback(async () => {
    const results: Record<string, ServerStatus> = {};
    for (const s of servers) {
      try {
        const [healthRes, metricsRes] = await Promise.all([
          fetch(`${s.host}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
          fetch(`${s.host}/metrics`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
        ]);
        results[s.id] = { health: healthRes, metrics: metricsRes, reachable: !!healthRes };
      } catch {
        results[s.id] = { health: null, metrics: null, reachable: false };
      }
    }
    setStatuses(results);
  }, [servers]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Fleet Overview</h1>
        <button onClick={fetchAll} className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors">
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {servers.map((s) => (
          <ServerCard key={s.id} server={s} status={statuses[s.id]} onClick={() => onSelectServer(s.id)} />
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

function ServerCard({ server, status, onClick }: { server: Server; status?: ServerStatus; onClick: () => void }) {
  const reachable = status?.reachable ?? false;
  const borderColor = reachable ? 'border-green-500/30 hover:border-green-500/50' : 'border-red-500/30 hover:border-red-500/50';
  const health = status?.health;
  const metrics = status?.metrics;

  return (
    <button onClick={onClick} className={`rounded-lg border ${borderColor} bg-gray-900/50 p-5 text-left transition-all hover:bg-gray-900/80 w-full`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${reachable ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-sm font-semibold text-gray-200">{server.name}</span>
        </div>
        <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{server.environment}</span>
      </div>

      <div className="text-xs text-gray-500 font-mono mb-3">{server.region} &middot; {server.ip || server.host.replace(/^https?:\/\//, '') || 'localhost'}</div>

      {reachable && health && (
        <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
          <div className="rounded bg-gray-800/60 p-2">
            <span className="text-gray-500">Status</span>
            <p className={`font-medium ${health.status === 'ok' ? 'text-green-400' : 'text-yellow-400'}`}>{health.status}</p>
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

      {!reachable && (
        <div className="text-xs text-red-400/80 mt-2">Server unreachable</div>
      )}
    </button>
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
