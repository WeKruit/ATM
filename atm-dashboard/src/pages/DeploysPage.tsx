import { useEffect, useState, useCallback } from 'react';
import { get } from '../api';
import type { Deploy } from '../api';
import { useFleet } from '../context/FleetContext';
import StatusBadge from '../components/StatusBadge';
import DataTable, { type Column } from '../components/DataTable';
import LogStream from '../components/LogStream';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const columns: Column<Deploy>[] = [
  {
    key: 'status',
    label: 'Status',
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: 'imageTag',
    label: 'Image Tag',
    mono: true,
    render: (row) => <span className="text-gray-200">{row.imageTag}</span>,
  },
  {
    key: 'triggeredBy',
    label: 'Trigger',
    render: (row) => (
      <span className="text-xs font-medium text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
        {row.triggeredBy}
      </span>
    ),
  },
  {
    key: 'startedAt',
    label: 'Started',
    render: (row) => <span className="text-gray-400 text-xs">{timeAgo(row.startedAt)}</span>,
  },
  {
    key: 'durationMs',
    label: 'Duration',
    align: 'right' as const,
    render: (row) => <span className="font-mono text-xs text-gray-300">{formatDuration(row.durationMs)}</span>,
  },
  {
    key: 'error',
    label: 'Error',
    render: (row) =>
      row.error ? (
        <span className="text-red-400 text-xs truncate max-w-[200px] inline-block" title={row.error}>
          {row.error}
        </span>
      ) : (
        <span className="text-gray-600">-</span>
      ),
  },
];

export default function DeploysPage() {
  const { activeServer } = useFleet();
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showStream, setShowStream] = useState(false);
  const [selected, setSelected] = useState<Deploy | null>(null);

  const base = activeServer?.host ?? '';

  const fetchDeploys = useCallback(async () => {
    if (!activeServer) return;
    try {
      const data = await get<Deploy[]>('/deploys?limit=50', base).catch(() => [] as Deploy[]);
      setDeploys(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [activeServer, base]);

  useEffect(() => {
    setLoading(true);
    fetchDeploys();
    const interval = setInterval(fetchDeploys, 15000);
    return () => clearInterval(interval);
  }, [fetchDeploys]);

  if (!activeServer) {
    return <div className="text-center py-20 text-gray-500">Select a server to view deploys.</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Deploy History</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowStream(!showStream)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              showStream
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
            }`}
          >
            {showStream ? 'Hide Live Stream' : 'Show Live Stream'}
          </button>
          <button
            onClick={fetchDeploys}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Live Stream */}
      {showStream && (
        <LogStream
          url={`${base}/deploy/stream`}
          active={showStream}
          onComplete={() => fetchDeploys()}
        />
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Deploy Table */}
      <DataTable columns={columns} data={deploys} loading={loading} emptyMessage="No deploys recorded yet" />

      {/* Selected Deploy Detail */}
      {selected && (
        <div className="rounded-lg border border-gray-700 bg-gray-900/80 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-200">Deploy Detail</h3>
            <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 text-sm">
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-500 text-xs uppercase tracking-wider">ID</span>
              <p className="font-mono text-xs text-gray-300 mt-0.5">{selected.id}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs uppercase tracking-wider">Image Tag</span>
              <p className="font-mono text-xs text-gray-300 mt-0.5">{selected.imageTag}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs uppercase tracking-wider">Previous Tag</span>
              <p className="font-mono text-xs text-gray-300 mt-0.5">{selected.previousImageTag || '-'}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs uppercase tracking-wider">Commit SHA</span>
              <p className="font-mono text-xs text-gray-300 mt-0.5">{selected.commitSha || '-'}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs uppercase tracking-wider">Started At</span>
              <p className="text-xs text-gray-300 mt-0.5">{new Date(selected.startedAt).toLocaleString()}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs uppercase tracking-wider">Completed At</span>
              <p className="text-xs text-gray-300 mt-0.5">
                {selected.completedAt ? new Date(selected.completedAt).toLocaleString() : '-'}
              </p>
            </div>
          </div>
          {selected.error && (
            <div className="mt-3 p-3 rounded bg-red-500/10 border border-red-500/20">
              <span className="text-red-400 text-xs font-medium">Error:</span>
              <p className="text-red-300/80 text-xs font-mono mt-1 whitespace-pre-wrap">{selected.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
