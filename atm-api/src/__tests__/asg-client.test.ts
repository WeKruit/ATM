import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  describeAsgInstance,
  enterStandby,
  exitStandby,
  setAsgSendImpl,
} from '../asg-client';

let calls: { commandType: string; input: any }[];

function mockSend(response: unknown) {
  return (command: unknown) => {
    const name = (command as any).constructor?.name ?? 'Unknown';
    const input = (command as any).input;
    calls.push({ commandType: name, input });
    return Promise.resolve(response);
  };
}

function mockSendThatThrows(error: Error) {
  return (command: unknown) => {
    const name = (command as any).constructor?.name ?? 'Unknown';
    const input = (command as any).input;
    calls.push({ commandType: name, input });
    return Promise.reject(error);
  };
}

describe('asg-client', () => {
  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    setAsgSendImpl(null);
  });

  // ── describeAsgInstance ────────────────────────────────────────────

  it('1: returns ASG info for managed instance', async () => {
    setAsgSendImpl(mockSend({
      AutoScalingInstances: [{
        InstanceId: 'i-abc123',
        AutoScalingGroupName: 'ghosthands-worker-asg',
        LifecycleState: 'InService',
      }],
    }));

    const info = await describeAsgInstance('i-abc123');

    expect(info).toEqual({
      autoScalingGroupName: 'ghosthands-worker-asg',
      lifecycleState: 'InService',
    });
    expect(calls[0].commandType).toBe('DescribeAutoScalingInstancesCommand');
    expect(calls[0].input.InstanceIds).toEqual(['i-abc123']);
  });

  it('2: returns null fields for non-ASG instance', async () => {
    setAsgSendImpl(mockSend({
      AutoScalingInstances: [],
    }));

    const info = await describeAsgInstance('i-standalone');

    expect(info).toEqual({
      autoScalingGroupName: null,
      lifecycleState: null,
    });
  });

  it('3: returns Standby lifecycle state', async () => {
    setAsgSendImpl(mockSend({
      AutoScalingInstances: [{
        InstanceId: 'i-standby1',
        AutoScalingGroupName: 'ghosthands-worker-asg',
        LifecycleState: 'Standby',
      }],
    }));

    const info = await describeAsgInstance('i-standby1');

    expect(info.lifecycleState).toBe('Standby');
  });

  it('4: throws on AWS error', async () => {
    setAsgSendImpl(mockSendThatThrows(new Error('AccessDenied')));

    await expect(describeAsgInstance('i-bad')).rejects.toThrow('AccessDenied');
  });

  // ── enterStandby ──────────────────────────────────────────────────

  it('5: sends correct EnterStandbyCommand', async () => {
    setAsgSendImpl(mockSend({}));

    await enterStandby('i-abc123', 'ghosthands-worker-asg');

    expect(calls).toHaveLength(1);
    expect(calls[0].commandType).toBe('EnterStandbyCommand');
    expect(calls[0].input.InstanceIds).toEqual(['i-abc123']);
    expect(calls[0].input.AutoScalingGroupName).toBe('ghosthands-worker-asg');
    expect(calls[0].input.ShouldDecrementDesiredCapacity).toBe(true);
  });

  it('6: enterStandby throws on AWS error', async () => {
    setAsgSendImpl(mockSendThatThrows(new Error('ValidationError')));

    await expect(enterStandby('i-bad', 'bad-asg')).rejects.toThrow('ValidationError');
  });

  // ── exitStandby ───────────────────────────────────────────────────

  it('7: sends correct ExitStandbyCommand', async () => {
    setAsgSendImpl(mockSend({}));

    await exitStandby('i-abc123', 'ghosthands-worker-asg');

    expect(calls).toHaveLength(1);
    expect(calls[0].commandType).toBe('ExitStandbyCommand');
    expect(calls[0].input.InstanceIds).toEqual(['i-abc123']);
    expect(calls[0].input.AutoScalingGroupName).toBe('ghosthands-worker-asg');
  });

  it('8: exitStandby throws on AWS error', async () => {
    setAsgSendImpl(mockSendThatThrows(new Error('ResourceContention')));

    await expect(exitStandby('i-bad', 'bad-asg')).rejects.toThrow('ResourceContention');
  });
});
