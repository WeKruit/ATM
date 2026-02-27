import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  start,
  stop,
  pollWorkerHealth,
  evaluateIdleWorkers,
  getWorkerStates,
  markActive,
  markTransitioning,
  setFetchImpl,
  type FleetEntry,
  type WorkerIdleState,
} from '../ec2-idle-monitor';
import { setEc2SendImpl } from '../ec2-client';
import { DescribeInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';

// ── Helpers ──────────────────────────────────────────────────────────

let ec2Calls: { commandType: string; input: any }[];
let fetchCalls: string[];

function mockWorkerHealth(responses: Record<string, { active_jobs: number } | null>) {
  setFetchImpl(((url: string, opts?: any) => {
    fetchCalls.push(url);
    // Extract IP from URL
    const match = url.match(/http:\/\/([^:]+):/);
    const ip = match?.[1] ?? '';
    const data = responses[ip];
    if (!data) {
      return Promise.reject(new Error('Connection refused'));
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
    });
  }) as any);
}

function mockEc2(opts?: { stopError?: boolean }) {
  setEc2SendImpl((command: any) => {
    const name = command.constructor?.name ?? 'Unknown';
    ec2Calls.push({ commandType: name, input: command.input });

    if (name === 'StopInstancesCommand' && opts?.stopError) {
      return Promise.reject(new Error('EC2 StopInstances failed'));
    }

    if (name === 'DescribeInstancesCommand') {
      const ips: string[] = command.input.Filters?.[0]?.Values ?? [];
      return Promise.resolve({
        Reservations: ips.map((ip: string, i: number) => ({
          Instances: [
            {
              InstanceId: `i-resolved-${i}`,
              State: { Name: 'running' },
              PublicIpAddress: ip,
            },
          ],
        })),
      });
    }

    if (name === 'StopInstancesCommand') {
      return Promise.resolve({
        StoppingInstances: [
          { CurrentState: { Name: 'stopping' }, PreviousState: { Name: 'running' } },
        ],
      });
    }

    return Promise.resolve({});
  });
}

/** Helper to set worker state directly for testing evaluateIdleWorkers */
function initWorkerStates(entries: FleetEntry[], opts: Partial<WorkerIdleState>[] = []) {
  // Start with a very long timeout so it doesn't auto-stop during init
  return start(entries, { idleTimeoutMs: 999_999_999, pollIntervalMs: 999_999_999, workerPort: 3101 }).then(() => {
    // Override states for testing
    const states = getWorkerStates();
    for (let i = 0; i < opts.length && i < states.length; i++) {
      Object.assign(states[i], opts[i]);
    }
  });
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  ec2Calls = [];
  fetchCalls = [];
  mockEc2();
});

afterEach(() => {
  stop();
  setFetchImpl(null);
  setEc2SendImpl(null);
});

// ── pollWorkerHealth ─────────────────────────────────────────────────

describe('pollWorkerHealth', () => {
  it('1: updates lastActiveAt when active_jobs > 0', async () => {
    mockEc2();
    await initWorkerStates([
      { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
    ]);

    // Set lastActiveAt to the past
    const states = getWorkerStates();
    states[0].lastActiveAt = 1000;
    states[0].ec2State = 'running';

    mockWorkerHealth({ '10.0.0.1': { active_jobs: 2 } });
    await pollWorkerHealth();

    expect(states[0].activeJobs).toBe(2);
    expect(states[0].lastActiveAt).toBeGreaterThan(1000);
    expect(states[0].ec2State as string).toBe('running');
  });

  it('2: does NOT update lastActiveAt when idle', async () => {
    mockEc2();
    await initWorkerStates([
      { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
    ]);

    const states = getWorkerStates();
    const originalTime = 5000;
    states[0].lastActiveAt = originalTime;
    states[0].ec2State = 'running';

    mockWorkerHealth({ '10.0.0.1': { active_jobs: 0 } });
    await pollWorkerHealth();

    expect(states[0].activeJobs).toBe(0);
    expect(states[0].lastActiveAt).toBe(originalTime);
  });

  it('3: sets ec2State=unknown when unreachable', async () => {
    mockEc2();
    await initWorkerStates([
      { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
    ]);

    const states = getWorkerStates();
    states[0].ec2State = 'running';

    // No health response configured for this IP → fetch throws
    mockWorkerHealth({});
    await pollWorkerHealth();

    expect(states[0].ec2State as string).toBe('unknown');
  });

  it('4: handles mixed healthy/unreachable workers', async () => {
    mockEc2();
    await initWorkerStates([
      { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
      { id: 'w2', ip: '10.0.0.2', role: 'ghosthands', ec2InstanceId: 'i-2' },
    ]);

    const states = getWorkerStates();
    states[0].ec2State = 'running';
    states[1].ec2State = 'running';

    mockWorkerHealth({ '10.0.0.1': { active_jobs: 1 } }); // w2 unreachable
    await pollWorkerHealth();

    expect(states[0].ec2State as string).toBe('running');
    expect(states[0].activeJobs).toBe(1);
    expect(states[1].ec2State as string).toBe('unknown');
  });

  it('5: skips non-GH fleet servers', async () => {
    mockEc2();
    await start(
      [
        { id: 'atm-gw1', ip: '10.0.0.99', role: 'atm' },
        { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
      ],
      { pollIntervalMs: 999_999_999 },
    );

    // Only GH worker should be tracked
    const states = getWorkerStates();
    expect(states).toHaveLength(1);
    expect(states[0].serverId).toBe('w1');
  });
});

// ── evaluateIdleWorkers ──────────────────────────────────────────────

describe('evaluateIdleWorkers', () => {
  it('6: stops worker past timeout', async () => {
    mockEc2();
    await start(
      [{ id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' }],
      { idleTimeoutMs: 1000, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    states[0].lastActiveAt = Date.now() - 5000; // 5s ago, timeout is 1s
    states[0].ec2State = 'running';
    states[0].activeJobs = 0;

    ec2Calls = []; // Reset to track only the stop call
    await evaluateIdleWorkers();

    expect(ec2Calls.some((c) => c.commandType === 'StopInstancesCommand')).toBe(true);
    expect(states[0].ec2State as string).toBe('stopping');
  });

  it('7: does not stop worker under timeout', async () => {
    mockEc2();
    await start(
      [{ id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' }],
      { idleTimeoutMs: 60_000, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    states[0].lastActiveAt = Date.now() - 1000; // 1s ago, timeout is 60s
    states[0].ec2State = 'running';
    states[0].activeJobs = 0;

    ec2Calls = [];
    await evaluateIdleWorkers();

    expect(ec2Calls.filter((c) => c.commandType === 'StopInstancesCommand')).toHaveLength(0);
  });

  it('8: does not stop worker with active_jobs > 0', async () => {
    mockEc2();
    await start(
      [{ id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' }],
      { idleTimeoutMs: 1000, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    states[0].lastActiveAt = Date.now() - 5000;
    states[0].ec2State = 'running';
    states[0].activeJobs = 1; // Active!

    ec2Calls = [];
    await evaluateIdleWorkers();

    expect(ec2Calls.filter((c) => c.commandType === 'StopInstancesCommand')).toHaveLength(0);
  });

  it('9: does not stop unreachable worker', async () => {
    mockEc2();
    await start(
      [{ id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' }],
      { idleTimeoutMs: 1000, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    states[0].lastActiveAt = Date.now() - 5000;
    states[0].ec2State = 'unknown'; // Unreachable
    states[0].activeJobs = 0;

    ec2Calls = [];
    await evaluateIdleWorkers();

    expect(ec2Calls.filter((c) => c.commandType === 'StopInstancesCommand')).toHaveLength(0);
  });

  it('10: respects minRunning=1', async () => {
    mockEc2();
    await start(
      [
        { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
        { id: 'w2', ip: '10.0.0.2', role: 'ghosthands', ec2InstanceId: 'i-2' },
      ],
      { idleTimeoutMs: 1000, minRunning: 1, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    // Both idle
    for (const s of states) {
      s.lastActiveAt = Date.now() - 5000;
      s.ec2State = 'running';
      s.activeJobs = 0;
    }

    ec2Calls = [];
    await evaluateIdleWorkers();

    // Only 1 should be stopped (runningCount=2, minRunning=1 → canStop=1)
    const stopCalls = ec2Calls.filter((c) => c.commandType === 'StopInstancesCommand');
    expect(stopCalls).toHaveLength(1);
  });

  it('11: respects minRunning=0 (can stop all)', async () => {
    mockEc2();
    await start(
      [
        { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
        { id: 'w2', ip: '10.0.0.2', role: 'ghosthands', ec2InstanceId: 'i-2' },
      ],
      { idleTimeoutMs: 1000, minRunning: 0, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    for (const s of states) {
      s.lastActiveAt = Date.now() - 5000;
      s.ec2State = 'running';
      s.activeJobs = 0;
    }

    ec2Calls = [];
    await evaluateIdleWorkers();

    const stopCalls = ec2Calls.filter((c) => c.commandType === 'StopInstancesCommand');
    expect(stopCalls).toHaveLength(2);
  });

  it('12: stops longest-idle first', async () => {
    mockEc2();
    await start(
      [
        { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
        { id: 'w2', ip: '10.0.0.2', role: 'ghosthands', ec2InstanceId: 'i-2' },
      ],
      { idleTimeoutMs: 1000, minRunning: 1, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    states[0].lastActiveAt = Date.now() - 10_000; // idle 10s
    states[0].ec2State = 'running';
    states[0].activeJobs = 0;
    states[1].lastActiveAt = Date.now() - 3_000; // idle 3s
    states[1].ec2State = 'running';
    states[1].activeJobs = 0;

    ec2Calls = [];
    await evaluateIdleWorkers();

    // Only 1 stop (minRunning=1), and it should be w1 (longest idle)
    const stopCalls = ec2Calls.filter((c) => c.commandType === 'StopInstancesCommand');
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0].input.InstanceIds).toEqual(['i-1']);
  });

  it('13: does not stop transitioning worker', async () => {
    mockEc2();
    await start(
      [{ id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' }],
      { idleTimeoutMs: 1000, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    states[0].lastActiveAt = Date.now() - 5000;
    states[0].ec2State = 'running';
    states[0].activeJobs = 0;
    states[0].transitioning = true;

    ec2Calls = [];
    await evaluateIdleWorkers();

    expect(ec2Calls.filter((c) => c.commandType === 'StopInstancesCommand')).toHaveLength(0);
  });

  it('14: handles EC2 stop failure gracefully', async () => {
    mockEc2({ stopError: true });
    await start(
      [{ id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' }],
      { idleTimeoutMs: 1000, pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    states[0].lastActiveAt = Date.now() - 5000;
    states[0].ec2State = 'running';
    states[0].activeJobs = 0;

    ec2Calls = [];
    // Should not throw
    await evaluateIdleWorkers();

    // transitioning should be cleared after failure
    expect(states[0].transitioning).toBe(false);
    // ec2State should NOT be changed to 'stopping' on failure
    expect(states[0].ec2State as string).toBe('running');
  });
});

// ── markActive / markTransitioning ───────────────────────────────────

describe('markActive', () => {
  it('15: resets lastActiveAt', async () => {
    mockEc2();
    await initWorkerStates([
      { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
    ]);

    const states = getWorkerStates();
    states[0].lastActiveAt = 1000;

    markActive('w1');

    expect(states[0].lastActiveAt).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('markTransitioning', () => {
  it('16: sets flag', async () => {
    mockEc2();
    await initWorkerStates([
      { id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' },
    ]);

    markTransitioning('w1', true);
    expect(getWorkerStates()[0].transitioning).toBe(true);

    markTransitioning('w1', false);
    expect(getWorkerStates()[0].transitioning).toBe(false);
  });
});

// ── start / stop lifecycle ───────────────────────────────────────────

describe('start', () => {
  it('17: initializes state from fleet + resolves instance IDs', async () => {
    // Mock EC2 to resolve IPs to instance IDs
    mockEc2();
    await start(
      [
        { id: 'w1', ip: '10.0.0.1', role: 'ghosthands' }, // no ec2InstanceId → needs resolution
        { id: 'w2', ip: '10.0.0.2', role: 'ghosthands', ec2InstanceId: 'i-preset' },
      ],
      { pollIntervalMs: 999_999_999 },
    );

    const states = getWorkerStates();
    expect(states).toHaveLength(2);

    const w1 = states.find((s) => s.serverId === 'w1')!;
    expect(w1.instanceId).toBe('i-resolved-0'); // From mock describeInstancesByIps
    expect(w1.ec2State as string).toBe('running');

    const w2 = states.find((s) => s.serverId === 'w2')!;
    expect(w2.instanceId).toBe('i-preset');
  });
});

describe('stop', () => {
  it('18: clears interval', async () => {
    mockEc2();
    await start(
      [{ id: 'w1', ip: '10.0.0.1', role: 'ghosthands', ec2InstanceId: 'i-1' }],
      { pollIntervalMs: 100 },
    );

    // Stop should not throw
    stop();

    // Calling stop again is a no-op
    stop();
  });
});
