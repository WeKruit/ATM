import { useEffect, useState, useCallback } from 'react';
import { get } from '../api';
import type { MetricsResponse } from '../api';
import { useFleet } from '../context/FleetContext';

function ProgressRing({ percent, size = 120, stroke = 10 }: { percent: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(percent, 100) / 100) * circumference;
  const color = percent >= 80 ? '#ef4444' : percent >= 60 ? '#eab308' : '#22c55e';

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1f2937" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-700"
      />
    </svg>
  );
}

function MetricCard({ label, percent, primary, secondary }: { label: string; percent: number; primary: string; secondary: string }) {
  const color = percent >= 80 ? 'text-red-400' : percent >= 60 ? 'text-yellow-400' : 'text-green-400';

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-6 flex flex-col items-center">
      <div className="relative">
        <ProgressRing percent={percent} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-2xl font-bold tabular-nums ${color}`}>{percent.toFixed(1)}%</span>
        </div>
      </div>
      <h3 className="text-sm font-semibold text-gray-300 mt-4">{label}</h3>
      <p className="text-xs text-gray-500 font-mono mt-1 tabular-nums">{primary}</p>
      <p className="text-xs text-gray-600 mt-0.5">{secondary}</p>
    </div>
  );
}

export default function MetricsPage() {
  const { activeServer } = useFleet();
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [history, setHistory] = useState<MetricsResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const base = activeServer?.host ?? '';

  const fetchMetrics = useCallback(async () => {
    if (!activeServer) return;
    try {
      const data = await get<MetricsResponse>('/metrics', base).catch(() => null);
      if (data) {
        setMetrics(data);
        setHistory((prev) => [...prev.slice(-59), data]);
        setError(null);
      } else {
        setError('Metrics endpoint not available on this server');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [activeServer, base]);

  useEffect(() => {
    setHistory([]);
    setLoading(true);
    fetchMetrics();
    if (!autoRefresh) return;
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [fetchMetrics, autoRefresh]);

  if (!activeServer) {
    return <div className="text-center py-20 text-gray-500">Select a server to view metrics.</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <svg className="h-5 w-5 animate-spin mr-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading metrics...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6">
        <h3 className="text-red-400 font-semibold mb-2">Metrics Unavailable</h3>
        <p className="text-red-300/80 text-sm mb-4">{error}</p>
        <button
          onClick={fetchMetrics}
          className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm font-medium hover:bg-red-500/30 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">System Metrics</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500/30"
            />
            Auto-refresh (5s)
          </label>
          <button
            onClick={fetchMetrics}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Gauge cards */}
      {metrics?.cpu && metrics?.memory && metrics?.disk && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <MetricCard label="CPU Usage" percent={metrics.cpu.usagePercent} primary={`${metrics.cpu.usagePercent.toFixed(1)}%`} secondary={`${metrics.cpu.cores} cores`} />
          <MetricCard label="Memory" percent={metrics.memory.usagePercent} primary={`${metrics.memory.usedMb} / ${metrics.memory.totalMb} MB`} secondary={`${(metrics.memory.totalMb - metrics.memory.usedMb)} MB free`} />
          <MetricCard label="Disk" percent={metrics.disk.usagePercent} primary={`${metrics.disk.usedGb} / ${metrics.disk.totalGb} GB`} secondary={`${(metrics.disk.totalGb - metrics.disk.usedGb).toFixed(1)} GB free`} />
        </div>
      )}

      {/* Sparkline history */}
      {history.length > 1 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Recent Trend ({history.length} samples)
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <SparklineCard label="CPU" data={history.filter((m) => m.cpu).map((m) => m.cpu.usagePercent)} />
            <SparklineCard label="Memory" data={history.filter((m) => m.memory).map((m) => m.memory.usagePercent)} />
            <SparklineCard label="Disk" data={history.filter((m) => m.disk).map((m) => m.disk.usagePercent)} />
          </div>
        </div>
      )}
    </div>
  );
}

function SparklineCard({ label, data }: { label: string; data: number[] }) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const width = 300;
  const height = 60;
  const padding = 2;

  const points = data.map((v, i) => {
    const x = padding + (i / Math.max(data.length - 1, 1)) * (width - 2 * padding);
    const y = height - padding - ((v - min) / range) * (height - 2 * padding);
    return `${x},${y}`;
  }).join(' ');

  const latest = data[data.length - 1];
  const color = (latest ?? 0) >= 80 ? '#ef4444' : (latest ?? 0) >= 60 ? '#eab308' : '#22c55e';

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-400">{label}</span>
        <span className="text-xs font-mono tabular-nums" style={{ color }}>
          {(latest ?? 0).toFixed(1)}%
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[60px]">
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
