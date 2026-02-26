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

import { getInfisicalConfig } from './infisical-client';

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
  extraEnv?: Record<string, string>,
): Promise<KamalResult> {
  const start = Date.now();
  const spawn = getSpawn();

  console.log(`[kamal-runner] Running: kamal ${args.join(' ')}`);

  const proc = spawn(['kamal', ...args], {
    env: {
      ...process.env,
      ...extraEnv,
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

// ── Secrets fetcher for Kamal deploys ────────────────────────────────

/** The secrets Kamal deploy.yml declares under env.secret */
const KAMAL_SECRET_KEYS = [
  'GH_ENVIRONMENT',
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'REDIS_URL',
  'GH_SERVICE_SECRET',
  'GH_DEPLOY_SECRET',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_REGION',
  'CORS_ORIGIN',
  'VALET_DEPLOY_WEBHOOK_SECRET',
  'SILICONFLOW_API_KEY',
  'GH_CREDENTIAL_KEY',
  'VNC_PW',
] as const;

/**
 * Fetches all secrets needed for a Kamal deploy:
 *  1. KAMAL_REGISTRY_PASSWORD — ECR token via SSH to GH EC2
 *  2. GH app secrets — from Infisical API (/ghosthands path)
 *
 * Maps destination to Infisical environment: staging→staging, production→prod
 */
export async function fetchSecretsForKamalDeploy(
  destination: string,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  // 1. Fetch ECR registry password via SSH to GH EC2
  console.log('[kamal-runner] Fetching ECR token via SSH...');
  try {
    const sshProc = Bun.spawn(
      ['ssh', '-i', '/root/.ssh/gh-deploy-key', '-o', 'StrictHostKeyChecking=no',
       '-o', 'ConnectTimeout=10', 'ubuntu@44.223.180.11',
       'aws ecr get-login-password --region us-east-1'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const ecrToken = await new Response(sshProc.stdout).text();
    const sshExit = await sshProc.exited;
    if (sshExit === 0 && ecrToken.trim()) {
      env.KAMAL_REGISTRY_PASSWORD = ecrToken.trim();
      console.log('[kamal-runner] ECR token fetched OK');
    } else {
      const sshErr = await new Response(sshProc.stderr).text();
      throw new Error(`SSH exit=${sshExit}: ${sshErr.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.error(`[kamal-runner] Failed to fetch ECR token: ${err.message}`);
    throw new Error(`ECR token fetch failed: ${err.message}`);
  }

  // 2. Fetch GH secrets from Infisical REST API
  const infisicalConfig = getInfisicalConfig();
  if (!infisicalConfig) {
    throw new Error('Infisical not configured — cannot fetch secrets for Kamal deploy');
  }

  const infisicalEnv = destination === 'production' ? 'prod' : 'staging';
  console.log(`[kamal-runner] Fetching secrets from Infisical (env=${infisicalEnv}, path=/ghosthands)...`);

  try {
    // Authenticate with Universal Auth
    const authRes = await fetch(`${infisicalConfig.siteUrl}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: infisicalConfig.clientId,
        clientSecret: infisicalConfig.clientSecret,
      }),
    });
    if (!authRes.ok) {
      throw new Error(`Auth failed: ${authRes.status} ${await authRes.text()}`);
    }
    const authData = (await authRes.json()) as { accessToken: string };
    const token = authData.accessToken;

    // Fetch all secrets from /ghosthands path in batch
    const secretsUrl = new URL(`${infisicalConfig.siteUrl}/api/v3/secrets/raw`);
    secretsUrl.searchParams.set('workspaceId', infisicalConfig.projectId);
    secretsUrl.searchParams.set('environment', infisicalEnv);
    secretsUrl.searchParams.set('secretPath', '/ghosthands');

    const secretsRes = await fetch(secretsUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!secretsRes.ok) {
      throw new Error(`Secrets fetch failed: ${secretsRes.status} ${await secretsRes.text()}`);
    }

    const secretsData = (await secretsRes.json()) as {
      secrets: Array<{ secretKey: string; secretValue: string }>;
    };

    // Build env map from fetched secrets
    const secretMap = new Map<string, string>();
    for (const s of secretsData.secrets || []) {
      secretMap.set(s.secretKey, s.secretValue);
    }

    // Map required keys
    let found = 0;
    for (const key of KAMAL_SECRET_KEYS) {
      const val = secretMap.get(key);
      if (val !== undefined) {
        env[key] = val;
        found++;
      } else {
        console.warn(`[kamal-runner] Secret "${key}" not found in Infisical /ghosthands`);
      }
    }

    // Override GH_ENVIRONMENT to match destination
    env.GH_ENVIRONMENT = destination === 'production' ? 'production' : 'staging';

    console.log(`[kamal-runner] Fetched ${found}/${KAMAL_SECRET_KEYS.length} secrets from Infisical`);
  } catch (err: any) {
    console.error(`[kamal-runner] Infisical secrets fetch failed: ${err.message}`);
    throw new Error(`Infisical secrets fetch failed: ${err.message}`);
  }

  return env;
}

// ── High-level commands ──────────────────────────────────────────────

/**
 * Writes secrets as plain KEY=VALUE to .kamal/secrets files so Kamal's
 * dotenv parser can read them. Also passes them as env vars (belt + suspenders).
 */
async function writeSecretsFiles(
  secrets: Record<string, string>,
  destination: string,
): Promise<void> {
  const { KAMAL_REGISTRY_PASSWORD, ...appSecrets } = secrets;

  // .kamal/secrets-common — just the ECR password
  const commonLines = KAMAL_REGISTRY_PASSWORD
    ? `KAMAL_REGISTRY_PASSWORD=${KAMAL_REGISTRY_PASSWORD}\n`
    : '';

  // .kamal/secrets.<destination> — all app secrets
  const destLines = Object.entries(appSecrets)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

  await Bun.write('.kamal/secrets-common', commonLines);
  await Bun.write(`.kamal/secrets.${destination}`, destLines);

  console.log(`[kamal-runner] Wrote secrets files (.kamal/secrets-common + .kamal/secrets.${destination})`);
}

/**
 * Runs a Kamal deploy for the given destination.
 * Fetches secrets from Infisical + ECR, writes them to .kamal/secrets files,
 * and injects them as env vars before spawning Kamal.
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
  // Fetch all secrets and write to files + inject as env vars
  const secretEnv = await fetchSecretsForKamalDeploy(destination);
  await writeSecretsFiles(secretEnv, destination);

  // Stop existing containers first (proxy: false + port publishing means
  // two containers can't bind the same port simultaneously)
  console.log(`[kamal-runner] Stopping existing containers before deploy...`);
  await spawnKamal(['app', 'stop', '-d', destination], onLine, secretEnv).catch(() => {
    console.log('[kamal-runner] No existing containers to stop (or stop failed) — continuing');
  });

  const args = [
    'deploy',
    '-d', destination,
    ...(version ? ['--version', version] : []),
    '-P',
  ];
  return spawnKamal(args, onLine, secretEnv);
}

/**
 * Runs a Kamal rollback to a specific version.
 * Fetches secrets from Infisical + ECR, writes them to .kamal/secrets files,
 * and injects them as env vars before spawning Kamal.
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
  // Fetch all secrets and write to files + inject as env vars
  const secretEnv = await fetchSecretsForKamalDeploy(destination);
  await writeSecretsFiles(secretEnv, destination);

  const args = ['rollback', version, '-d', destination];
  return spawnKamal(args, onLine, secretEnv);
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
