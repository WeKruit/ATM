import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import {
  deleteWithAuth,
  get,
  getWithAuth,
  post,
  putWithAuth,
  type SecretAdminVarsResponse,
  type SecretApp,
  type SecretAppMetadata,
  type SecretEnvironment,
  type SecretFanoutResponse,
  type SecretMutationResponse,
  type SecretsStatus,
} from '../api';
import StatusBadge from '../components/StatusBadge';

const INFISICAL_URL = 'https://infisical-wekruit.fly.dev';
const ENVIRONMENTS: SecretEnvironment[] = ['dev', 'staging', 'production'];
const APP_FALLBACKS: SecretApp[] = ['atm', 'valet', 'ghosthands'];

interface MutationState {
  title: string;
  response: SecretMutationResponse | SecretFanoutResponse;
}

function mutationResults(response: SecretMutationResponse | SecretFanoutResponse) {
  return 'results' in response ? response.results : response.fanout.results;
}

function mutationSuccess(response: SecretMutationResponse | SecretFanoutResponse) {
  return 'results' in response ? response.success : response.fanout.success;
}

export default function SecretsPage() {
  const base = '';

  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState(() => sessionStorage.getItem('atm-deploy-secret') || '');

  const [apps, setApps] = useState<SecretAppMetadata[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [selectedApp, setSelectedApp] = useState<SecretApp>('atm');
  const [selectedEnvironment, setSelectedEnvironment] = useState<SecretEnvironment>('staging');

  const [varsResponse, setVarsResponse] = useState<SecretAdminVarsResponse | null>(null);
  const [varsLoading, setVarsLoading] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fanoutBusy, setFanoutBusy] = useState(false);
  const [mutationState, setMutationState] = useState<MutationState | null>(null);

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

  const handleSecretChange = (value: string) => {
    setSecret(value);
    sessionStorage.setItem('atm-deploy-secret', value);
  };

  const loadApps = useCallback(async () => {
    if (!secret) return;
    setAppsLoading(true);
    try {
      const data = await getWithAuth<{ apps: SecretAppMetadata[] }>('/admin/secrets/apps', secret, base);
      setApps(data.apps);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load apps');
    } finally {
      setAppsLoading(false);
    }
  }, [secret, base]);

  const loadVars = useCallback(async () => {
    if (!secret) return;
    setVarsLoading(true);
    try {
      const params = new URLSearchParams({
        app: selectedApp,
        environment: selectedEnvironment,
      });
      const data = await getWithAuth<SecretAdminVarsResponse>(
        `/admin/secrets/vars?${params.toString()}`,
        secret,
        base,
      );
      setVarsResponse(data);
      setRevealedKeys({});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load secret vars');
    } finally {
      setVarsLoading(false);
    }
  }, [secret, selectedApp, selectedEnvironment, base]);

  useEffect(() => {
    if (!secret) return;
    loadApps();
  }, [secret, loadApps]);

  useEffect(() => {
    if (!secret) return;
    loadVars();
  }, [secret, selectedApp, selectedEnvironment, loadVars]);

  useEffect(() => {
    if (apps.length === 0) return;
    if (!apps.some((app) => app.app === selectedApp)) {
      setSelectedApp(apps[0]?.app || 'atm');
    }
  }, [apps, selectedApp]);

  const toggleReveal = (key: string) => {
    setRevealedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const resetDraft = () => {
    setDraftKey('');
    setDraftValue('');
    setEditingKey(null);
  };

  const startEdit = (key: string, value: string) => {
    setEditingKey(key);
    setDraftKey(key);
    setDraftValue(value);
  };

  const saveSecret = async () => {
    if (!secret || !draftKey.trim()) return;
    setSaving(true);
    try {
      const response = await putWithAuth<SecretMutationResponse>(
        '/admin/secrets/vars',
        {
          app: selectedApp,
          environment: selectedEnvironment,
          vars: [{ key: draftKey.trim(), value: draftValue }],
        },
        secret,
        base,
      );
      setMutationState({
        title: editingKey ? `Updated ${draftKey.trim()}` : `Added ${draftKey.trim()}`,
        response,
      });
      resetDraft();
      await loadVars();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save secret');
    } finally {
      setSaving(false);
    }
  };

  const deleteSecret = async (key: string) => {
    if (!secret) return;
    if (!confirm(`Delete ${key} from ${selectedApp}/${selectedEnvironment}?`)) return;
    setSaving(true);
    try {
      const response = await deleteWithAuth<SecretMutationResponse>(
        '/admin/secrets/vars',
        {
          app: selectedApp,
          environment: selectedEnvironment,
          keys: [key],
        },
        secret,
        base,
      );
      setMutationState({
        title: `Deleted ${key}`,
        response,
      });
      await loadVars();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete secret');
    } finally {
      setSaving(false);
    }
  };

  const fanoutSecrets = async () => {
    if (!secret) return;
    setFanoutBusy(true);
    try {
      const response = await post<SecretFanoutResponse>(
        '/admin/secrets/fanout',
        {
          app: selectedApp,
          environment: selectedEnvironment,
        },
        secret,
        base,
      );
      setMutationState({
        title: `Re-synced ${selectedApp}/${selectedEnvironment}`,
        response,
      });
      await loadVars();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fan out secrets');
    } finally {
      setFanoutBusy(false);
    }
  };

  const selectedMetadata =
    apps.find((app) => app.app === selectedApp) ||
    apps[0] ||
    ({
      app: selectedApp,
      description: '',
      path: `/${selectedApp}`,
      environments: ENVIRONMENTS,
      defaultTargets: [],
      supportedTargets: [],
    } satisfies SecretAppMetadata);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <svg className="mr-3 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Checking secrets status...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Secrets Control Plane</h1>
          <p className="mt-1 text-sm text-gray-500">
            Add a key once for an app + environment. ATM writes Infisical first, then fans out downstream targets.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={INFISICAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium text-blue-400 transition-colors hover:bg-gray-700 hover:text-blue-300"
          >
            Open Infisical
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
          <button
            onClick={fetchStatus}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-400 transition-colors hover:bg-gray-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-300">Authentication</h2>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <input
            type="password"
            value={secret}
            onChange={(e) => handleSecretChange(e.target.value)}
            placeholder="Deploy secret (X-Deploy-Secret)"
            className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 placeholder:text-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={loadApps}
            disabled={!secret || appsLoading}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              !secret || appsLoading
                ? 'cursor-not-allowed bg-gray-800 text-gray-600'
                : 'bg-blue-600 text-white hover:bg-blue-500'
            }`}
          >
            {appsLoading ? 'Loading…' : 'Load Control Plane'}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-300">Canonical Secrets</h2>
              <p className="mt-1 text-xs text-gray-500">
                Source of truth lives in {selectedMetadata.path} for {selectedEnvironment}.
              </p>
            </div>
            <button
              onClick={fanoutSecrets}
              disabled={!secret || fanoutBusy}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                !secret || fanoutBusy
                  ? 'cursor-not-allowed bg-gray-800 text-gray-600'
                  : 'bg-emerald-600 text-white hover:bg-emerald-500'
              }`}
            >
              {fanoutBusy ? 'Syncing…' : 'Fan Out Now'}
            </button>
          </div>

          <div className="mb-4 grid gap-3 md:grid-cols-3">
            <select
              value={selectedApp}
              onChange={(e) => setSelectedApp(e.target.value as SecretApp)}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              {(apps.length > 0 ? apps : APP_FALLBACKS.map((app) => ({ app } as SecretAppMetadata))).map((app) => (
                <option key={app.app} value={app.app}>
                  {app.app}
                </option>
              ))}
            </select>
            <select
              value={selectedEnvironment}
              onChange={(e) => setSelectedEnvironment(e.target.value as SecretEnvironment)}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              {ENVIRONMENTS.map((environment) => (
                <option key={environment} value={environment}>
                  {environment}
                </option>
              ))}
            </select>
            <button
              onClick={loadVars}
              disabled={!secret || varsLoading}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                !secret || varsLoading
                  ? 'cursor-not-allowed bg-gray-800 text-gray-600'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {varsLoading ? 'Loading…' : 'Reload Vars'}
            </button>
          </div>

          <div className="mb-4 rounded-lg border border-gray-800 bg-gray-950/80 p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <InfoItem label="Infisical Path" value={selectedMetadata.path} mono />
              <InfoItem label="App" value={selectedMetadata.app} />
              <InfoItem label="Downstream Targets" value={String(selectedMetadata.defaultTargets.length)} />
            </div>
            <p className="mt-3 text-xs text-gray-500">{selectedMetadata.description}</p>
            {selectedMetadata.defaultTargets.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedMetadata.defaultTargets.map((target) => (
                  <span
                    key={target}
                    className="rounded-full border border-gray-700 bg-gray-900 px-2.5 py-1 font-mono text-[11px] text-gray-400"
                  >
                    {target}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="mb-4 rounded-lg border border-gray-800 bg-gray-950/80 p-4">
            <h3 className="mb-3 text-sm font-semibold text-gray-300">
              {editingKey ? `Edit ${editingKey}` : 'Add or Update a Key'}
            </h3>
            <div className="grid gap-3 md:grid-cols-[1fr_2fr_auto]">
              <input
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value.toUpperCase())}
                placeholder="KEY_NAME"
                className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 placeholder:text-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <textarea
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                placeholder="Secret value"
                rows={2}
                className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 placeholder:text-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <div className="flex items-start gap-2">
                <button
                  onClick={saveSecret}
                  disabled={!secret || !draftKey.trim() || saving}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    !secret || !draftKey.trim() || saving
                      ? 'cursor-not-allowed bg-gray-800 text-gray-600'
                      : 'bg-blue-600 text-white hover:bg-blue-500'
                  }`}
                >
                  {saving ? 'Saving…' : editingKey ? 'Update' : 'Save'}
                </button>
                {(editingKey || draftKey || draftValue) && (
                  <button
                    onClick={resetDraft}
                    className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>

          {varsLoading ? (
            <div className="rounded-lg border border-gray-800 bg-gray-950/80 p-6 text-sm text-gray-500">
              Loading canonical values…
            </div>
          ) : varsResponse ? (
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <div className="flex items-center justify-between border-b border-gray-800 bg-gray-900/80 px-4 py-3">
                <h3 className="text-sm font-semibold text-gray-300">
                  {varsResponse.totalKeys} key{varsResponse.totalKeys === 1 ? '' : 's'} in {varsResponse.path}
                </h3>
                <span className="text-xs text-gray-500">
                  Infisical env: {varsResponse.infisicalEnvironment}
                </span>
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
                    {varsResponse.vars.map((entry) => (
                      <tr key={entry.key} className="hover:bg-gray-800/30">
                        <td className="px-4 py-3 font-mono text-xs text-gray-200">{entry.key}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-400 max-w-[420px]">
                          {revealedKeys[entry.key] ? (
                            <span className="break-all text-green-400">{entry.value}</span>
                          ) : (
                            <span className="text-gray-600">********</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => toggleReveal(entry.key)}
                              className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-700"
                            >
                              {revealedKeys[entry.key] ? 'Hide' : 'Reveal'}
                            </button>
                            <button
                              onClick={() => copyToClipboard(entry.key, entry.value)}
                              className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                                copied === entry.key
                                  ? 'border-green-500/30 bg-green-500/20 text-green-400'
                                  : 'border-gray-700 bg-gray-800 text-gray-400 hover:bg-gray-700'
                              }`}
                            >
                              {copied === entry.key ? 'Copied!' : 'Copy'}
                            </button>
                            {!entry.isRuntime && (
                              <>
                                <button
                                  onClick={() => startEdit(entry.key, entry.value)}
                                  className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-700"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => deleteSecret(entry.key)}
                                  className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-800 bg-gray-950/80 p-6 text-sm text-gray-500">
              Authenticate with the deploy secret to load canonical values.
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h2 className="text-sm font-semibold text-gray-300">Infisical Connection</h2>
              <StatusBadge status={status?.connected ? 'connected' : 'disconnected'} size="md" />
            </div>
            <div className="space-y-4 p-6">
              <InfoItem label="Project ID" value={status?.projectId || '-'} mono />
              <InfoItem label="Environment" value={status?.environment || '-'} />
              <InfoItem
                label="Total Secrets"
                value={
                  <span className="text-2xl font-bold tabular-nums text-green-400">
                    {status?.secretCount ?? 0}
                  </span>
                }
              />
              {status?.paths && (
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(status.paths).map(([path, count]) => (
                    <div key={path} className="rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2">
                      <span className="text-xs font-mono text-gray-500">{path}</span>
                      <p className="mt-0.5 text-lg font-bold tabular-nums text-gray-200">{count}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {mutationState && (
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
              <h2 className="text-sm font-semibold text-gray-300">{mutationState.title}</h2>
              <p className="mt-1 text-xs text-gray-500">
                {mutationSuccess(mutationState.response) === false
                  ? 'Canonical write succeeded but one or more downstream targets failed.'
                  : 'Canonical write and downstream fanout completed.'}
              </p>
              <div className="mt-3 space-y-2">
                {mutationResults(mutationState.response).map((result) => (
                  <FanoutRow key={result.target} result={result} />
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4">
            <h2 className="text-sm font-semibold text-gray-300">Operator Rule</h2>
            <div className="mt-3 space-y-2 text-sm text-gray-400">
              <p>1. Choose the app and environment.</p>
              <p>2. Save or delete the key here once.</p>
              <p>3. ATM updates Infisical, then re-syncs the configured GitHub/AWS/runtime targets.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FanoutRow({
  result,
}: {
  result: {
    target: string;
    success: boolean;
    upserted: number;
    deleted: number;
    skipped: number;
    errors: string[];
  };
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/80 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-gray-300">{result.target}</span>
        <span className={`text-xs font-medium ${result.success ? 'text-green-400' : 'text-red-400'}`}>
          {result.success ? 'ok' : 'failed'}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        upserted {result.upserted}, deleted {result.deleted}, skipped {result.skipped}
      </p>
      {result.errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {result.errors.map((error) => (
            <p key={error} className="font-mono text-[11px] text-red-400/80">
              {error}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function InfoItem({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/80 p-4">
      <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
      <div className={`mt-1.5 text-gray-200 ${mono ? 'font-mono text-xs' : ''}`}>
        {typeof value === 'string' ? <p>{value}</p> : value}
      </div>
    </div>
  );
}
