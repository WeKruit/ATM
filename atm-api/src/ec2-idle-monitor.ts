/**
 * EC2 Idle Monitor
 *
 * Background loop that polls GH worker health, tracks idle time,
 * and stops EC2 instances after a configurable timeout.
 *
 * @module atm-api/src/ec2-idle-monitor
 */

import { stopInstance, describeInstance, describeInstancesByIps, type Ec2InstanceInfo } from './ec2-client';
import { describeAsgInstance, enterStandby, exitStandby } from './asg-client';

// ── Dependency injection for fetch (testing) ─────────────────────────

type FetchFn = typeof globalThis.fetch;

let _fetchImpl: FetchFn | null = null;

/** Override fetch for testing. Pass null to reset. */
export function setFetchImpl(impl: FetchFn | null): void {
  _fetchImpl = impl;
}

function getFetch(): FetchFn {
  return _fetchImpl ?? globalThis.fetch;
}

// ── Types ────────────────────────────────────────────────────────────

export interface WorkerIdleState {
  serverId: string;
  ip: string;
  instanceId: string | null;
  lastActiveAt: number;
  activeJobs: number;
  ec2State: 'running' | 'stopped' | 'stopping' | 'pending' | 'standby' | 'shutting-down' | 'terminated' | 'unknown';
  transitioning: boolean;
  asgName: string | null;
  inStandby: boolean;
}

export interface FleetEntry {
  id: string;
  ip: string;
  role: string;
  ec2InstanceId?: string;
}

export interface IdleMonitorConfig {
  idleTimeoutMs: number;
  minRunning: number;
  pollIntervalMs: number;
  workerPort: number;
}

// ── State ────────────────────────────────────────────────────────────

let workerStates: Map<string, WorkerIdleState> = new Map();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let config: IdleMonitorConfig = {
  idleTimeoutMs: 300_000,
  minRunning: 0,
  pollIntervalMs: 60_000,
  workerPort: 3101,
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Initialize and start the idle monitor.
 * Resolves EC2 instance IDs for fleet entries that don't have them.
 */
export async function start(
  fleet: FleetEntry[],
  opts: Partial<IdleMonitorConfig> = {},
): Promise<void> {
  config = { ...config, ...opts };
  workerStates = new Map();

  const ghServers = fleet.filter((s) => s.role === 'ghosthands');
  const now = Date.now();

  // Separate servers with and without instance IDs
  const withId = ghServers.filter((s) => s.ec2InstanceId);
  const withoutId = ghServers.filter((s) => !s.ec2InstanceId);

  // Initialize servers that already have instance IDs
  for (const server of withId) {
    workerStates.set(server.id, {
      serverId: server.id,
      ip: server.ip,
      instanceId: server.ec2InstanceId!,
      lastActiveAt: now,
      activeJobs: 0,
      ec2State: 'running',
      transitioning: false,
      asgName: null,
      inStandby: false,
    });
  }

  // Resolve instance IDs for servers that don't have them
  if (withoutId.length > 0) {
    try {
      const ips = withoutId.map((s) => s.ip);
      const resolved = await describeInstancesByIps(ips);
      const ipToInstance = new Map(resolved.map((r) => [r.publicIp, r]));

      for (const server of withoutId) {
        const info = ipToInstance.get(server.ip);
        workerStates.set(server.id, {
          serverId: server.id,
          ip: server.ip,
          instanceId: info?.instanceId ?? null,
          lastActiveAt: now,
          activeJobs: 0,
          ec2State: info?.state === 'running' ? 'running' : (info?.state ?? 'unknown'),
          transitioning: false,
          asgName: null,
          inStandby: false,
        });
      }
    } catch (err) {
      console.error('[idle-monitor] Failed to resolve instance IDs:', err);
      for (const server of withoutId) {
        workerStates.set(server.id, {
          serverId: server.id,
          ip: server.ip,
          instanceId: null,
          lastActiveAt: now,
          activeJobs: 0,
          ec2State: 'unknown',
          transitioning: false,
          asgName: null,
          inStandby: false,
        });
      }
    }
  }

  // Discover ASG membership for all workers with instance IDs
  for (const state of workerStates.values()) {
    if (!state.instanceId) continue;
    try {
      const asgInfo = await describeAsgInstance(state.instanceId);
      state.asgName = asgInfo.autoScalingGroupName;
      if (asgInfo.lifecycleState === 'Standby') {
        state.inStandby = true;
        state.ec2State = 'standby';
      }
      if (state.asgName) {
        console.log(
          `[idle-monitor] ${state.serverId} (${state.instanceId}) is ASG-managed: ${state.asgName}, lifecycle=${asgInfo.lifecycleState}`,
        );
      }
    } catch (err) {
      console.warn(`[idle-monitor] Failed to check ASG for ${state.serverId}:`, err);
    }
  }

  console.log(
    `[idle-monitor] Started: ${workerStates.size} workers, timeout=${config.idleTimeoutMs}ms, minRunning=${config.minRunning}`,
  );

  intervalHandle = setInterval(tick, config.pollIntervalMs);
}

/** Stop the idle monitor loop. */
export function stop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[idle-monitor] Stopped');
  }
}

/** Get a snapshot of all worker states. */
export function getWorkerStates(): WorkerIdleState[] {
  return Array.from(workerStates.values());
}

/** Mark a worker as transitioning (prevents concurrent start/stop). */
export function markTransitioning(serverId: string, value: boolean): void {
  const state = workerStates.get(serverId);
  if (state) state.transitioning = value;
}

/** Mark a worker as active (resets lastActiveAt). */
export function markActive(serverId: string): void {
  const state = workerStates.get(serverId);
  if (state) state.lastActiveAt = Date.now();
}

/** Update EC2 state and IP for a worker (after wake). */
export function updateWorkerEc2(serverId: string, ec2State: WorkerIdleState['ec2State'], ip?: string): void {
  const state = workerStates.get(serverId);
  if (state) {
    state.ec2State = ec2State;
    if (ip) state.ip = ip;
  }
}

// ── Internal ─────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await pollWorkerHealth();
  await evaluateIdleWorkers();
}

/**
 * Poll each worker's /worker/health endpoint and update state.
 */
export async function pollWorkerHealth(): Promise<void> {
  const f = getFetch();

  for (const state of workerStates.values()) {
    // Skip workers we know are stopped or in standby
    if (state.ec2State === 'stopped' || state.ec2State === 'stopping' || state.ec2State === 'standby') continue;

    try {
      const resp = await f(`http://${state.ip}:${config.workerPort}/worker/health`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        state.ec2State = 'unknown';
        continue;
      }

      const data = (await resp.json()) as { active_jobs?: number; status?: string };
      state.activeJobs = data.active_jobs ?? 0;
      state.ec2State = 'running';

      if (state.activeJobs > 0) {
        state.lastActiveAt = Date.now();
      }
    } catch {
      // Health check failed — if we have an instance ID, refresh state + IP from EC2
      if (state.instanceId) {
        try {
          const info = await describeInstance(state.instanceId);
          state.ec2State = info.state === 'running' ? 'running' : info.state;
          if (info.publicIp && info.publicIp !== state.ip) {
            console.log(`[idle-monitor] IP changed for ${state.serverId}: ${state.ip} → ${info.publicIp}`);
            state.ip = info.publicIp;
          }
        } catch {
          state.ec2State = 'unknown';
        }
      } else {
        state.ec2State = 'unknown';
      }
    }
  }
}

/**
 * Check each worker for idle timeout and stop if appropriate.
 */
export async function evaluateIdleWorkers(): Promise<void> {
  const now = Date.now();
  const states = Array.from(workerStates.values());

  // Count how many are running (or unknown — conservative, count as running)
  const runningCount = states.filter(
    (s) => s.ec2State === 'running' || s.ec2State === 'pending',
  ).length;

  // Find idle candidates: running, not transitioning, no active jobs, past timeout
  const candidates = states
    .filter(
      (s) =>
        s.ec2State === 'running' &&
        !s.transitioning &&
        s.activeJobs === 0 &&
        s.instanceId !== null &&
        now - s.lastActiveAt > config.idleTimeoutMs,
    )
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt); // longest-idle first

  // Enforce minRunning: only stop excess
  const canStop = Math.max(0, runningCount - config.minRunning);
  const toStop = candidates.slice(0, canStop);

  for (const worker of toStop) {
    console.log(
      `[idle-monitor] Stopping idle worker ${worker.serverId} (${worker.instanceId}), idle ${Math.round((now - worker.lastActiveAt) / 1000)}s`,
    );
    worker.transitioning = true;
    try {
      // Enter ASG standby first (if ASG-managed and not already in standby)
      if (worker.asgName && !worker.inStandby) {
        try {
          console.log(`[idle-monitor] Entering standby for ASG-managed ${worker.serverId} in ${worker.asgName}`);
          await enterStandby(worker.instanceId!, worker.asgName);
          worker.inStandby = true;
        } catch (err) {
          console.error(`[idle-monitor] enterStandby failed for ${worker.serverId}, skipping stop:`, err);
          worker.transitioning = false;
          continue; // Don't stop — ASG would replace it
        }
      }
      await stopInstance(worker.instanceId!);
      worker.ec2State = 'stopping';
    } catch (err) {
      console.error(`[idle-monitor] Failed to stop ${worker.serverId}:`, err);
    } finally {
      worker.transitioning = false;
    }
  }
}
