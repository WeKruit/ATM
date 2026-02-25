import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { get } from '../api';
import type { HealthResponse, MetricsResponse, VersionResponse } from '../api';
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
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [version, setVersion] = useState<VersionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [h, m, v] = await Promise.all([
        get<HealthResponse>('/health'),
        get<MetricsResponse>('/metrics'),
        get<VersionResponse>('/version'),
      ]);
      setHealth(h);
      setMetrics(m);
      setVersion(v);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

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
          label="Active Workers"
          value={
            <span className="text-2xl font-bold tabular-nums text-gray-100">
              {health?.activeWorkers ?? 0}
            </span>
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
      {metrics && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">System Resources</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MetricBar
              label="CPU"
              value={metrics.cpu.usagePercent}
              total={100}
              unit={`% (${metrics.cpu.cores} cores)`}
              percent={metrics.cpu.usagePercent}
            />
            <MetricBar
              label="Memory"
              value={metrics.memory.usedMb}
              total={metrics.memory.totalMb}
              unit="MB"
              percent={metrics.memory.usagePercent}
            />
            <MetricBar
              label="Disk"
              value={metrics.disk.usedGb}
              total={metrics.disk.totalGb}
              unit="GB"
              percent={metrics.disk.usagePercent}
            />
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
                <span className="text-gray-500 text-xs uppercase tracking-wider">Ghost-Hands</span>
                <p className="font-mono text-gray-200 mt-1">{version.ghosthands}</p>
              </div>
              <div>
                <span className="text-gray-500 text-xs uppercase tracking-wider">Server Uptime</span>
                <p className="font-mono text-gray-200 mt-1">{formatUptime(version.uptimeMs)}</p>
              </div>
            </div>
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
                <p className="text-xs text-gray-600 mt-0.5">Port 3101</p>
              </div>
              <StatusBadge status={health.workerStatus} />
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
