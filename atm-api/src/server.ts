/**
 * ATM API Server (migrated from GhostHands deploy-server.ts)
 *
 * Lightweight HTTP server on port 8000 that VALET's DeployService calls
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
 *   GET  /secrets/status       — Infisical connection status (no auth)
 *   GET  /deploy/stream        — SSE stream for real-time deploy logs (no auth)
 *   GET  /kamal/status         — Kamal availability + lock status (no auth)
 *   GET  /kamal/audit          — Kamal audit log (no auth)
 *   POST /deploy/kamal         — Trigger Kamal deploy (requires X-Deploy-Secret)
 *   POST /rollback/kamal       — Trigger Kamal rollback (requires X-Deploy-Secret)
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
 *   GH_DEPLOY_PORT       — Port to listen on (default: 8000)
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
import { loadSecretsFromInfisical, getInfisicalStatus } from './infisical-client';
import { kamalDeploy, kamalRollback, kamalLockStatus, kamalAudit, isKamalAvailable } from './kamal-runner';
import { deployStream } from './deploy-stream';
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

const DEPLOY_PORT = parseInt(process.env.GH_DEPLOY_PORT || '8000', 10);
const DEPLOY_SECRET = process.env.GH_DEPLOY_SECRET;
const API_HOST = process.env.GH_API_HOST || 'localhost';
const API_PORT = parseInt(process.env.GH_API_PORT || '3100', 10);
const WORKER_HOST = process.env.GH_WORKER_HOST || 'localhost';
const WORKER_PORT = parseInt(process.env.GH_WORKER_PORT || '3101', 10);

/** Deployment environment, determined from env vars */
const currentEnvironment: 'staging' | 'production' =
  (process.env.GH_ENVIRONMENT as 'staging' | 'production') ||
  (process.env.NODE_ENV === 'production' ? 'production' : 'staging');

const startedAt = Date.now();
let currentDeploy: { imageTag: string; startedAt: number; step: string } | null = null;

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
  console.error('[atm-api] FATAL: GH_DEPLOY_SECRET is required');
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

if (typeof Bun !== 'undefined') {
  Bun.serve({
    port: DEPLOY_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // ── GET /health — Unauthenticated health check ──────────
      if (url.pathname === '/health' && req.method === 'GET') {
        const apiHealth = await fetchJson(`http://${API_HOST}:${API_PORT}/health`);
        const workerHealth = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/health`);
        const workerStatus = await fetchJson(`http://${WORKER_HOST}:${WORKER_PORT}/worker/status`);

        const activeWorkers = (workerStatus?.active_jobs as number) ?? 0;
        const deploySafe = (workerHealth?.deploy_safe as boolean) ?? (activeWorkers === 0);

        return Response.json({
          status: apiHealth ? 'ok' : 'degraded',
          activeWorkers,
          deploySafe,
          apiHealthy: !!apiHealth,
          workerStatus: workerHealth?.status ?? 'unknown',
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

      // ── GET /secrets/status — Infisical connection status ──────
      if (url.pathname === '/secrets/status' && req.method === 'GET') {
        const status = await getInfisicalStatus();
        return Response.json(status);
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
            const error = result.stderr || `Kamal exited with code ${result.exitCode}`;
            updateRecord(deployRecord.id, {
              status: 'failed',
              completedAt: new Date().toISOString(),
              error,
            });
            deployStream.broadcastComplete(false, error);
            console.error(`[atm-api] Kamal deploy failed: ${error}`);
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
        const dashboardDist = path.resolve(import.meta.dir, '../../atm-dashboard/dist');

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
    },
  });

  console.log(`[atm-api] Listening on port ${DEPLOY_PORT}`);
  console.log(`[atm-api] GH API: ${API_HOST}:${API_PORT}, Worker: ${WORKER_HOST}:${WORKER_PORT}`);
  console.log(`[atm-api] Environment: ${currentEnvironment}, Deploy method: Docker API`);
} else {
  console.error('[atm-api] This server requires Bun runtime');
  process.exit(1);
}
