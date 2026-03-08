import { useCallback, useEffect, useMemo, useState } from 'react';
import { getWithAuth, post } from '../api';
import type {
  DesktopReleaseSummary,
  DesktopReleasesResponse,
  DesktopRolloutSummary,
} from '../api';

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function rolloutTone(status: DesktopRolloutSummary['status']): string {
  if (status === 'active') return 'text-green-400 border-green-500/20 bg-green-500/10';
  if (status === 'paused') return 'text-amber-400 border-amber-500/20 bg-amber-500/10';
  return 'text-gray-400 border-gray-700 bg-gray-900/50';
}

export default function DesktopReleasesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [releases, setReleases] = useState<DesktopReleaseSummary[]>([]);
  const [rollouts, setRollouts] = useState<DesktopRolloutSummary[]>([]);
  const [minimumSupported, setMinimumSupported] = useState<Record<'stable' | 'beta', string>>({
    stable: '',
    beta: '',
  });

  const secret = sessionStorage.getItem('atm-deploy-secret') || '';

  const fetchState = useCallback(async () => {
    if (!secret) {
      setError('Authenticate first — click the lock icon in the header');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const data = await getWithAuth<DesktopReleasesResponse>('/desktop/releases', secret);
      setReleases(data.releases);
      setRollouts(data.rollouts);
      setMinimumSupported({
        stable: data.rollouts.find((rollout) => rollout.channel === 'stable')?.minimumSupportedVersion ?? '',
        beta: data.rollouts.find((rollout) => rollout.channel === 'beta')?.minimumSupportedVersion ?? '',
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load desktop release state');
    } finally {
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => {
    void fetchState();
    const interval = setInterval(() => {
      void fetchState();
    }, 15000);
    return () => clearInterval(interval);
  }, [fetchState]);

  const releasesByChannel = useMemo(() => ({
    stable: releases.filter((release) => release.channel === 'stable'),
    beta: releases.filter((release) => release.channel === 'beta'),
  }), [releases]);

  const runAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    if (!secret) {
      setError('Authenticate first — click the lock icon in the header');
      return;
    }
    try {
      setSubmitting(label);
      setError(null);
      await action();
      await fetchState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSubmitting(null);
    }
  }, [fetchState, secret]);

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-8 text-center text-gray-500">
        Loading desktop release state...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Desktop Releases</h1>
          <p className="mt-1 text-xs text-gray-500">
            ATM owns release feeds, staged rollout percentages, pauses, rollbacks, and minimum supported versions.
          </p>
        </div>
        <button
          onClick={() => void fetchState()}
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700 transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {rollouts.map((rollout) => (
          <section key={rollout.channel} className="rounded-lg border border-gray-800 bg-gray-900/70 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-gray-100 capitalize">{rollout.channel}</h2>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${rolloutTone(rollout.status)}`}>
                    {rollout.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Updated {timeAgo(rollout.updatedAt)} · baseline {rollout.baselineVersion ?? 'none'}
                  {rollout.candidateVersion ? ` · candidate ${rollout.candidateVersion}` : ''}
                </p>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wider text-gray-500">Rollout</div>
                <div className="text-2xl font-semibold text-gray-100">{rollout.rolloutPercent}%</div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-gray-800 bg-gray-950/70 p-3">
                <div className="text-xs uppercase tracking-wider text-gray-500">Minimum supported</div>
                <div className="mt-1 text-sm text-gray-200">{rollout.minimumSupportedVersion ?? 'Not set'}</div>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-950/70 p-3">
                <div className="text-xs uppercase tracking-wider text-gray-500">Eligible release</div>
                <div className="mt-1 text-sm text-gray-200">
                  {rollout.candidateVersion && rollout.rolloutPercent > 0
                    ? `${rollout.candidateVersion} for ${rollout.rolloutPercent}%`
                    : rollout.baselineVersion ?? 'None'}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {rollout.channel === 'stable' && rollout.candidateReleaseId && (
                <>
                  <ActionButton
                    busy={submitting === `stable-5`}
                    label="5%"
                    onClick={() => runAction('stable-5', () => post(`/desktop/releases/${rollout.candidateReleaseId}/rollout`, { rolloutPercent: 5 }, secret))}
                  />
                  <ActionButton
                    busy={submitting === `stable-25`}
                    label="25%"
                    onClick={() => runAction('stable-25', () => post(`/desktop/releases/${rollout.candidateReleaseId}/rollout`, { rolloutPercent: 25 }, secret))}
                  />
                  <ActionButton
                    busy={submitting === `stable-100`}
                    label="100%"
                    onClick={() => runAction('stable-100', () => post(`/desktop/releases/${rollout.candidateReleaseId}/rollout`, { rolloutPercent: 100 }, secret))}
                  />
                  <ActionButton
                    busy={submitting === `stable-pause`}
                    label="Pause"
                    variant="warn"
                    onClick={() => runAction('stable-pause', () => post(`/desktop/releases/${rollout.candidateReleaseId}/pause`, {}, secret))}
                  />
                  <ActionButton
                    busy={submitting === `stable-rollback`}
                    label="Rollback"
                    variant="danger"
                    onClick={() => runAction('stable-rollback', () => post(`/desktop/releases/${rollout.candidateReleaseId}/rollback`, {}, secret))}
                  />
                </>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                value={minimumSupported[rollout.channel]}
                onChange={(event) => {
                  const next = event.target.value;
                  setMinimumSupported((current) => ({ ...current, [rollout.channel]: next }));
                }}
                placeholder="Minimum supported version"
                className="w-52 rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-blue-500 focus:outline-none"
              />
              <ActionButton
                busy={submitting === `${rollout.channel}-min-supported`}
                label="Save minimum"
                onClick={() =>
                  runAction(
                    `${rollout.channel}-min-supported`,
                    () =>
                      post(
                        `/desktop/rollouts/${rollout.channel}/minimum-supported`,
                        { minimumSupportedVersion: minimumSupported[rollout.channel] || null },
                        secret,
                      ),
                  )
                }
              />
            </div>
          </section>
        ))}
      </div>

      {(['stable', 'beta'] as const).map((channel) => (
        <section key={channel} className="rounded-lg border border-gray-800 overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-800 bg-gray-900/80 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-300">{channel} releases</h2>
              <p className="mt-1 text-xs text-gray-500">
                Click activate to make a release the baseline or the staged candidate for this channel.
              </p>
            </div>
          </div>

          {releasesByChannel[channel].length === 0 ? (
            <div className="bg-gray-950/60 px-4 py-8 text-center text-sm text-gray-500">
              No {channel} releases have been ingested yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-950/80">
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Version</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Published</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Commit</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Artifacts</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/60 bg-gray-950/30">
                  {releasesByChannel[channel].map((release) => (
                    <tr key={release.id}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <a
                            href={release.releaseUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-gray-100 hover:text-blue-400"
                          >
                            v{release.version}
                          </a>
                          {release.blocked && (
                            <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-xs text-red-300">
                              blocked
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-gray-500">{release.repository}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {new Date(release.publishedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-xs text-gray-300">
                          {release.commitSha?.slice(0, 12) ?? 'unknown'}
                        </div>
                        {release.commitMessage && (
                          <div className="mt-1 max-w-md truncate text-xs text-gray-500" title={release.commitMessage}>
                            {release.commitMessage}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {Object.keys(release.assets).length} assets
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ActionButton
                          busy={submitting === `${release.id}-activate`}
                          label="Activate"
                          onClick={() => runAction(`${release.id}-activate`, () => post(`/desktop/releases/${release.id}/activate`, {}, secret))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function ActionButton({
  busy,
  label,
  onClick,
  variant = 'default',
}: {
  busy: boolean;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'warn' | 'danger';
}) {
  const tone =
    variant === 'danger'
      ? 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20'
      : variant === 'warn'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
        : 'border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20';

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${tone}`}
    >
      {busy ? 'Working...' : label}
    </button>
  );
}
