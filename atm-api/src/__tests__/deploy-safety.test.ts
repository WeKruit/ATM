import { describe, it, expect, afterEach } from 'bun:test';

import { preDeployDrain, setFetchImpl, type FleetEntry } from '../pre-deploy-drain';

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a mock fetch that routes by URL substring to JSON response factories. */
function mockFetch(routes: Record<string, () => object | null>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const body = handler();
        if (body === null) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    // Default: network error (unreachable)
    throw new Error(`Mock fetch: no route for ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

const ghServer = (ip: string): FleetEntry => ({
  id: `gh-${ip}`,
  ip,
  role: 'ghosthands',
});

const atmServer = (ip: string): FleetEntry => ({
  id: `atm-${ip}`,
  ip,
  role: 'atm',
});

// ── Tests ────────────────────────────────────────────────────────────

describe('preDeployDrain', () => {
  afterEach(() => {
    setFetchImpl(null);
  });

  it('proceeds immediately when all workers are idle', async () => {
    setFetchImpl(
      mockFetch({
        '/worker/health': () => ({ active_jobs: 0, status: 'idle' }),
      }),
    );

    const lines: string[] = [];
    const result = await preDeployDrain(
      [ghServer('10.0.0.1'), ghServer('10.0.0.2')],
      3101,
      'localhost',
      { timeoutMs: 5_000, pollIntervalMs: 10, onLine: (line) => lines.push(line) },
    );

    expect(result).toBeNull();
    expect(lines).toContain('[pre-deploy] Worker 10.0.0.1 is idle');
    expect(lines).toContain('[pre-deploy] Worker 10.0.0.2 is idle');
    expect(lines).toContain('[pre-deploy] All workers idle — proceeding with deploy');
  });

  it('drains busy workers and waits for them to become idle', async () => {
    // Worker starts busy, then becomes idle on second status poll
    let statusCalls = 0;

    setFetchImpl(
      (async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();

        if (url.includes('/worker/health')) {
          return new Response(JSON.stringify({ active_jobs: 1 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('/worker/drain')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('/worker/status')) {
          statusCalls++;
          // First poll: still busy. Second poll: idle.
          const activeJobs = statusCalls <= 1 ? 1 : 0;
          return new Response(JSON.stringify({ active_jobs: activeJobs }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        throw new Error(`Mock fetch: no route for ${url}`);
      }) as unknown as typeof globalThis.fetch,
    );

    const lines: string[] = [];
    const result = await preDeployDrain(
      [ghServer('10.0.0.1')],
      3101,
      'localhost',
      { timeoutMs: 30_000, pollIntervalMs: 10, onLine: (line) => lines.push(line) },
    );

    expect(result).toBeNull();
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(lines.some(l => l.includes('draining'))).toBe(true);
    expect(lines.some(l => l.includes('Drain requested'))).toBe(true);
    expect(lines.some(l => l.includes('drained (active_jobs=0)'))).toBe(true);
  });

  it('returns error message when drain times out', async () => {
    // Worker is always busy — never becomes idle
    setFetchImpl(
      mockFetch({
        '/worker/health': () => ({ active_jobs: 2 }),
        '/worker/drain': () => ({ ok: true }),
        '/worker/status': () => ({ active_jobs: 2 }),
      }),
    );

    const lines: string[] = [];
    const result = await preDeployDrain(
      [ghServer('10.0.0.1')],
      3101,
      'localhost',
      { timeoutMs: 50, pollIntervalMs: 10, onLine: (line) => lines.push(line) },
    );

    expect(result).not.toBeNull();
    expect(result).toContain('Workers still busy');
    expect(result).toContain('10.0.0.1');
    expect(result).toContain('?force=true');
  });

  it('skips non-GH fleet servers', async () => {
    const fetchCalls: string[] = [];

    setFetchImpl(
      (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        fetchCalls.push(url);
        return new Response(JSON.stringify({ active_jobs: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    );

    const result = await preDeployDrain(
      [atmServer('10.0.0.1'), ghServer('10.0.0.2')],
      3101,
      'localhost',
      { timeoutMs: 5_000, pollIntervalMs: 10 },
    );

    expect(result).toBeNull();
    // Should only have fetched from the GH server, not the ATM server
    expect(fetchCalls.some(u => u.includes('10.0.0.1'))).toBe(false);
    expect(fetchCalls.some(u => u.includes('10.0.0.2'))).toBe(true);
  });

  it('falls back to workerHost when no GH fleet servers exist', async () => {
    const fetchCalls: string[] = [];

    setFetchImpl(
      (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        fetchCalls.push(url);
        return new Response(JSON.stringify({ active_jobs: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    );

    const result = await preDeployDrain(
      [atmServer('10.0.0.1')], // no GH servers
      3101,
      '44.223.180.11', // workerHost fallback
      { timeoutMs: 5_000, pollIntervalMs: 10 },
    );

    expect(result).toBeNull();
    expect(fetchCalls.some(u => u.includes('44.223.180.11'))).toBe(true);
  });

  it('treats unreachable workers as idle during health check', async () => {
    // fetchJson returns null for unreachable workers (fetch throws, caught internally)
    setFetchImpl(
      (async () => {
        throw new Error('Connection refused');
      }) as unknown as typeof globalThis.fetch,
    );

    const lines: string[] = [];
    const result = await preDeployDrain(
      [ghServer('10.0.0.1')],
      3101,
      'localhost',
      { timeoutMs: 5_000, pollIntervalMs: 10, onLine: (line) => lines.push(line) },
    );

    expect(result).toBeNull();
    expect(lines).toContain('[pre-deploy] Worker 10.0.0.1 unreachable — assuming idle');
    expect(lines).toContain('[pre-deploy] All workers idle — proceeding with deploy');
  });

  it('treats unreachable workers as drained during polling', async () => {
    setFetchImpl(
      (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();

        // Health check: worker is busy
        if (url.includes('/worker/health')) {
          return new Response(JSON.stringify({ active_jobs: 1 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Drain: succeeds
        if (url.includes('/worker/drain')) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Status poll: worker unreachable (fetchJson will return null)
        if (url.includes('/worker/status')) {
          throw new Error('Connection refused');
        }

        throw new Error(`Mock fetch: no route for ${url}`);
      }) as unknown as typeof globalThis.fetch,
    );

    const lines: string[] = [];
    const result = await preDeployDrain(
      [ghServer('10.0.0.1')],
      3101,
      'localhost',
      { timeoutMs: 30_000, pollIntervalMs: 10, onLine: (line) => lines.push(line) },
    );

    expect(result).toBeNull();
    expect(lines.some(l => l.includes('unreachable — treating as drained'))).toBe(true);
  });
});
