import { useEffect, useState, useCallback } from 'react';
import { get } from '../api';
import type { KamalStatus, KamalAuditEntry } from '../api';
import StatusBadge from '../components/StatusBadge';
import LogStream from '../components/LogStream';
import DataTable, { type Column } from '../components/DataTable';

const auditColumns: Column<KamalAuditEntry>[] = [
  {
    key: 'timestamp',
    label: 'Timestamp',
    mono: true,
    render: (row) => <span className="text-gray-400 text-xs">{row.timestamp || '-'}</span>,
  },
  {
    key: 'action',
    label: 'Action',
    render: (row) => {
      if (!row.action) return <span className="text-gray-500">-</span>;
      const color =
        row.action === 'deploy'
          ? 'bg-blue-500/10 text-blue-400'
          : row.action === 'rollback'
            ? 'bg-yellow-500/10 text-yellow-400'
            : 'bg-gray-500/10 text-gray-400';
      return (
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${color}`}>
          {row.action}
        </span>
      );
    },
  },
  {
    key: 'performer',
    label: 'Performer',
    mono: true,
    render: (row) => <span className="text-gray-300 text-xs">{row.performer || '-'}</span>,
  },
  {
    key: 'details',
    label: 'Details',
    render: (row) => <span className="text-gray-400 text-xs">{row.details}</span>,
  },
];

export default function KamalPage() {
  // Kamal is global (managed by ATM), always fetch from same origin
  const [status, setStatus] = useState<KamalStatus | null>(null);
  const [audit, setAudit] = useState<KamalAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showStream, setShowStream] = useState(false);
  const [deploying, setDeploying] = useState(false);

  const base = '';

  const fetchAll = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        get<KamalStatus>('/kamal/status', base),
        get<KamalAuditEntry[]>('/kamal/audit', base).catch(() => []),
      ]);
      setStatus(s);
      setAudit(a);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    setLoading(true);
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <svg className="h-5 w-5 animate-spin mr-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading Kamal status...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Kamal Deployments</h1>
        <button
          onClick={fetchAll}
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Kamal Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
          <span className="text-xs text-gray-500 uppercase tracking-wider">CLI Available</span>
          <div className="mt-2">
            <StatusBadge status={status?.available ? 'available' : 'unavailable'} size="md" />
          </div>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Deploy Lock</span>
          <div className="mt-2">
            {status?.available ? (
              <StatusBadge status={status?.locked ? 'locked' : 'unlocked'} size="md" />
            ) : (
              <span className="text-gray-600 text-sm">-</span>
            )}
          </div>
          {status?.locked && status.holder && (
            <p className="text-xs text-yellow-400/80 mt-2">Held by: <span className="font-mono">{status.holder}</span></p>
          )}
          {status?.locked && status.reason && (
            <p className="text-xs text-gray-500 mt-1">{status.reason}</p>
          )}
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
          <span className="text-xs text-gray-500 uppercase tracking-wider">Audit Entries</span>
          <div className="mt-2">
            <span className="text-2xl font-bold tabular-nums text-gray-100">{audit.length}</span>
          </div>
        </div>
      </div>

      {/* Deploy Actions */}
      {status?.available && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-6">
          <h2 className="text-sm font-semibold text-gray-300 mb-4">Deploy Actions</h2>
          <div className="flex items-center gap-4">
            <button
              onClick={() => { setDeploying(true); setShowStream(true); }}
              disabled={deploying || status.locked}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                deploying || status.locked
                  ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-500'
              }`}
            >
              {deploying ? 'Deploying...' : 'Deploy via Kamal'}
            </button>
            <p className="text-xs text-gray-500">
              Trigger a Kamal deploy for the current environment.
              Requires X-Deploy-Secret authentication via the API.
            </p>
          </div>
          {status.locked && (
            <p className="text-xs text-yellow-400/80 mt-3">
              Deploy lock is active. Wait for the current deploy to complete before starting a new one.
            </p>
          )}
        </div>
      )}

      {/* Not Available Info */}
      {status && !status.available && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-6">
          <h3 className="text-sm font-semibold text-yellow-400 mb-2">Kamal CLI Not Found</h3>
          <p className="text-sm text-yellow-400/70 mb-4">
            The Kamal CLI is not installed on this server. Kamal-based deployments are unavailable.
            Docker API deploys (POST /deploy) are still functional.
          </p>
          <div className="rounded-lg border border-gray-800 bg-gray-950 p-4 font-mono text-xs text-gray-400">
            <p><span className="text-gray-600"># Install Kamal</span></p>
            <p>gem install kamal</p>
            <p className="mt-2"><span className="text-gray-600"># Verify installation</span></p>
            <p>kamal version</p>
          </div>
        </div>
      )}

      {/* Live Stream */}
      {showStream && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Live Deploy Output</h2>
          <LogStream
            url={`${base}/deploy/stream`}
            active={showStream}
            onComplete={() => { setDeploying(false); fetchAll(); }}
          />
        </div>
      )}

      {/* Audit Log */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Audit Log</h2>
        <DataTable columns={auditColumns} data={audit} emptyMessage="No audit entries found" />
      </div>
    </div>
  );
}
