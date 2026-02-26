import { useEffect, useState, useCallback } from 'react';
import { get } from '../api';
import type { Container, Worker } from '../api';
import { useFleet } from '../context/FleetContext';
import StatusBadge from '../components/StatusBadge';
import DataTable, { type Column } from '../components/DataTable';

const containerColumns: Column<Container>[] = [
  {
    key: 'state',
    label: 'State',
    render: (row) => <StatusBadge status={row.state} />,
  },
  {
    key: 'name',
    label: 'Name',
    mono: true,
    render: (row) => <span className="text-gray-200">{row.name}</span>,
  },
  {
    key: 'id',
    label: 'ID',
    mono: true,
    render: (row) => <span className="text-gray-400">{row.id}</span>,
  },
  {
    key: 'image',
    label: 'Image',
    mono: true,
    render: (row) => {
      const short = row.image.length > 50 ? '...' + row.image.slice(-40) : row.image;
      return <span className="text-gray-400 text-xs" title={row.image}>{short}</span>;
    },
  },
  {
    key: 'status',
    label: 'Status',
    render: (row) => <span className="text-gray-400 text-xs">{row.status}</span>,
  },
  {
    key: 'ports',
    label: 'Ports',
    render: (row) => (
      <span className="font-mono text-xs text-gray-400">
        {Array.isArray(row.ports) ? row.ports.join(', ') : row.ports || '-'}
      </span>
    ),
  },
];

const workerColumns: Column<Worker>[] = [
  {
    key: 'status',
    label: 'Status',
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: 'containerName',
    label: 'Container',
    mono: true,
    render: (row) => <span className="text-gray-200">{row.containerName}</span>,
  },
  {
    key: 'workerId',
    label: 'Worker ID',
    mono: true,
    render: (row) => (
      <span className="text-gray-400 text-xs" title={row.workerId}>
        {row.workerId.length > 20 ? row.workerId.slice(0, 8) + '...' : row.workerId}
      </span>
    ),
  },
  {
    key: 'activeJobs',
    label: 'Active Jobs',
    align: 'center' as const,
    render: (row) => (
      <span className={`font-mono text-sm font-bold ${row.activeJobs > 0 ? 'text-yellow-400' : 'text-gray-400'}`}>
        {row.activeJobs}
      </span>
    ),
  },
  {
    key: 'statusPort',
    label: 'Port',
    align: 'right' as const,
    mono: true,
    render: (row) => <span className="text-gray-400">{row.statusPort}</span>,
  },
  {
    key: 'uptime',
    label: 'Uptime',
    align: 'right' as const,
    render: (row) => <span className="text-gray-400 text-xs">{row.uptime}s</span>,
  },
];

export default function FleetPage() {
  const { activeServer } = useFleet();
  const [containers, setContainers] = useState<Container[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const base = activeServer?.host ?? '';

  const fetchAll = useCallback(async () => {
    if (!activeServer) return;
    try {
      const [c, w] = await Promise.all([
        get<Container[]>('/containers', base).catch(() => [] as Container[]),
        get<Worker[]>('/workers', base).catch(() => [] as Worker[]),
      ]);
      setContainers(c);
      setWorkers(w);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [activeServer, base]);

  useEffect(() => {
    setLoading(true);
    fetchAll();
    const interval = setInterval(fetchAll, 10000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (!activeServer) {
    return <div className="text-center py-20 text-gray-500">Select a server to view containers.</div>;
  }

  const runningCount = containers.filter((c) => c.state === 'running').length;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Containers & Workers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {runningCount} running / {containers.length} total containers
          </p>
        </div>
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

      {/* Containers */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Docker Containers</h2>
        <DataTable columns={containerColumns} data={containers} loading={loading} emptyMessage="No containers found" />
      </div>

      {/* Workers */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Workers</h2>
        <DataTable columns={workerColumns} data={workers} loading={loading} emptyMessage="No workers registered" />
      </div>
    </div>
  );
}
