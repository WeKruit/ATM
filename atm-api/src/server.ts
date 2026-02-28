/**
 * ATM API Server (migrated from GhostHands deploy-server.ts)
 *
 * Lightweight HTTP server on port 8080 that VALET's DeployService calls
 * to trigger deploys and check health on each EC2 sandbox.
 *
 * Endpoints:
 *   GET  /health               — Returns worker health + active task count (no auth)
 *   GET  /metrics              — Returns system-level CPU/memory/disk stats (no auth)
 *   GET  /version              — Returns deploy server version + current image info
 *   GET  /containers           — Returns running Docker containers (no auth)
 *   GET  /workers              — Returns worker registry status (no auth)
 *   POST /deploy               — Rolling deploy via Docker Engine API (requires X-Deploy-Secret)
 *   POST /drain                — Triggers graceful worker drain (requires X-Deploy-Secret)
 *   POST /cleanup              — Runs disk cleanup (Docker prune + tmp + logs) (requires X-Deploy-Secret)
 *   POST /rollback             — Rollback to last successful deploy (requires X-Deploy-Secret)
 *   POST /admin/refresh-secrets — Re-fetch secrets from Infisical/AWS SM (requires X-Deploy-Secret)
 *   GET  /deploys              — List deploy history records (no auth)
 *   GET  /deploys/:id          — Get a single deploy record by ID (no auth)
 *   GET  /secrets/ghosthands   — Fetch all GH secrets for Mac deploy (requires X-Deploy-Secret)
 *   GET  /secrets/status       — Infisical connection status (no auth)
 *   GET  /deploy/stream        — SSE stream for real-time deploy logs (no auth)
 *   GET  /kamal/validate       — Pre-deploy validation checks (no auth)
 *   GET  /kamal/status         — Kamal availability + lock status (no auth)
 *   GET  /kamal/audit          — Kamal audit log (no auth)
 *   GET  /kamal/hosts          — Kamal hosts per role per destination (no auth)
 *   POST /deploy/kamal         — Trigger Kamal deploy (requires X-Deploy-Secret)
 *   POST /rollback/kamal       — Trigger Kamal rollback (requires X-Deploy-Secret)
 *   GET  /fleet                — Dynamic fleet server registry (no auth)
 *   POST /fleet/reload         — Reload fleet config from disk (requires X-Deploy-Secret)
 *   POST /fleet/:id/wake       — Wake a stopped EC2 worker (requires X-Deploy-Secret)
 *   POST /fleet/:id/stop       — Stop a running EC2 worker (requires X-Deploy-Secret)
 *   POST /fleet/wake           — Wake N stopped workers (requires X-Deploy-Secret)
 *   GET  /fleet/idle-status    — EC2 idle monitor status (no auth)
 *   GET  /fleet/:id/*          — Smart proxy to fleet servers (no auth)
 *   GET  /dashboard            — Serve dashboard SPA (no auth)
 *   GET  /dashboard/*          — Serve dashboard SPA assets (no auth)
 *
 * Auth:
 *   POST endpoints require X-Deploy-Secret header matching GH_DEPLOY_SECRET env var.
 *   GET endpoints are unauthenticated (monitoring/health checks).
 *
 * Secrets:
 *   On startup, tries Infisical first (self-hosted), falls back to AWS Secrets Manager
 *   (`ghosthands/{GH_ENVIRONMENT}`). Existing env vars (from docker-compose env_file)
 *   take precedence. Both are non-fatal — if unavailable, process.env is used as-is.
 *
 * Usage:
 *   GH_DEPLOY_SECRET=<secret> bun atm-api/src/server.ts
 *
 * Environment:
 *   GH_DEPLOY_SECRET     — Required. Shared secret for deploy auth.
 *   GH_DEPLOY_PORT       — Port to listen on (default: 8080)
 *   GH_API_PORT          — GH API health port (default: 3100)
 *   GH_WORKER_PORT       — GH worker status port (default: 3101)
 *   GH_ENVIRONMENT       — Deploy environment: staging | production (default: staging)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { execSync, exec } from 'node:child_process';

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import {
  pullImage,
  stopContainer,
  removeContainer,
  createContainer,
  startContainer,
  listContainers,
  pruneImages,
} from './docker-client';
import { getEcrAuth, getEcrImageRef } from './ecr-auth';
import { getServiceConfigs, type ServiceDefinition } from './container-configs';
import { getRecords, getRecord, createDeployRecord, updateRecord } from './deploy-history';
import { executeRollback } from './rollback';
import { loadSecretsFromInfisical, getInfisicalStatus, listSecretKeys, getSecretValue, fetchSecretsForPath } from './infisical-client';
import { kamalDeploy, kamalRollback, kamalLockStatus, kamalAudit, isKamalAvailable, spawnKamal } from './kamal-runner';
import { preDeployDrain } from './pre-deploy-drain';
import { deployStream } from './deploy-stream';
import * as idleMonitor from './ec2-idle-monitor';
import { startInstance, stopInstance, describeInstance } from './ec2-client';
import { enterStandby, exitStandby } from './asg-client';
import path from 'node:path';

// ── AWS Secrets Manager ──────────────────────────────────────────────

/**
 * Optionally fetches secrets from AWS Secrets Manager and merges them
 * into process.env. Existing env vars (from docker-compose env_file)
 * take precedence — SM values are only set if the key is not already present.
 *
 * Non-fatal: if SM is unavailable (no IAM role, no secret, etc.), the
 * deploy-server continues with whatever is already in process.env.
 */
async function loadSecretsFromAwsSm(): Promise<void> {
  const environment = process.env.GH_ENVIRONMENT || 'staging';
  const secretId = `ghosthands/${environment}`;
  const region = process.env.AWS_REGION || 'us-east-1';

  try {
    const client = new SecretsManagerClient({ region });
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

    if (response.SecretString) {
      const secrets = JSON.parse(response.SecretString);
      let loaded = 0;
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === 'string' && !process.env[key]) {
          // Only set if not already in process.env (env_file takes precedence)
          process.env[key] = value;
          loaded++;
        }
      }
      console.log(`[atm-api] Loaded ${loaded} secrets from AWS SM (${secretId})`);
    }
  } catch (err: any) {
    console.warn(`[atm-api] AWS Secrets Manager unavailable (${err.message}). Using process.env only.`);
    // Non-fatal — graceful fallback to compose env_file vars
  }
}

// Load secrets before anything else reads process.env
// Try Infisical first, fall back to AWS SM
try {
  await loadSecretsFromInfisical();
} catch {
  // Infisical failed — fall back to AWS SM
}
await loadSecretsFromAwsSm();

const DEPLOY_PORT = parseInt(process.env.GH_DEPLOY_PORT || '8080', 10);
const DEPLOY_SECRET = process.env.ATM_DEPLOY_SECRET || process.env.GH_DEPLOY_SECRET;
const API_HOST = process.env.GH_API_HOST || 'localhost';
const API_PORT = parseInt(process.env.GH_API_PORT || '3100', 10);
const WORKER_HOST = process.env.GH_WORKER_HOST || 'localhost';
const WORKER_PORT = parseInt(process.env.GH_WORKER_PORT || '3101', 10);

/** Deployment environment, determined from env vars */
const currentEnvironment: 'staging' | 'production' =
  (process.env.GH_ENVIRONMENT as 'staging' | 'production') ||
  (process.env.NODE_ENV === 'production' ? 'production' : 'staging');

// ── EC2 Idle Monitor Config ──────────────────────────────────────────
const EC2_IDLE_ENABLED = process.env.EC2_IDLE_ENABLED === 'true';
const EC2_IDLE_TIMEOUT_MS = parseInt(process.env.EC2_IDLE_TIMEOUT_MS || '300000', 10);
const EC2_MIN_RUNNING = parseInt(process.env.EC2_MIN_RUNNING || '0', 10);
const EC2_POLL_INTERVAL_MS = parseInt(process.env.EC2_POLL_INTERVAL_MS || '60000', 10);

const startedAt = Date.now();
let currentDeploy: { imageTag: string; startedAt: number; step: string } | null = null;

// ── Fleet Config ────────────────────────────────────────────────────

interface FleetServer {
  id: string;
  name: string;
  host: string;
  environment: string;
  region: string;
  ip: string;
  type: string;
  role: string;
  ec2InstanceId?: string;
}

let fleetServers: FleetServer[] = [];

/**
 * Resolves a path relative to the project root, trying both Docker layout
 * (import.meta.dir = /app/src → one level up) and local layout
 * (import.meta.dir = .../atm-api/src → two levels up).
 */
function resolveProjectPath(relativePath: string): string | null {
  const candidates = [
    path.resolve(import.meta.dir, '..', relativePath),   // Docker: /app/src/../X = /app/X
    path.resolve(import.meta.dir, '../..', relativePath), // Local: .../atm-api/src/../../X = .../ATM/X
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Auto-discover GH fleet entries from Kamal deploy configs.
 * Returns FleetServer entries for each unique host IP found across all destinations.
 */
function discoverFleetFromKamal(): FleetServer[] {
  const configDir = resolveProjectPath('config');
  if (!configDir) return [];

  const discovered: FleetServer[] = [];
  const seenIps = new Set<string>();
  let workerIndex = 1;

  for (const dest of ['staging', 'production']) {
    const destFile = path.join(configDir, `deploy.${dest}.yml`);
    try {
      const content = fs.readFileSync(destFile, 'utf-8');
      const hosts = parseKamalHosts(content);
      // Collect all unique IPs from web + workers roles
      for (const role of Object.values(hosts)) {
        for (const ip of role) {
          if (seenIps.has(ip)) continue;
          seenIps.add(ip);
          discovered.push({
            id: `gh-worker-${workerIndex}`,
            name: `GH Worker ${workerIndex}`,
            host: `/fleet/gh-worker-${workerIndex}`,
            environment: dest,
            region: 'us-east-1',
            ip,
            type: 't3.large',
            role: 'ghosthands',
          });
          workerIndex++;
        }
      }
    } catch {
      // Config file missing or unreadable — skip this destination
    }
  }

  return discovered;
}

function loadFleetConfig(): FleetServer[] {
  // Try FLEET_CONFIG env var first (JSON string)
  if (process.env.FLEET_CONFIG) {
    try {
      const parsed = JSON.parse(process.env.FLEET_CONFIG);
      fleetServers = parsed.servers || parsed;
      console.log(`[atm-api] Loaded ${fleetServers.length} servers from FLEET_CONFIG env`);
      return fleetServers;
    } catch (e) {
      console.error('[atm-api] Failed to parse FLEET_CONFIG env:', e);
    }
  }

  // Load fleet.json for ATM self-entry and metadata overrides
  let jsonServers: FleetServer[] = [];
  const fleetPath = resolveProjectPath('atm-dashboard/public/fleet.json')
    || resolveProjectPath('config/fleet.json');
  if (fleetPath) {
    try {
      const raw = fs.readFileSync(fleetPath, 'utf-8');
      const parsed = JSON.parse(raw);
      jsonServers = parsed.servers || [];
    } catch (e) {
      console.log('[atm-api] Failed to parse fleet.json');
    }
  }

  // Auto-discover GH hosts from Kamal configs
  const kamalHosts = discoverFleetFromKamal();

  if (kamalHosts.length > 0) {
    // Keep non-ghosthands entries from fleet.json (ATM self-entry, etc.)
    const nonGhEntries = jsonServers.filter(s => s.role !== 'ghosthands');
    // Apply fleet.json overrides: if fleet.json has a GH entry matching an IP, merge its metadata
    const overridesByIp = new Map(
      jsonServers.filter(s => s.role === 'ghosthands').map(s => [s.ip, s])
    );
    const mergedGh = kamalHosts.map(discovered => {
      const override = overridesByIp.get(discovered.ip);
      return override ? { ...discovered, ...override } : discovered;
    });
    fleetServers = [...nonGhEntries, ...mergedGh];
    console.log(`[atm-api] Fleet: ${nonGhEntries.length} static + ${mergedGh.length} auto-discovered from Kamal`);
  } else if (jsonServers.length > 0) {
    // Kamal configs missing/empty — fall back to fleet.json entirely
    fleetServers = jsonServers;
    console.log(`[atm-api] Loaded ${fleetServers.length} servers from fleet.json (Kamal fallback)`);
  } else {
    console.log('[atm-api] No fleet config found');
    fleetServers = [];
  }

  return fleetServers;
}

// ── Deploy Result Types ─────────────────────────────────────────────

interface DeployResult {
  success: true;
  duration: number;
  imageTag: string;
  spaceReclaimed: number;
}

interface DeployFailure {
  success: false;
  error: string;
  failedStep?: string;
  failedService?: string;
}

if (!DEPLOY_SECRET) {
  console.error('[atm-api] FATAL: ATM_DEPLOY_SECRET (or GH_DEPLOY_SECRET) is required');
  process.exit(1);
}

function verifySecret(req: Request): boolean {
  const header = req.headers.get('x-deploy-secret');
  if (!header || !DEPLOY_SECRET) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(header),
      Buffer.from(DEPLOY_SECRET),
    );
  } catch {
    return false;
  }
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Deploy Helpers ────────────────────────────────────────────────

/**
 * Polls a service health endpoint until it returns 200 or the timeout expires.
 */
async function waitForHealthy(
  serviceName: string,
  healthUrl: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!healthUrl) return;
  const deadline = Date.now() + timeoutMs;
  console.log(`[deploy] Waiting for ${serviceName} to become healthy (${healthUrl}, timeout ${timeoutMs}ms)`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        console.log(`[deploy] ${serviceName} is healthy`);
        return;
      }
    } catch {
      // Still starting up — retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${serviceName} failed health check after ${timeoutMs}ms`);
}

/**
 * Sends a POST to a service's drain endpoint for graceful shutdown.
 * Non-fatal: logs but does not throw on failure.
 */
async function drainService(drainUrl: string, timeoutMs: number): Promise<void> {
  try {
    console.log(`[deploy] Draining via ${drainUrl} (timeout ${timeoutMs}ms)`);
    await fetch(drainUrl, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    console.log(`[deploy] Drain completed`);
  } catch (err) {
    console.log(`[deploy] Drain failed (non-fatal): ${err}`);
  }
}

/**
 * Executes a full rolling deploy via Docker Engine API.
 */
async function executeDeploy(imageTag: string): Promise<DeployResult | DeployFailure> {
  const startTime = Date.now();

  try {
    // 1. Authenticate with ECR
    if (currentDeploy) currentDeploy.step = 'ecr-auth';
    console.log('[deploy] Authenticating with ECR...');
    const ecrAuth = await getEcrAuth();
    console.log(`[deploy] ECR auth obtained (registry: ${ecrAuth.registryUrl})`);

    // 2. Pull new image
    if (currentDeploy) currentDeploy.step = 'pull-image';
    const fullImageRef = getEcrImageRef(imageTag);
    const [imageName, tag] = fullImageRef.split(':') as [string, string];
    console.log(`[deploy] Pulling image: ${fullImageRef}`);
    await pullImage(imageName, tag, ecrAuth.token);
    console.log(`[deploy] Image pulled successfully`);

    // 3. Get service configs
    if (currentDeploy) currentDeploy.step = 'load-configs';
    const services = getServiceConfigs(imageTag, currentEnvironment);
    console.log(`[deploy] Loaded ${services.length} service configs (env: ${currentEnvironment})`);

    // 4. Stop phase — find ALL matching containers (docker-compose or deploy-server created)
    if (currentDeploy) currentDeploy.step = 'stop-services';
    const allContainers = await listContainers(true);
    const stopOrder = [...services].sort((a, b) => a.stopOrder - b.stopOrder);
    for (const service of stopOrder) {
      if (service.skipOnSelfUpdate) {
        console.log(`[deploy] Skipping stop for ${service.name} (self-update protection)`);
        continue;
      }

      const matching = allContainers.filter((c) => {
        return c.Names.some((n: string) => {
          const clean = n.replace(/^\//, '');
          return clean === service.name || clean.startsWith(service.name + '-');
        });
      });

      if (matching.length === 0) {
        console.log(`[deploy] No existing container found for ${service.name}`);
        continue;
      }

      for (const container of matching) {
        const cName = container.Names[0]?.replace(/^\//, '') ?? 'unknown';
        const cId = container.Id;
        console.log(`[deploy] Stopping ${cName} (${cId.slice(0, 12)})`);

        const state = container.State;
        if (service.drainEndpoint && state === 'running') {
          await drainService(service.drainEndpoint, service.drainTimeout);
        }

        try {
          if (state === 'running') {
            await stopContainer(cId, 30);
          }
          await removeContainer(cId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[deploy] Failed to stop/remove ${cName}: ${msg}`);
          return {
            success: false,
            error: `Failed to stop service: ${msg}`,
            failedStep: 'stop-services',
            failedService: service.name,
          };
        }
      }
    }

    // 5. Start phase (respect startOrder — lower numbers start first)
    if (currentDeploy) currentDeploy.step = 'start-services';
    const startOrder = [...services].sort((a, b) => a.startOrder - b.startOrder);
    for (const service of startOrder) {
      if (service.skipOnSelfUpdate) {
        console.log(`[deploy] Skipping start for ${service.name} (self-update protection)`);
        continue;
      }

      console.log(`[deploy] Creating and starting ${service.name} (startOrder: ${service.startOrder})`);

      try {
        await createContainer(service.name, service.config);
        await startContainer(service.name);
        await waitForHealthy(service.name, service.healthEndpoint, service.healthTimeout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deploy] Failed to start ${service.name}: ${msg}`);
        return {
          success: false,
          error: `Failed to start service: ${msg}`,
          failedStep: 'start-services',
          failedService: service.name,
        };
      }
    }

    // 6. Prune old images
    if (currentDeploy) currentDeploy.step = 'prune-images';
    console.log('[deploy] Pruning old images...');
    let spaceReclaimed = 0;
    try {
      const pruneResult = await pruneImages();
      spaceReclaimed = pruneResult.spaceReclaimed;
      console.log(`[deploy] Pruned images, reclaimed ${spaceReclaimed} bytes`);
    } catch (err) {
      // Non-fatal: log but don't fail the deploy
      console.log(`[deploy] Image prune failed (non-fatal): ${err}`);
    }

    return {
      success: true,
      duration: Date.now() - startTime,
      imageTag,
      spaceReclaimed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const step = currentDeploy?.step ?? 'unknown';
    console.error(`[deploy] Deploy failed at step "${step}": ${msg}`);
    return {
      success: false,
      error: msg,
      failedStep: step,
    };
  }
}

// ── CORS Headers ──────────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Deploy-Secret',
};

/** Wraps a Response with CORS headers */
function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Parses a Kamal destination YAML file and extracts hosts per role.
 *
 * Expects the simple structure used by our deploy.{destination}.yml files:
 *   servers:
 *     web:
 *       hosts:
 *         - <ip>
 *     workers:
 *       hosts:
 *         - <ip>
 *
 * Returns { web: string[], workers: string[] }.
 */
function parseKamalHosts(yamlContent: string): Record<string, string[]> {
  const result: Record<string, string[]> = { web: [], workers: [] };
  const lines = yamlContent.split('\n');

  let currentRole: string | null = null;
  let inHosts = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Reset context if we hit a top-level key (no leading whitespace)
    if (trimmed.match(/^[a-z]/)) {
      currentRole = null;
      inHosts = false;
    }

    // Match role headers: "  web:" or "  workers:"
    const roleMatch = trimmed.match(/^\s{2,4}(web|workers):\s*$/);
    if (roleMatch) {
      currentRole = roleMatch[1];
      inHosts = false;
      continue;
    }

    // Match "hosts:" under a role
    if (currentRole && trimmed.match(/^\s{4,6}hosts:/)) {
      // Check if it's "hosts: []" (empty)
      if (trimmed.includes('[]')) {
        result[currentRole] = [];
        inHosts = false;
      } else {
        inHosts = true;
      }
      continue;
    }

    // Match host entries: "      - 44.223.180.11"
    if (inHosts && currentRole) {
      const hostMatch = trimmed.match(/^\s{6,8}-\s+(\S+)/);
      if (hostMatch) {
        // Strip any trailing comment
        const host = hostMatch[1].replace(/#.*$/, '').trim();
        if (host) result[currentRole].push(host);
      } else if (trimmed.trim() && !trimmed.match(/^\s*#/)) {
        // Non-empty, non-comment line that isn't a host = end of hosts list
        inHosts = false;
      }
    }
  }

  return result;
}

if (typeof Bun !== 'undefined') {
  Bun.serve({
    port: DEPLOY_PORT,
    idleTimeout: 255, // seconds; wake endpoint polls health for up to 120s
    async fetch(req) {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      const response = await handleRequest(req);
      return withCors(response);
    },
  });

  loadFleetConfig();

  // Start EC2 idle monitor if enabled
  if (EC2_IDLE_ENABLED) {
    const fleetEntries = fleetServers.map(s => ({
      id: s.id,
      ip: s.ip,
      role: s.role,
      ec2InstanceId: s.ec2InstanceId,
    }));
    idleMonitor.start(fleetEntries, {
      idleTimeoutMs: EC2_IDLE_TIMEOUT_MS,
      minRunning: EC2_MIN_RUNNING,
      pollIntervalMs: EC2_POLL_INTERVAL_MS,
      workerPort: WORKER_PORT,
    }).catch(err => console.error('[atm-api] Idle monitor start failed:', err));
    console.log(`[atm-api] EC2 idle monitor enabled (timeout=${EC2_IDLE_TIMEOUT_MS}ms, minRunning=${EC2_MIN_RUNNING})`);
  }

  console.log(`[atm-api] Listening on port ${DEPLOY_PORT}`);
  console.log(`[atm-api] GH API: ${API_HOST}:${API_PORT}, Worker: ${WORKER_HOST}:${WORKER_PORT}`);
  console.log(`[atm-api] Environment: ${currentEnvironment}, Deploy method: Docker API`);
} else {
  console.error('[atm-api] This server requires Bun runtime');
  process.exit(1);
}

async function handleRequest(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // ── GET /health — Unauthenticated health check ──────────
      if (url.pathname === '/health' && req.method === 'GET') {
        // Check if any GH worker is running (skip health probes to stopped/standby workers)
        const workerStates = idleMonitor.getWorkerStates();
        const anyRunning = workerStates.some(w => w.ec2State === 'running');

        let apiHealth: Record<string, unknown> | null = null;
        let workerHealth: Record<string, unknown> | null = null;
        let workerStatus: Record<string, unknown> | null = null;

        if (anyRunning) {
          // Find a running worker to probe
          const running = workerStates.find(w => w.ec2State === 'running');
          const probeIp = running?.ip ?? API_HOST;
          apiHealth = await fetchJson(`http://${probeIp}:${API_PORT}/health`);
          workerHealth = await fetchJson(`http://${probeIp}:${WORKER_PORT}/worker/health`);
          workerStatus = await fetchJson(`http://${probeIp}:${WORKER_PORT}/worker/status`);
        }

        const activeWorkers = (workerStatus?.active_jobs as number) ?? 0;
        const deploySafe = (workerHealth?.deploy_safe as boolean) ?? (activeWorkers === 0);

        return Response.json({
          status: anyRunning ? (apiHealth ? 'ok' : 'degraded') : 'idle',
          activeWorkers,
          deploySafe,
          apiHealthy: anyRunning ? !!apiHealth : false,
          workerStatus: anyRunning ? (workerHealth?.status ?? 'unknown') : 'all-stopped',
          currentDeploy: currentDeploy
            ? { imageTag: currentDeploy.imageTag, elapsedMs: Date.now() - currentDeploy.startedAt }
            : null,
          uptimeMs: Date.now() - startedAt,
        });
      }

      // ── GET /version — Unauthenticated version info ─────────
      if (url.pathname === '/version' && req.method === 'GET') {
        const apiVersion = await fetchJson(`http://${API_HOST}:${API_PORT}/health/version`);
        return Response.json({
          deployServer: 'atm-api',
          version: '1.0.0',
          ghosthands: apiVersion ?? { status: 'unreachable' },
          uptimeMs: Date.now() - startedAt,
        });
      }

      // ── GET /metrics — Unauthenticated system metrics ────────
      if (url.pathname === '/metrics' && req.method === 'GET') {
        const cpus = os.cpus();
        const cores = cpus.length;
        const loadAvg = os.loadavg()[0] ?? 0;
        const cpuPercent = Math.min(100, (loadAvg / cores) * 100);

        const totalMem = os.totalmem();
        let availableMem = os.freemem();
        try {
          const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
          const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
          if (match) {
            availableMem = parseInt(match[1], 10) * 1024;
          }
        } catch {
          // /proc/meminfo not available (macOS), use os.freemem() fallback
        }
        const usedMem = totalMem - availableMem;

        let diskUsedGb = 0;
        let diskTotalGb = 0;
        try {
          const dfOut = execSync("df -BG / | tail -1 | awk '{print $2, $3}'", {
            encoding: 'utf-8',
            timeout: 3000,
          }).trim();
          const [totalStr, usedStr] = dfOut.split(/\s+/);
          diskTotalGb = parseFloat(totalStr?.replace('G', '') ?? '0');
          diskUsedGb = parseFloat(usedStr?.replace('G', '') ?? '0');
        } catch {
          // Disk metrics unavailable
        }

        return Response.json({
          cpu: {
            usagePercent: Math.round(cpuPercent * 10) / 10,
            cores,
          },
          memory: {
            usedMb: Math.round(usedMem / 1024 / 1024),
            totalMb: Math.round(totalMem / 1024 / 1024),
            usagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
          },
          disk: {
            usedGb: diskUsedGb,
            totalGb: diskTotalGb,
            usagePercent: diskTotalGb > 0 ? Math.round((diskUsedGb / diskTotalGb) * 1000) / 10 : 0,
          },
          network: {
            rxBytesPerSec: 0,
            txBytesPerSec: 0,
          },
        });
      }

      // ── GET /containers — Running Docker containers ───────────
      if (url.pathname === '/containers' && req.method === 'GET') {
        try {
          const resp = await fetch('http://localhost/containers/json', {
            // @ts-ignore — Bun supports unix sockets via fetch
            unix: '/var/run/docker.sock',
            signal: AbortSignal.timeout(5000),
          });

          if (!resp.ok) throw new Error(`Docker API: ${resp.status}`);
          const raw = (await resp.json()) as Array<Record<string, unknown>>;

          const containers = raw.map((c) => ({
            id: ((c.Id as string) ?? '').slice(0, 12),
            name: ((c.Names as string[]) ?? [])[0]?.replace(/^\//, '') ?? 'unknown',
            image: (c.Image as string) ?? 'unknown',
            status: (c.Status as string) ?? 'unknown',
            state: (c.State as string) ?? 'unknown',
            ports: ((c.Ports as Array<{ PublicPort?: number; PrivatePort?: number; Type?: string }>) ?? [])
              .filter((p) => p.PublicPort)
              .map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type ?? 'tcp'}`),
            createdAt: c.Created ? new Date((c.Created as number) * 1000).toISOString() : '',
            labels: (c.Labels as Record<string, string>) ?? {},
          }));

          return Response.json(containers);
        } catch (err) {
          return Response.json([]);
        }
      }

      // ── GET /workers — Worker registry status ─────────────────
      if (url.pathname === '/workers' && req.method === 'GET') {
        const workerHealth = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/health`);
        const workerStatus = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/status`);

        const workerId = (workerHealth?.worker_id ?? workerStatus?.worker_id ?? 'unknown') as string;
        const uptimeMs = (workerHealth?.uptime as number) ?? 0;

        return Response.json([
          {
            workerId,
            containerId: '',
            containerName: 'ghosthands-worker-1',
            status: (workerHealth?.status as string) ?? 'unknown',
            activeJobs: (workerStatus?.active_jobs as number) ?? 0,
            statusPort: WORKER_PORT,
            uptime: Math.round(uptimeMs / 1000),
            image: 'ghosthands:latest',
          },
        ]);
      }

      // ── GET /deploys — Deploy history records ─────────────────
      if (url.pathname === '/deploys' && req.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        return Response.json(getRecords(limit));
      }

      // ── GET /deploys/:id — Single deploy record ───────────────
      if (url.pathname.startsWith('/deploys/') && req.method === 'GET') {
        const id = url.pathname.slice('/deploys/'.length);
        const record = getRecord(id);
        if (!record) return Response.json({ error: 'Deploy record not found' }, { status: 404 });
        return Response.json(record);
      }

      // ── GET /fleet — Dynamic fleet registry ──────────────────
      // Returns the list of servers ATM knows about.
      // Prefers fleet config (FLEET_CONFIG env or fleet.json), falls back to env vars.
      if (url.pathname === '/fleet' && req.method === 'GET') {
        if (fleetServers.length > 0) {
          return Response.json({ servers: fleetServers });
        }

        // Fallback: build from env vars (legacy single-server mode)
        const servers: Array<Record<string, unknown>> = [
          {
            id: 'atm-gw1',
            name: 'ATM Server',
            host: '', // empty = same origin (dashboard is served from ATM)
            environment: currentEnvironment,
            region: process.env.AWS_REGION || 'us-east-1',
            ip: process.env.ATM_IP || '34.195.147.149',
            type: process.env.ATM_INSTANCE_TYPE || 't3.large',
            role: 'atm',
          },
        ];

        // Add GH worker if configured (GH_API_HOST != localhost means remote)
        if (API_HOST && API_HOST !== 'localhost' && API_HOST !== '127.0.0.1') {
          servers.push({
            id: 'gh-worker-1',
            name: 'GH Worker 1',
            host: '/fleet/gh-worker-1', // proxy path — dashboard calls ATM, ATM forwards
            environment: currentEnvironment,
            region: process.env.AWS_REGION || 'us-east-1',
            ip: API_HOST,
            type: process.env.GH_INSTANCE_TYPE || 't3.large',
            role: 'ghosthands',
          });
        }

        return Response.json({ servers });
      }

      // ── POST /fleet/reload — Reload fleet config from disk ─────
      if (url.pathname === '/fleet/reload' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { error: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }
        const servers = loadFleetConfig();
        return Response.json({ success: true, count: servers.length, servers });
      }

      // ── GET /fleet/idle-status — EC2 idle monitor status ─────
      if (url.pathname === '/fleet/idle-status' && req.method === 'GET') {
        return Response.json({
          enabled: EC2_IDLE_ENABLED,
          config: {
            idleTimeoutMs: EC2_IDLE_TIMEOUT_MS,
            minRunning: EC2_MIN_RUNNING,
            pollIntervalMs: EC2_POLL_INTERVAL_MS,
          },
          workers: idleMonitor.getWorkerStates().map(w => ({
            serverId: w.serverId,
            ip: w.ip,
            instanceId: w.instanceId,
            ec2State: w.ec2State,
            activeJobs: w.activeJobs,
            idleSinceMs: Date.now() - w.lastActiveAt,
            transitioning: w.transitioning,
          })),
        });
      }

      // ── POST /fleet/wake — Wake N stopped workers ─────────────
      if (url.pathname === '/fleet/wake' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { error: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }

        let count = 1;
        try {
          const body = await req.json() as { count?: number };
          if (body.count && body.count > 0) count = body.count;
        } catch {
          // Default count=1
        }

        const states = idleMonitor.getWorkerStates();
        const stopped = states.filter(
          s => (s.ec2State === 'stopped' || s.ec2State === 'standby') && !s.transitioning && s.instanceId,
        );

        if (stopped.length === 0) {
          // Check if any are waking
          const waking = states.filter(s => s.transitioning || s.ec2State === 'pending');
          if (waking.length > 0) {
            return Response.json({ status: 'waking', waking: waking.map(w => w.serverId) });
          }
          return Response.json({ status: 'no_action', message: 'All workers are running or waking' });
        }

        const toWake = stopped.slice(0, count);
        const results: { serverId: string; status: string; instanceId: string }[] = [];

        for (const worker of toWake) {
          idleMonitor.markTransitioning(worker.serverId, true);
          try {
            await startInstance(worker.instanceId!);
            // Exit ASG standby if needed (non-fatal)
            if (worker.inStandby && worker.asgName) {
              try {
                await exitStandby(worker.instanceId!, worker.asgName);
                worker.inStandby = false;
              } catch (err) {
                console.warn(`[fleet/wake] exitStandby failed for ${worker.serverId} (non-fatal):`, err);
              }
            }
            idleMonitor.updateWorkerEc2(worker.serverId, 'pending');
            idleMonitor.markActive(worker.serverId);
            idleMonitor.markTransitioning(worker.serverId, false);
            results.push({ serverId: worker.serverId, status: 'starting', instanceId: worker.instanceId! });
          } catch (err) {
            idleMonitor.markTransitioning(worker.serverId, false);
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ serverId: worker.serverId, status: 'error', instanceId: worker.instanceId! });
            console.error(`[fleet/wake] Failed to start ${worker.serverId}:`, msg);
          }
        }

        return Response.json({ status: 'waking', results });
      }

      // ── POST /fleet/:id/wake — Wake a specific worker ─────────
      if (url.pathname.match(/^\/fleet\/[^/]+\/wake$/) && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { error: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }

        const serverId = url.pathname.split('/')[2];
        const fleetEntry = fleetServers.find(s => s.id === serverId);
        if (!fleetEntry) {
          return Response.json({ error: `Unknown server: ${serverId}` }, { status: 404 });
        }
        if (fleetEntry.role !== 'ghosthands') {
          return Response.json({ error: `Cannot wake non-GH server: ${serverId}` }, { status: 400 });
        }

        // Get the monitor state for this worker
        const workerState = idleMonitor.getWorkerStates().find(s => s.serverId === serverId);
        const instanceId = workerState?.instanceId || fleetEntry.ec2InstanceId;

        if (!instanceId) {
          return Response.json({ error: `No EC2 instance ID for ${serverId}` }, { status: 400 });
        }

        // Check current state
        if (workerState?.transitioning) {
          return Response.json({ status: 'waking', serverId, instanceId });
        }

        try {
          const info = await describeInstance(instanceId);

          if (info.state === 'running') {
            // Verify it's actually healthy
            try {
              const healthResp = await fetch(
                `http://${fleetEntry.ip}:${WORKER_PORT}/worker/health`,
                { signal: AbortSignal.timeout(5000) },
              );
              if (healthResp.ok) {
                return Response.json({ status: 'already_running', serverId, instanceId, ip: info.publicIp });
              }
            } catch {
              // Running but not healthy yet — still return already_running
            }
            return Response.json({ status: 'already_running', serverId, instanceId, ip: info.publicIp });
          }

          if (info.state === 'stopping') {
            return Response.json(
              { error: 'Instance is stopping, retry later', state: info.state },
              { status: 409 },
            );
          }

          // Start the instance
          if (workerState) idleMonitor.markTransitioning(serverId, true);
          await startInstance(instanceId);
          if (workerState) {
            idleMonitor.updateWorkerEc2(serverId, 'pending');
            idleMonitor.markActive(serverId);
          }

          // Poll until healthy (120s timeout)
          const deadline = Date.now() + 120_000;
          let healthy = false;
          let newIp: string | null = null;

          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            try {
              const desc = await describeInstance(instanceId);
              newIp = desc.publicIp;
              if (desc.state === 'running' && newIp) {
                // Update fleet IP if changed
                if (newIp !== fleetEntry.ip) {
                  fleetEntry.ip = newIp;
                  if (workerState) idleMonitor.updateWorkerEc2(serverId, 'running', newIp);
                }
                // Check worker health
                try {
                  const healthResp = await fetch(
                    `http://${newIp}:${WORKER_PORT}/worker/health`,
                    { signal: AbortSignal.timeout(5000) },
                  );
                  if (healthResp.ok) {
                    healthy = true;
                    break;
                  }
                } catch {
                  // Not healthy yet
                }
              }
            } catch {
              // EC2 not ready yet
            }
          }

          // Exit ASG standby if needed (non-fatal)
          let exitedStandby = false;
          if (workerState?.inStandby && workerState.asgName) {
            try {
              await exitStandby(instanceId, workerState.asgName);
              workerState.inStandby = false;
              exitedStandby = true;
            } catch (err) {
              console.warn(`[fleet/${serverId}/wake] exitStandby failed (non-fatal):`, err);
            }
          }

          if (workerState) idleMonitor.markTransitioning(serverId, false);

          if (healthy) {
            if (workerState) idleMonitor.updateWorkerEc2(serverId, 'running', newIp!);
            return Response.json({ status: 'started', serverId, instanceId, ip: newIp, exitedStandby });
          } else {
            return Response.json({ status: 'started_unhealthy', serverId, instanceId, ip: newIp, exitedStandby });
          }
        } catch (err) {
          if (workerState) idleMonitor.markTransitioning(serverId, false);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[fleet/${serverId}/wake] Error:`, msg);
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      // ── POST /fleet/:id/stop — Stop a running worker ──────────
      if (url.pathname.match(/^\/fleet\/[^/]+\/stop$/) && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { error: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }

        const serverId = url.pathname.split('/')[2];
        const fleetEntry = fleetServers.find(s => s.id === serverId);
        if (!fleetEntry) {
          return Response.json({ error: `Unknown server: ${serverId}` }, { status: 404 });
        }
        if (fleetEntry.role !== 'ghosthands') {
          return Response.json({ error: `Cannot stop non-GH server: ${serverId}` }, { status: 400 });
        }

        const workerState = idleMonitor.getWorkerStates().find(s => s.serverId === serverId);
        const instanceId = workerState?.instanceId || fleetEntry.ec2InstanceId;

        if (!instanceId) {
          return Response.json({ error: `No EC2 instance ID for ${serverId}` }, { status: 400 });
        }

        if (workerState?.transitioning) {
          return Response.json(
            { error: 'Instance is transitioning, retry later' },
            { status: 409 },
          );
        }

        try {
          const info = await describeInstance(instanceId);

          if (info.state === 'stopped' || info.state === 'stopping') {
            return Response.json(
              { error: `Instance is already ${info.state}`, state: info.state },
              { status: 409 },
            );
          }

          // Check for active jobs before stopping
          if (workerState && workerState.activeJobs > 0) {
            return Response.json(
              { error: 'Worker has active jobs — drain first', activeJobs: workerState.activeJobs },
              { status: 409 },
            );
          }

          // Best-effort live health check for active jobs
          try {
            const healthResp = await fetch(
              `http://${fleetEntry.ip}:${WORKER_PORT}/worker/health`,
              { signal: AbortSignal.timeout(5000) },
            );
            if (healthResp.ok) {
              const data = (await healthResp.json()) as { active_jobs?: number };
              if (data.active_jobs && data.active_jobs > 0) {
                return Response.json(
                  { error: 'Worker has active jobs — drain first', activeJobs: data.active_jobs },
                  { status: 409 },
                );
              }
            }
          } catch {
            // Worker unreachable — safe to stop
          }

          if (workerState) idleMonitor.markTransitioning(serverId, true);

          // Enter ASG standby first if ASG-managed
          let enteredStandby = false;
          if (workerState?.asgName && !workerState.inStandby) {
            try {
              await enterStandby(instanceId, workerState.asgName);
              workerState.inStandby = true;
              enteredStandby = true;
            } catch (err) {
              if (workerState) idleMonitor.markTransitioning(serverId, false);
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[fleet/${serverId}/stop] enterStandby failed:`, msg);
              return Response.json({ error: `enterStandby failed: ${msg}` }, { status: 500 });
            }
          }

          await stopInstance(instanceId);
          if (workerState) {
            idleMonitor.updateWorkerEc2(serverId, 'stopping');
            idleMonitor.markTransitioning(serverId, false);
          }

          return Response.json({ status: 'stopping', serverId, instanceId, enteredStandby });
        } catch (err) {
          if (workerState) idleMonitor.markTransitioning(serverId, false);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[fleet/${serverId}/stop] Error:`, msg);
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      // ── GET /fleet/:id/* — Smart proxy to fleet servers ───────
      // Intercepts known sub-paths and transforms raw GH responses into
      // the shapes the ATM dashboard expects (HealthResponse, VersionResponse, etc.).
      // Falls back to dumb proxy for unknown sub-paths.
      if (url.pathname.startsWith('/fleet/') && req.method === 'GET') {
        const rest = url.pathname.slice('/fleet/'.length); // "gh-worker-1/health"
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
          return Response.json({ error: 'Missing path: /fleet/:id/:endpoint' }, { status: 400 });
        }
        const serverId = rest.slice(0, slashIdx);
        const endpoint = rest.slice(slashIdx); // "/health"

        // Self-proxy for ATM's own server
        if (serverId === 'atm-gw1') {
          const selfUrl = new URL(endpoint + url.search, req.url);
          return handleRequest(new Request(selfUrl.toString(), req));
        }

        // Dynamic lookup from fleet config, with env-var fallback for gh-worker-1
        const fleetEntry = fleetServers.find(s => s.id === serverId)
          || (serverId === 'gh-worker-1' ? { ip: API_HOST } : null);

        if (!fleetEntry || !fleetEntry.ip) {
          return Response.json({ error: `Unknown server: ${serverId}` }, { status: 404 });
        }

        // Fast-return for ALL endpoints when worker is stopped/standby (avoids timeout probing unreachable hosts)
        const workerState = idleMonitor.getWorkerStates().find(w => w.serverId === serverId);
        if (workerState && (workerState.ec2State === 'stopped' || workerState.ec2State === 'standby' || workerState.ec2State === 'stopping')) {
          return Response.json({
            status: 'offline',
            ec2State: workerState.ec2State,
            activeWorkers: 0,
            deploySafe: false,
            apiHealthy: false,
            workerStatus: 'unreachable',
            currentDeploy: null,
            uptimeMs: 0,
          });
        }

        const serverIp = workerState?.ip ?? fleetEntry.ip;
        const ghApiBase = `http://${serverIp}:${API_PORT}`;
        const ghWorkerBase = `http://${serverIp}:${WORKER_PORT}`;

        /** Safe fetch that returns null on failure instead of throwing */
        const safeFetch = async <T>(url: string): Promise<T | null> => {
          try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!resp.ok) return null;
            return (await resp.json()) as T;
          } catch {
            return null;
          }
        };

        // ── /fleet/:id/health — Aggregate GH API + Worker health ──
        if (endpoint === '/health') {
          const [apiHealth, workerHealth, workerStatus] = await Promise.all([
            safeFetch<{ status: string; service?: string; version?: string }>(
              `${ghApiBase}/health`,
            ),
            safeFetch<{ status: string; active_jobs: number; deploy_safe: boolean }>(
              `${ghWorkerBase}/worker/health`,
            ),
            safeFetch<{ worker_id: string; uptime_ms: number; active_jobs: number }>(
              `${ghWorkerBase}/worker/status`,
            ),
          ]);

          const apiOk = apiHealth?.status === 'ok';
          const workerOk = !!workerHealth;

          return Response.json({
            status: apiOk && workerOk ? 'healthy' : apiOk || workerOk ? 'degraded' : 'offline',
            activeWorkers: workerStatus?.active_jobs ?? workerHealth?.active_jobs ?? 0,
            deploySafe: workerHealth?.deploy_safe ?? false,
            apiHealthy: apiOk,
            workerStatus: workerHealth?.status ?? 'unreachable',
            currentDeploy: currentDeploy?.imageTag ?? null,
            uptimeMs: workerStatus?.uptime_ms ?? 0,
          });
        }

        // ── /fleet/:id/version — Build VersionResponse from GH API ──
        if (endpoint === '/version') {
          const apiHealth = await safeFetch<{
            status: string;
            service?: string;
            version?: string;
            environment?: string;
            commit_sha?: string;
            timestamp?: string;
          }>(`${ghApiBase}/health`);

          const versionInfo = await safeFetch<{
            version?: string;
            commit_sha?: string;
            build_time?: string;
            uptime?: number;
          }>(`${ghApiBase}/health/version`);

          const ghInfo = apiHealth
            ? {
                service: apiHealth.service ?? 'ghosthands',
                environment: apiHealth.environment ?? currentEnvironment,
                commit_sha: versionInfo?.commit_sha ?? apiHealth.commit_sha ?? 'unknown',
                image_tag: process.env.ECR_IMAGE || 'unknown',
                build_time: versionInfo?.build_time ?? apiHealth.timestamp ?? '',
                uptime_ms: versionInfo?.uptime ?? 0,
                node_env: apiHealth.environment ?? currentEnvironment,
              }
            : { status: 'unreachable' };

          return Response.json({
            deployServer: 'atm-api',
            version: apiHealth?.version ?? versionInfo?.version ?? 'unknown',
            ghosthands: ghInfo,
            uptimeMs: Date.now() - startedAt,
          });
        }

        // ── /fleet/:id/workers — Build Worker[] from GH worker endpoints ──
        if (endpoint === '/workers') {
          const [workerHealth, workerStatus] = await Promise.all([
            safeFetch<{ status: string; active_jobs: number; deploy_safe: boolean }>(
              `${ghWorkerBase}/worker/health`,
            ),
            safeFetch<{
              worker_id: string;
              ec2_instance_id?: string;
              ec2_ip?: string;
              active_jobs: number;
              max_concurrent: number;
              is_running: boolean;
              is_draining: boolean;
              uptime_ms: number;
            }>(`${ghWorkerBase}/worker/status`),
          ]);

          if (!workerHealth && !workerStatus) {
            return Response.json([]);
          }

          const worker = {
            workerId: workerStatus?.worker_id ?? 'unknown',
            containerId: workerStatus?.ec2_instance_id ?? '',
            containerName: 'ghosthands-worker',
            status: workerHealth?.status ?? (workerStatus?.is_draining ? 'draining' : workerStatus?.is_running ? 'idle' : 'offline'),
            activeJobs: workerStatus?.active_jobs ?? workerHealth?.active_jobs ?? 0,
            statusPort: WORKER_PORT,
            uptime: String(workerStatus?.uptime_ms ?? 0),
            image: process.env.ECR_IMAGE || 'unknown',
          };

          return Response.json([worker]);
        }

        // ── /fleet/:id/metrics — Try GH /health/system, fall back to zeros ──
        if (endpoint === '/metrics') {
          const sysMetrics = await safeFetch<{
            cpu: { usagePercent: number; cores: number };
            memory: { usedMb: number; totalMb: number; usagePercent: number };
            disk: { usedGb: number; totalGb: number; usagePercent: number };
          }>(`${ghApiBase}/health/system`);

          if (sysMetrics) {
            return Response.json(sysMetrics);
          }

          return Response.json({
            cpu: { usagePercent: 0, cores: 0 },
            memory: { usedMb: 0, totalMb: 0, usagePercent: 0 },
            disk: { usedGb: 0, totalGb: 0, usagePercent: 0 },
          });
        }

        // ── /fleet/:id/containers — Can't query Docker on remote GH ──
        if (endpoint === '/containers') {
          return Response.json([]);
        }

        // ── /fleet/:id/deploys — Return ATM's own deploy history ──
        if (endpoint === '/deploys') {
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          return Response.json(getRecords(limit));
        }

        // ── Fallback: dumb proxy for unknown sub-paths ──
        const workerEndpoints = ['/worker/', '/workers'];
        const isWorkerEndpoint = workerEndpoints.some((p) => endpoint.startsWith(p));
        const targetBase = isWorkerEndpoint ? ghWorkerBase : ghApiBase;

        try {
          const targetUrl = `${targetBase}${endpoint}${url.search}`;
          const resp = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) });
          const body = await resp.text();
          return new Response(body, {
            status: resp.status,
            headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
          });
        } catch (err: any) {
          return Response.json(
            { error: `Proxy to ${serverId} failed: ${err.message}` },
            { status: 502 },
          );
        }
      }

      // ── GET /secrets/status — Infisical connection status ──────
      if (url.pathname === '/secrets/status' && req.method === 'GET') {
        const status = await getInfisicalStatus();
        return Response.json(status);
      }

      // ── GET /secrets/list — List all secret keys (authenticated) ──
      // Optional query param: ?path=/valet (default: /)
      if (url.pathname === '/secrets/list' && req.method === 'GET') {
        if (!verifySecret(req)) {
          return Response.json(
            { error: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }
        const secretPath = url.searchParams.get('path') || '/';
        const keys = await listSecretKeys(secretPath);
        return Response.json(keys);
      }

      // ── GET /secrets/ghosthands — Fetch all GH secrets for Mac deploy ──
      // Optional query param: ?environment=staging (default: INFISICAL_ENVIRONMENT)
      // Filters out EC2-specific keys not needed on Mac
      if (url.pathname === '/secrets/ghosthands' && req.method === 'GET') {
        if (!verifySecret(req)) {
          return Response.json(
            { error: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }
        const environment = url.searchParams.get('environment') || undefined;
        try {
          const allSecrets = await fetchSecretsForPath('/ghosthands', environment);

          // Filter out EC2-specific keys not needed on Mac
          const EC2_ONLY_KEYS = ['AWS_ASG_NAME', 'AWS_LIFECYCLE_HOOK_NAME', 'ECR_REGISTRY', 'ECR_REPOSITORY', 'VNC_PW'];
          const secrets: Record<string, string> = {};
          for (const [key, value] of Object.entries(allSecrets)) {
            if (!EC2_ONLY_KEYS.includes(key)) {
              secrets[key] = value;
            }
          }

          return Response.json({
            secrets,
            count: Object.keys(secrets).length,
            environment: environment || process.env.INFISICAL_ENVIRONMENT || 'staging',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      // ── GET /secrets/:key — Get a single secret value (authenticated) ──
      // Optional query param: ?path=/valet (default: /)
      if (url.pathname.startsWith('/secrets/') && url.pathname !== '/secrets/status' && url.pathname !== '/secrets/list' && url.pathname !== '/secrets/ghosthands' && req.method === 'GET') {
        if (!verifySecret(req)) {
          return Response.json(
            { error: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }
        const secretKey = decodeURIComponent(url.pathname.slice('/secrets/'.length));
        const secretPath = url.searchParams.get('path') || '/';
        try {
          const secret = await getSecretValue(secretKey, secretPath);
          return Response.json(secret);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: msg }, { status: 404 });
        }
      }

      // ── POST /deploy — Authenticated deploy trigger ─────────
      if (url.pathname === '/deploy' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }

        if (currentDeploy) {
          return Response.json(
            {
              success: false,
              message: `Deploy already in progress: ${currentDeploy.imageTag} (started ${Math.round((Date.now() - currentDeploy.startedAt) / 1000)}s ago)`,
            },
            { status: 409 },
          );
        }

        let body: { image_tag?: string } = {};
        try {
          body = (await req.json()) as { image_tag?: string };
        } catch {
          return Response.json(
            { success: false, message: 'Invalid JSON body' },
            { status: 400 },
          );
        }

        const imageTag = body.image_tag || 'latest';

        if (!/^[a-zA-Z0-9._\-/:]+$/.test(imageTag)) {
          return Response.json(
            { success: false, message: 'Invalid image_tag format' },
            { status: 400 },
          );
        }

        console.log(`[atm-api] Deploy requested: image_tag=${imageTag}`);

        currentDeploy = {
          imageTag,
          startedAt: Date.now(),
          step: 'initializing',
        };

        // Record deploy in history
        const deployRecord = createDeployRecord(imageTag, 'ci');

        try {
          const result = await executeDeploy(imageTag);
          currentDeploy = null;

          if (result.success) {
            updateRecord(deployRecord.id, {
              status: 'completed',
              completedAt: new Date().toISOString(),
              durationMs: result.duration,
            });
            console.log(`[atm-api] Deploy succeeded: ${imageTag} (${result.duration}ms)`);
            return Response.json({
              success: true,
              message: `Deploy successful: ${imageTag}`,
              duration: result.duration,
              imageTag: result.imageTag,
            });
          } else {
            updateRecord(deployRecord.id, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error: result.error,
            });
            console.error(`[atm-api] Deploy failed: ${imageTag} — ${result.error}`);
            return Response.json(
              {
                success: false,
                error: result.error,
                failedStep: result.failedStep,
                failedService: result.failedService,
              },
              { status: 500 },
            );
          }
        } catch (err) {
          currentDeploy = null;
          const msg = err instanceof Error ? err.message : String(err);
          updateRecord(deployRecord.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: msg,
          });
          console.error(`[atm-api] Deploy error: ${msg}`);
          return Response.json(
            { success: false, error: `Deploy error: ${msg}` },
            { status: 500 },
          );
        }
      }

      // ── POST /drain — Authenticated drain trigger ───────────
      if (url.pathname === '/drain' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized' },
            { status: 401 },
          );
        }

        console.log('[atm-api] Drain requested');
        try {
          await drainService(`http://${WORKER_HOST}:${WORKER_PORT}/drain`, 60_000);
          return Response.json({ success: true, message: 'Drain complete' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ success: false, message: `Drain failed: ${msg}` }, { status: 500 });
        }
      }

      // ── POST /drain/graceful — Graceful drain with SSE progress ──
      if (url.pathname === '/drain/graceful' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized' },
            { status: 401 },
          );
        }

        let body: { timeoutMs?: number } = {};
        try {
          body = (await req.json()) as { timeoutMs?: number };
        } catch {
          // default timeout
        }

        const timeoutMs = Math.min(body.timeoutMs || 300_000, 1_800_000); // default 5min, max 30min

        console.log(`[atm-api] Graceful drain requested (timeout: ${timeoutMs}ms)`);

        // Discover all worker containers via Docker labels
        const workerContainers: { name: string; port: number }[] = [];
        try {
          const allContainers = await listContainers(false);
          for (const c of allContainers) {
            const labels = (c.Labels as Record<string, string>) ?? {};
            if (labels['gh.service'] === 'worker') {
              const cName = ((c.Names as string[])?.[0] ?? '').replace(/^\//, '');
              const idx = parseInt(labels['gh.worker.index'] ?? '0', 10);
              workerContainers.push({ name: cName, port: 3101 + idx });
            }
          }
        } catch {
          workerContainers.push({ name: 'ghosthands-worker', port: WORKER_PORT });
        }

        if (workerContainers.length === 0) {
          workerContainers.push({ name: 'ghosthands-worker', port: WORKER_PORT });
        }

        // SSE stream for drain progress
        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();

        const sendEvent = (data: Record<string, unknown>) => {
          writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)).catch(() => {});
        };

        // Run drain in background
        (async () => {
          try {
            for (const w of workerContainers) {
              try {
                await fetch(`http://${WORKER_HOST}:${w.port}/worker/drain`, {
                  method: 'POST',
                  signal: AbortSignal.timeout(10_000),
                });
              } catch {
                // Worker may not have drain endpoint
              }
              sendEvent({ type: 'drain', worker: w.name, status: 'draining', activeJobs: -1 });
            }

            const deadline = Date.now() + timeoutMs;
            const drained = new Set<string>();

            while (Date.now() < deadline && drained.size < workerContainers.length) {
              for (const w of workerContainers) {
                if (drained.has(w.name)) continue;
                try {
                  const status = await fetchJson(`http://${WORKER_HOST}:${w.port}/worker/status`);
                  const activeJobs = (status?.active_jobs as number) ?? 0;
                  sendEvent({ type: 'drain', worker: w.name, activeJobs, status: activeJobs === 0 ? 'drained' : 'draining' });
                  if (activeJobs === 0) {
                    drained.add(w.name);
                  }
                } catch {
                  sendEvent({ type: 'drain', worker: w.name, activeJobs: 0, status: 'drained' });
                  drained.add(w.name);
                }
              }
              if (drained.size < workerContainers.length) {
                await new Promise((r) => setTimeout(r, 2000));
              }
            }

            const allDrained = drained.size === workerContainers.length;
            sendEvent({ type: 'complete', allDrained });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sendEvent({ type: 'error', message: msg });
          } finally {
            try { writer.close(); } catch { /* already closed */ }
          }
        })();

        return new Response(readable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // ── POST /cleanup — Authenticated disk cleanup trigger ──────
      if (url.pathname === '/cleanup' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized' },
            { status: 401 },
          );
        }

        console.log('[atm-api] Disk cleanup requested');
        try {
          const output = await new Promise<string>((resolve, reject) => {
            exec(
              'bash /opt/ghosthands/scripts/disk-cleanup.sh 2>&1',
              { encoding: 'utf-8', timeout: 120_000 },
              (error, stdout, stderr) => {
                if (error) {
                  reject(new Error(stdout || stderr || error.message));
                } else {
                  resolve(stdout);
                }
              },
            );
          });
          console.log('[atm-api] Disk cleanup completed');
          return Response.json({ success: true, message: 'Cleanup completed', output });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[atm-api] Disk cleanup failed: ${msg}`);
          return Response.json(
            { success: false, message: `Cleanup failed: ${msg}` },
            { status: 500 },
          );
        }
      }

      // ── POST /rollback — Rollback to last successful deploy ──────
      if (url.pathname === '/rollback' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized' },
            { status: 401 },
          );
        }

        console.log('[atm-api] Rollback requested');
        const rollbackResult = await executeRollback(executeDeploy);
        if (rollbackResult.success) {
          return Response.json(rollbackResult);
        } else {
          return Response.json(rollbackResult, { status: 400 });
        }
      }

      // ── POST /admin/refresh-secrets — Re-fetch secrets from Infisical/AWS SM ──
      if (url.pathname === '/admin/refresh-secrets' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized' },
            { status: 401 },
          );
        }

        console.log('[atm-api] Refreshing secrets...');
        try {
          // Try Infisical first, fall back to AWS SM
          try {
            await loadSecretsFromInfisical();
          } catch {
            // Infisical failed — fall back
          }
          await loadSecretsFromAwsSm();
          return Response.json({ success: true, message: 'Secrets refreshed' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json(
            { success: false, message: `Secrets refresh failed: ${msg}` },
            { status: 500 },
          );
        }
      }

      // ── GET /deploy/stream — SSE deploy log stream ──────────
      if (url.pathname === '/deploy/stream' && req.method === 'GET') {
        return deployStream.createStream();
      }

      // ── GET /kamal/validate — Pre-deploy validation checks ────
      if (url.pathname === '/kamal/validate' && req.method === 'GET') {
        const destination = url.searchParams.get('destination') || 'staging';
        const checks: Record<string, { ok: boolean; detail?: string }> = {};

        // 1. Kamal CLI available
        checks.kamal = { ok: await isKamalAvailable() };

        // 2. Kamal config valid (validates config + SSH connectivity)
        try {
          const configResult = await spawnKamal(['config', '-d', destination]);
          checks.config = {
            ok: configResult.exitCode === 0,
            detail: configResult.exitCode === 0 ? 'valid' : configResult.stderr.slice(0, 200),
          };
        } catch (e: any) {
          checks.config = { ok: false, detail: e.message };
        }

        // 3. Infisical connection
        const infStatus = await getInfisicalStatus();
        checks.infisical = { ok: infStatus.connected, detail: infStatus.error };

        const allOk = Object.values(checks).every((c) => c.ok);
        return Response.json({ ready: allOk, destination, checks }, { status: allOk ? 200 : 503 });
      }

      // ── GET /kamal/status — Kamal availability + lock status ──
      if (url.pathname === '/kamal/status' && req.method === 'GET') {
        const available = await isKamalAvailable();
        if (!available) {
          return Response.json({ available: false });
        }
        const lock = await kamalLockStatus(currentEnvironment);
        return Response.json({
          available: true,
          locked: lock.locked,
          ...(lock.holder ? { holder: lock.holder } : {}),
          ...(lock.reason ? { reason: lock.reason } : {}),
        });
      }

      // ── GET /kamal/audit — Kamal audit log ────────────────────
      if (url.pathname === '/kamal/audit' && req.method === 'GET') {
        try {
          const entries = await kamalAudit(currentEnvironment);
          return Response.json(entries);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: `Audit failed: ${msg}` }, { status: 500 });
        }
      }

      // ── GET /kamal/hosts — Hosts per role per destination ─────
      if (url.pathname === '/kamal/hosts' && req.method === 'GET') {
        try {
          const configDir = resolveProjectPath('config');
          if (!configDir) {
            return Response.json({ error: 'Config directory not found' }, { status: 500 });
          }
          const destinations = ['staging', 'production'];
          const result: Record<string, Record<string, string[]>> = {};

          for (const dest of destinations) {
            const destFile = path.join(configDir, `deploy.${dest}.yml`);
            try {
              const content = fs.readFileSync(destFile, 'utf-8');
              const hosts = parseKamalHosts(content);
              result[dest] = hosts;
            } catch {
              result[dest] = { web: [], workers: [] };
            }
          }

          return Response.json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: `Failed to read Kamal config: ${msg}` }, { status: 500 });
        }
      }

      // ── POST /deploy/kamal — Kamal deploy trigger ─────────────
      if (url.pathname === '/deploy/kamal' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }

        if (currentDeploy) {
          return Response.json(
            {
              success: false,
              message: `Deploy already in progress: ${currentDeploy.imageTag} (started ${Math.round((Date.now() - currentDeploy.startedAt) / 1000)}s ago)`,
            },
            { status: 409 },
          );
        }

        let body: { destination?: string; version?: string } = {};
        try {
          body = (await req.json()) as { destination?: string; version?: string };
        } catch {
          return Response.json(
            { success: false, message: 'Invalid JSON body' },
            { status: 400 },
          );
        }

        const destination = body.destination || currentEnvironment;
        const version = body.version;
        const imageTag = version || 'latest';

        console.log(`[atm-api] Kamal deploy requested: destination=${destination}, version=${version ?? 'latest'}`);

        // Pre-deploy drain check (skip if ?force=true)
        const force = url.searchParams.get('force') === 'true';
        if (!force) {
          console.log('[atm-api] Running pre-deploy drain check...');
          const drainError = await preDeployDrain(
            fleetServers,
            WORKER_PORT,
            WORKER_HOST,
            {
              timeoutMs: 300_000,
              onLine: (line) => deployStream.broadcastLine(line),
            },
          );
          if (drainError) {
            console.log(`[atm-api] Pre-deploy drain failed: ${drainError}`);
            return Response.json(
              { success: false, message: drainError },
              { status: 503 },
            );
          }
        }

        currentDeploy = {
          imageTag,
          startedAt: Date.now(),
          step: 'kamal-deploy',
        };

        const deployRecord = createDeployRecord(imageTag, 'kamal');

        try {
          const result = await kamalDeploy(destination, version, (line) => {
            deployStream.broadcastLine(line);
          });

          currentDeploy = null;

          if (result.exitCode === 0) {
            updateRecord(deployRecord.id, {
              status: 'completed',
              completedAt: new Date().toISOString(),
              durationMs: result.durationMs,
            });
            deployStream.broadcastComplete(true);
            console.log(`[atm-api] Kamal deploy succeeded (${result.durationMs}ms)`);
            return Response.json({
              success: true,
              message: `Kamal deploy successful`,
              duration: result.durationMs,
              imageTag,
            });
          } else {
            const error = result.stderr || result.stdout.slice(-500) || `Kamal exited with code ${result.exitCode}`;
            updateRecord(deployRecord.id, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error,
            });
            deployStream.broadcastComplete(false, error);
            console.error(`[atm-api] Kamal deploy failed (exit=${result.exitCode}):\nSTDOUT: ${result.stdout.slice(-500)}\nSTDERR: ${result.stderr.slice(-500)}`);
            return Response.json(
              { success: false, error },
              { status: 500 },
            );
          }
        } catch (err) {
          currentDeploy = null;
          const msg = err instanceof Error ? err.message : String(err);
          updateRecord(deployRecord.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: msg,
          });
          deployStream.broadcastComplete(false, msg);
          console.error(`[atm-api] Kamal deploy error: ${msg}`);
          return Response.json(
            { success: false, error: `Kamal deploy error: ${msg}` },
            { status: 500 },
          );
        }
      }

      // ── POST /rollback/kamal — Kamal rollback trigger ──────────
      if (url.pathname === '/rollback/kamal' && req.method === 'POST') {
        if (!verifySecret(req)) {
          return Response.json(
            { success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' },
            { status: 401 },
          );
        }

        let body: { destination?: string; version: string } = { version: '' };
        try {
          body = (await req.json()) as { destination?: string; version: string };
        } catch {
          return Response.json(
            { success: false, message: 'Invalid JSON body' },
            { status: 400 },
          );
        }

        if (!body.version) {
          return Response.json(
            { success: false, message: 'version is required' },
            { status: 400 },
          );
        }

        const destination = body.destination || currentEnvironment;
        const { version } = body;

        console.log(`[atm-api] Kamal rollback requested: destination=${destination}, version=${version}`);

        const deployRecord = createDeployRecord(version, 'rollback');

        try {
          const result = await kamalRollback(destination, version, (line) => {
            deployStream.broadcastLine(line);
          });

          if (result.exitCode === 0) {
            updateRecord(deployRecord.id, {
              status: 'completed',
              completedAt: new Date().toISOString(),
              durationMs: result.durationMs,
            });
            deployStream.broadcastComplete(true);
            console.log(`[atm-api] Kamal rollback succeeded to ${version} (${result.durationMs}ms)`);
            return Response.json({
              success: true,
              message: `Rolled back to ${version}`,
              duration: result.durationMs,
              version,
            });
          } else {
            const error = result.stderr || `Kamal rollback exited with code ${result.exitCode}`;
            updateRecord(deployRecord.id, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error,
            });
            deployStream.broadcastComplete(false, error);
            console.error(`[atm-api] Kamal rollback failed: ${error}`);
            return Response.json(
              { success: false, error },
              { status: 500 },
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          updateRecord(deployRecord.id, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: msg,
          });
          deployStream.broadcastComplete(false, msg);
          console.error(`[atm-api] Kamal rollback error: ${msg}`);
          return Response.json(
            { success: false, error: `Kamal rollback error: ${msg}` },
            { status: 500 },
          );
        }
      }

      // ── GET /dashboard — Serve static dashboard SPA ────────────
      if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
        const dashboardDist = path.resolve(import.meta.dir, '../atm-dashboard/dist');

        // Content-Type map for static assets
        const contentTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        };

        // Strip /dashboard prefix to get the file path
        let filePath = url.pathname === '/dashboard'
          ? '/index.html'
          : url.pathname.slice('/dashboard'.length);

        if (filePath === '' || filePath === '/') {
          filePath = '/index.html';
        }

        const fullPath = path.join(dashboardDist, filePath);
        const file = Bun.file(fullPath);

        if (await file.exists()) {
          const ext = path.extname(fullPath);
          const contentType = contentTypes[ext] || 'application/octet-stream';
          return new Response(file, {
            headers: { 'Content-Type': contentType },
          });
        }

        // SPA fallback: serve index.html for unmatched routes
        const indexPath = path.join(dashboardDist, 'index.html');
        const indexFile = Bun.file(indexPath);
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { 'Content-Type': 'text/html' },
          });
        }

        return Response.json({ error: 'Dashboard not built' }, { status: 404 });
      }

      return Response.json({ error: 'not_found' }, { status: 404 });
}
