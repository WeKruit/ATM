import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { get, getWithAuth } from '../api';
import type { SecretsStatus, SecretKey, SecretEntry } from '../api';
import StatusBadge from '../components/StatusBadge';
import { useFleet } from '../context/FleetContext';

export default function SecretsPage() {
  const { activeServer } = useFleet();
  const base = activeServer?.host || '';

  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState(() => sessionStorage.getItem('atm-deploy-secret') || '');
  const [keys, setKeys] = useState<SecretKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await get<SecretsStatus>('/secrets/status', base);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleSecretChange = (val: string) => {
    setSecret(val);
    sessionStorage.setItem('atm-deploy-secret', val);
  };

  const loadKeys = async () => {
    if (!secret) return;
    setKeysLoading(true);
    try {
      const data = await getWithAuth<SecretKey[]>('/secrets/list', secret, base);
      setKeys(data);
      setRevealed({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load secrets');
    } finally {
      setKeysLoading(false);
    }
  };

  const revealSecret = async (key: string) => {
    if (!secret) return;
    try {
      const data = await getWithAuth<SecretEntry>(`/secrets/${encodeURIComponent(key)}`, secret, base);
      setRevealed((prev) => ({ ...prev, [key]: data.value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to reveal ${key}`);
    }
  };

  const copyToClipboard = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <svg className="h-5 w-5 animate-spin mr-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Checking secrets status...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Secrets Management</h1>
        <button
          onClick={fetchStatus}
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

      {/* Auth Section */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Authentication</h2>
        <div className="flex items-center gap-3">
          <input
            type="password"
            value={secret}
            onChange={(e) => handleSecretChange(e.target.value)}
            placeholder="Deploy secret (X-Deploy-Secret)"
            className="flex-1 bg-gray-800 border border-gray-700 text-gray-300 text-sm rounded-lg px-3 py-2 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder:text-gray-600"
          />
          <button
            onClick={loadKeys}
            disabled={!secret || keysLoading}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              !secret || keysLoading
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-500'
            }`}
          >
            {keysLoading ? 'Loading...' : 'Load Secrets'}
          </button>
        </div>
      </div>

      {/* Secrets Table */}
      {keys.length > 0 && (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 bg-gray-900/80">
            <h2 className="text-sm font-semibold text-gray-300">{keys.length} Secret{keys.length !== 1 ? 's' : ''}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/80">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Key</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Value</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60">
                {keys.map((k) => (
                  <tr key={k.key} className="hover:bg-gray-800/30">
                    <td className="px-4 py-3 font-mono text-xs text-gray-200">{k.key}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400 max-w-[300px]">
                      {revealed[k.key] !== undefined ? (
                        <span className="text-green-400 break-all">{revealed[k.key]}</span>
                      ) : (
                        <span className="text-gray-600">********</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {revealed[k.key] === undefined ? (
                          <button
                            onClick={() => revealSecret(k.key)}
                            className="px-2 py-1 text-xs font-medium rounded bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors"
                          >
                            Reveal
                          </button>
                        ) : (
                          <button
                            onClick={() => copyToClipboard(k.key, revealed[k.key])}
                            className={`px-2 py-1 text-xs font-medium rounded border transition-colors ${
                              copied === k.key
                                ? 'bg-green-500/20 text-green-400 border-green-500/30'
                                : 'bg-gray-800 text-gray-400 border-gray-700 hover:bg-gray-700'
                            }`}
                          >
                            {copied === k.key ? 'Copied!' : 'Copy'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Connection Status */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300">Infisical Connection</h2>
          <StatusBadge status={status?.connected ? 'connected' : 'disconnected'} size="md" />
        </div>

        <div className="p-6">
          {status?.connected ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <InfoItem label="Project ID" value={status.projectId || '-'} mono />
                <InfoItem label="Environment" value={status.environment || '-'} />
                <InfoItem
                  label="Secrets Loaded"
                  value={
                    <span className="text-2xl font-bold tabular-nums text-green-400">
                      {status.secretCount ?? 0}
                    </span>
                  }
                />
              </div>

              <div className="rounded-lg bg-green-500/5 border border-green-500/20 p-4">
                <p className="text-sm text-green-400/80">
                  Infisical is connected and managing secrets for this environment.
                  Secrets are loaded at server startup and can be refreshed via the admin endpoint.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 p-4">
                <p className="text-sm text-yellow-400/80 mb-2">
                  Infisical is not connected. The server is using environment variables from docker-compose
                  and/or AWS Secrets Manager as fallback.
                </p>
                {status?.error && (
                  <p className="text-xs text-red-400/80 font-mono mt-2">
                    Error: {status.error}
                  </p>
                )}
              </div>

              <div>
                <h3 className="text-sm font-medium text-gray-400 mb-2">Required Configuration</h3>
                <div className="rounded-lg border border-gray-800 bg-gray-950 p-4 font-mono text-xs text-gray-400 space-y-1">
                  <p><span className="text-gray-600"># .env variables for Infisical</span></p>
                  <p>INFISICAL_CLIENT_ID=<span className="text-gray-600">&lt;machine-identity-id&gt;</span></p>
                  <p>INFISICAL_CLIENT_SECRET=<span className="text-gray-600">&lt;machine-identity-secret&gt;</span></p>
                  <p>INFISICAL_PROJECT_ID=<span className="text-gray-600">&lt;project-id&gt;</span></p>
                  <p>INFISICAL_ENVIRONMENT=<span className="text-gray-600">staging | production</span></p>
                  <p>INFISICAL_SITE_URL=<span className="text-gray-600">https://infisical.yourdomain.com</span></p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Secrets Provider Stack */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Provider Precedence</h2>
        <div className="space-y-2">
          <ProviderRow
            number={1}
            name="Docker Compose env_file"
            description="Environment variables from docker-compose.yml"
            status="active"
          />
          <ProviderRow
            number={2}
            name="Infisical (Self-hosted)"
            description="Self-hosted secrets manager on Fly.io"
            status={status?.connected ? 'active' : 'inactive'}
          />
          <ProviderRow
            number={3}
            name="AWS Secrets Manager"
            description="Fallback for ghosthands/{environment}"
            status="fallback"
          />
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/80 p-4">
      <span className="text-gray-500 text-xs uppercase tracking-wider">{label}</span>
      <div className={`mt-1.5 ${mono ? 'font-mono text-xs' : ''} text-gray-200`}>
        {typeof value === 'string' ? <p>{value}</p> : value}
      </div>
    </div>
  );
}

function ProviderRow({
  number,
  name,
  description,
  status,
}: {
  number: number;
  name: string;
  description: string;
  status: 'active' | 'inactive' | 'fallback';
}) {
  const borderColor = status === 'active' ? 'border-green-500/30' : 'border-gray-800';
  const dotColor = status === 'active' ? 'bg-green-400' : status === 'fallback' ? 'bg-yellow-400' : 'bg-gray-600';

  return (
    <div className={`rounded-lg border ${borderColor} bg-gray-900/50 p-4 flex items-center gap-4`}>
      <span className="text-lg font-bold text-gray-600 tabular-nums w-6 text-center">{number}</span>
      <div className={`h-2.5 w-2.5 rounded-full ${dotColor}`} />
      <div className="flex-1">
        <p className="text-sm font-medium text-gray-300">{name}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <span className="text-xs text-gray-500 uppercase tracking-wider">{status}</span>
    </div>
  );
}
