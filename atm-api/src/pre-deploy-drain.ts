/**
 * Pre-deploy drain orchestration.
 *
 * Checks all fleet workers for active jobs, sends drain requests to busy
 * workers, and polls until they become idle (or timeout).
 *
 * Used by the POST /deploy/kamal handler to avoid killing running jobs.
 */

// ── Dependency injection for fetch (enables unit testing) ────────────

type FetchFn = typeof globalThis.fetch;

let _fetchImpl: FetchFn | null = null;

/** Override the fetch function used by this module (for testing). Pass null to reset. */
export function setFetchImpl(impl: FetchFn | null): void {
  _fetchImpl = impl;
}

function getFetch(): FetchFn {
  return _fetchImpl ?? globalThis.fetch;
}

// ── Helper ───────────────────────────────────────────────────────────

/**
 * Fetch JSON from a URL. Returns the parsed object on success, or null on
 * any network/parse error. Uses the injectable fetch implementation.
 */
async function fetchJson(
  url: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await getFetch()(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Main function ────────────────────────────────────────────────────

export interface FleetEntry {
  id: string;
  ip: string;
  role: string;
}

export interface PreDeployDrainOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  onLine?: (line: string) => void;
}

/**
 * Pre-deploy drain orchestration.
 * Checks all fleet workers for active jobs, drains if busy, waits for idle.
 * Returns null on success (all workers idle), or an error message on timeout.
 */
export async function preDeployDrain(
  servers: FleetEntry[],
  workerPort: number,
  workerHost: string,
  opts: PreDeployDrainOptions = {},
): Promise<string | null> {
  const {
    timeoutMs = 300_000,
    pollIntervalMs = 5_000,
    onLine,
  } = opts;

  const f = getFetch();

  // Collect worker IPs to check
  const workerIps: string[] = [];

  for (const server of servers) {
    if (server.role === 'ghosthands' || server.role === 'gh') {
      workerIps.push(server.ip);
    }
  }

  // Fallback: if no fleet servers with GH role, use the configured worker host
  if (workerIps.length === 0 && workerHost !== 'localhost' && workerHost !== '127.0.0.1') {
    workerIps.push(workerHost);
  }
  if (workerIps.length === 0) {
    workerIps.push(workerHost); // localhost fallback
  }

  // Check which workers are busy
  const busyWorkers: string[] = [];
  for (const ip of workerIps) {
    const health = await fetchJson(`http://${ip}:${workerPort}/worker/health`);
    if (health === null) {
      onLine?.(`[pre-deploy] Worker ${ip} unreachable — assuming idle`);
      continue;
    }
    const activeJobs = (health.active_jobs as number) ?? 0;
    if (activeJobs > 0) {
      busyWorkers.push(ip);
      onLine?.(`[pre-deploy] Worker ${ip} has ${activeJobs} active job(s) — draining`);
    } else {
      onLine?.(`[pre-deploy] Worker ${ip} is idle`);
    }
  }

  if (busyWorkers.length === 0) {
    onLine?.('[pre-deploy] All workers idle — proceeding with deploy');
    return null;
  }

  // Drain busy workers
  for (const ip of busyWorkers) {
    try {
      await f(`http://${ip}:${workerPort}/worker/drain`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
      onLine?.(`[pre-deploy] Drain requested on ${ip}`);
    } catch {
      onLine?.(`[pre-deploy] Drain request failed on ${ip} — continuing`);
    }
  }

  // Poll until all busy workers are idle
  const deadline = Date.now() + timeoutMs;
  const drained = new Set<string>();

  while (Date.now() < deadline && drained.size < busyWorkers.length) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    for (const ip of busyWorkers) {
      if (drained.has(ip)) continue;

      const status = await fetchJson(`http://${ip}:${workerPort}/worker/status`);
      if (status === null) {
        // If we can't reach it, assume drained
        drained.add(ip);
        onLine?.(`[pre-deploy] Worker ${ip} unreachable — treating as drained`);
        continue;
      }
      const activeJobs = (status.active_jobs as number) ?? 0;
      if (activeJobs === 0) {
        drained.add(ip);
        onLine?.(`[pre-deploy] Worker ${ip} drained (active_jobs=0)`);
      } else {
        onLine?.(`[pre-deploy] Worker ${ip} still busy (active_jobs=${activeJobs})`);
      }
    }
  }

  if (drained.size < busyWorkers.length) {
    const stillBusy = busyWorkers.filter(ip => !drained.has(ip));
    return `Workers still busy after ${timeoutMs / 1000}s: ${stillBusy.join(', ')}. Use ?force=true to override.`;
  }

  onLine?.('[pre-deploy] All workers drained — proceeding with deploy');
  return null;
}
