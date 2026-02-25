/**
 * Kamal Runner — Spawns kamal deploy/rollback CLI with output streaming
 *
 * Wraps the Kamal CLI for zero-downtime deployments and rollbacks.
 * Used as an alternative to direct Docker API deploys.
 *
 * Uses a setSpawnImpl pattern (mirroring docker-client.ts setFetchImpl)
 * for dependency injection in tests.
 *
 * @module atm-api/src/kamal-runner
 */

// ── Types ────────────────────────────────────────────────────────────

export interface KamalResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface KamalAuditEntry {
  timestamp: string;
  action: string;
  performer: string;
  details: string;
}

export interface KamalLockStatus {
  locked: boolean;
  holder?: string;
  reason?: string;
}

// ── Spawn injection (mirrors docker-client.ts setFetchImpl) ──────────

/**
 * Spawn function signature matching the subset of Bun.spawn we use.
 */
export type SpawnFn = (
  cmd: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdout?: 'pipe';
    stderr?: 'pipe';
  },
) => {
  exitCode: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

let spawnImpl: SpawnFn | null = null;

/**
 * Sets a custom spawn implementation (primarily for testing).
 * Pass null to reset to the default Bun.spawn.
 *
 * @param fn - Custom spawn function, or null to reset
 */
export function setSpawnImpl(fn: SpawnFn | null): void {
  spawnImpl = fn;
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    console.log('[kamal-runner] setSpawnImpl called, custom spawn:', fn ? typeof fn : 'reset');
  }
}

/**
 * Returns the active spawn function — custom if set, otherwise Bun.spawn.
 */
function getSpawn(): SpawnFn {
  if (spawnImpl) return spawnImpl;

  // Default: use Bun.spawn
  return (cmd, opts) => {
    const proc = Bun.spawn(cmd, {
      env: opts.env as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exited,
      stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: proc.stderr as unknown as ReadableStream<Uint8Array>,
    };
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Reads a ReadableStream line-by-line, calling onLine for each line
 * and collecting the full text.
 */
async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      chunks.push(text);

      if (onLine) {
        buffer += text;
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.length > 0) {
            onLine(line);
          }
        }
      }
    }

    // Flush remaining buffer
    if (onLine && buffer.length > 0) {
      onLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join('');
}

// ── Core ─────────────────────────────────────────────────────────────

/**
 * Spawns the kamal CLI with the given arguments.
 *
 * Sets TERM=dumb in the environment to strip ANSI escape codes from output.
 * Streams stdout/stderr line-by-line to the optional onLine callback.
 *
 * @param args - Arguments to pass to kamal (e.g., ['deploy', '-d', 'staging'])
 * @param onLine - Optional callback invoked for each line of output
 * @returns Result with exitCode, stdout, stderr, and durationMs
 */
export async function spawnKamal(
  args: string[],
  onLine?: (line: string) => void,
): Promise<KamalResult> {
  const start = Date.now();
  const spawn = getSpawn();

  console.log(`[kamal-runner] Running: kamal ${args.join(' ')}`);

  const proc = spawn(['kamal', ...args], {
    env: {
      ...process.env,
      TERM: 'dumb',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Consume both streams concurrently
  const [stdout, stderr] = await Promise.all([
    consumeStream(proc.stdout, onLine),
    consumeStream(proc.stderr, onLine),
  ]);

  const exitCode = await proc.exitCode;
  const durationMs = Date.now() - start;

  console.log(`[kamal-runner] Completed: kamal ${args[0]} (exit=${exitCode}, ${durationMs}ms)`);

  return { exitCode, stdout, stderr, durationMs };
}

// ── High-level commands ──────────────────────────────────────────────

/**
 * Runs a Kamal deploy for the given destination.
 *
 * @param destination - Deploy destination (e.g., 'staging', 'production')
 * @param version - Optional image version/tag to deploy
 * @param onLine - Optional callback for streaming output
 */
export async function kamalDeploy(
  destination: string,
  version?: string,
  onLine?: (line: string) => void,
): Promise<KamalResult> {
  const args = [
    'deploy',
    '-d', destination,
    ...(version ? ['--version', version] : []),
    '-P',
  ];
  return spawnKamal(args, onLine);
}

/**
 * Runs a Kamal rollback to a specific version.
 *
 * @param destination - Deploy destination
 * @param version - Version to roll back to
 * @param onLine - Optional callback for streaming output
 */
export async function kamalRollback(
  destination: string,
  version: string,
  onLine?: (line: string) => void,
): Promise<KamalResult> {
  const args = ['rollback', version, '-d', destination];
  return spawnKamal(args, onLine);
}

/**
 * Checks the Kamal deploy lock status for a destination.
 *
 * Parses stdout for lock information:
 * - "Locked by: <holder>" indicates a lock
 * - "No lock" or empty output indicates no lock
 *
 * @param destination - Deploy destination
 */
export async function kamalLockStatus(destination: string): Promise<KamalLockStatus> {
  try {
    const result = await spawnKamal(['lock', 'status', '-d', destination]);

    if (result.exitCode !== 0) {
      return { locked: false };
    }

    const output = result.stdout.trim();

    // Check for locked patterns
    const lockedByMatch = output.match(/Locked by:\s*(.+)/i);
    if (lockedByMatch) {
      const holder = lockedByMatch[1].trim();
      const reasonMatch = output.match(/Reason:\s*(.+)/i);
      const reason = reasonMatch ? reasonMatch[1].trim() : undefined;
      return { locked: true, holder, reason };
    }

    // "No lock" or empty = not locked
    if (output === '' || /no lock/i.test(output)) {
      return { locked: false };
    }

    // Unknown output — assume not locked
    return { locked: false };
  } catch {
    return { locked: false };
  }
}

/**
 * Retrieves the Kamal audit log for a destination.
 *
 * Parses each line of output into structured audit entries.
 * Expected format: "TIMESTAMP ACTION by PERFORMER — DETAILS"
 * Falls back to raw line if parsing fails.
 *
 * @param destination - Deploy destination
 */
export async function kamalAudit(destination: string): Promise<KamalAuditEntry[]> {
  const result = await spawnKamal(['audit', '-d', destination]);

  if (result.exitCode !== 0) {
    return [];
  }

  const lines = result.stdout.trim().split('\n').filter((l) => l.trim().length > 0);
  const entries: KamalAuditEntry[] = [];

  for (const line of lines) {
    // Try to parse structured format: "TIMESTAMP ACTION by PERFORMER — DETAILS"
    // Also handle "TIMESTAMP ACTION by PERFORMER - DETAILS" (plain dash)
    const match = line.match(
      /^(\S+\s+\S+|\S+)\s+(\S+)\s+by\s+(\S+)\s*[-—]\s*(.+)$/i,
    );

    if (match) {
      entries.push({
        timestamp: match[1].trim(),
        action: match[2].trim(),
        performer: match[3].trim(),
        details: match[4].trim(),
      });
    } else {
      // Fallback: treat entire line as details
      entries.push({
        timestamp: '',
        action: '',
        performer: '',
        details: line.trim(),
      });
    }
  }

  return entries;
}

/**
 * Checks whether the kamal CLI is available on the system.
 *
 * @returns true if kamal is installed and responds to `kamal version`
 */
export async function isKamalAvailable(): Promise<boolean> {
  try {
    const result = await spawnKamal(['version']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
