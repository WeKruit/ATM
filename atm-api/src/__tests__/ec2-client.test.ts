import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  startInstance,
  stopInstance,
  describeInstance,
  describeInstancesByIps,
  setEc2SendImpl,
} from '../ec2-client';
import {
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';

/** Tracks calls to the mock EC2 send function */
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

describe('ec2-client', () => {
  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    setEc2SendImpl(null);
  });

  // ── startInstance ────────────────────────────────────────────────

  it('1: startInstance sends correct StartInstancesCommand', async () => {
    setEc2SendImpl(
      mockSend({
        StartingInstances: [
          { CurrentState: { Name: 'pending' }, PreviousState: { Name: 'stopped' } },
        ],
      }),
    );

    await startInstance('i-abc123');

    expect(calls).toHaveLength(1);
    expect(calls[0].commandType).toBe('StartInstancesCommand');
    expect(calls[0].input.InstanceIds).toEqual(['i-abc123']);
  });

  it('2: startInstance throws on AWS error', async () => {
    setEc2SendImpl(mockSendThatThrows(new Error('InvalidInstanceID')));

    await expect(startInstance('i-bad')).rejects.toThrow('InvalidInstanceID');
  });

  // ── stopInstance ─────────────────────────────────────────────────

  it('3: stopInstance sends correct StopInstancesCommand', async () => {
    setEc2SendImpl(
      mockSend({
        StoppingInstances: [
          { CurrentState: { Name: 'stopping' }, PreviousState: { Name: 'running' } },
        ],
      }),
    );

    await stopInstance('i-xyz789');

    expect(calls).toHaveLength(1);
    expect(calls[0].commandType).toBe('StopInstancesCommand');
    expect(calls[0].input.InstanceIds).toEqual(['i-xyz789']);
  });

  it('4: stopInstance throws on AWS error', async () => {
    setEc2SendImpl(mockSendThatThrows(new Error('IncorrectInstanceState')));

    await expect(stopInstance('i-bad')).rejects.toThrow('IncorrectInstanceState');
  });

  // ── describeInstance ─────────────────────────────────────────────

  it('5: describeInstance returns state + IP', async () => {
    setEc2SendImpl(
      mockSend({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-abc123',
                State: { Name: 'running' },
                PublicIpAddress: '44.223.180.11',
              },
            ],
          },
        ],
      }),
    );

    const info = await describeInstance('i-abc123');

    expect(info).toEqual({
      instanceId: 'i-abc123',
      state: 'running',
      publicIp: '44.223.180.11',
    });
    expect(calls[0].commandType).toBe('DescribeInstancesCommand');
    expect(calls[0].input.InstanceIds).toEqual(['i-abc123']);
  });

  it('6: describeInstance throws for unknown instance', async () => {
    setEc2SendImpl(mockSend({ Reservations: [] }));

    await expect(describeInstance('i-nonexistent')).rejects.toThrow(
      'EC2 instance not found: i-nonexistent',
    );
  });

  // ── describeInstancesByIps ───────────────────────────────────────

  it('7: describeInstancesByIps resolves multiple IPs', async () => {
    setEc2SendImpl(
      mockSend({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-111',
                State: { Name: 'running' },
                PublicIpAddress: '10.0.0.1',
              },
            ],
          },
          {
            Instances: [
              {
                InstanceId: 'i-222',
                State: { Name: 'stopped' },
                PublicIpAddress: '10.0.0.2',
              },
            ],
          },
        ],
      }),
    );

    const result = await describeInstancesByIps(['10.0.0.1', '10.0.0.2']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ instanceId: 'i-111', state: 'running', publicIp: '10.0.0.1' });
    expect(result[1]).toEqual({ instanceId: 'i-222', state: 'stopped', publicIp: '10.0.0.2' });
    expect(calls[0].input.Filters).toEqual([
      { Name: 'ip-address', Values: ['10.0.0.1', '10.0.0.2'] },
    ]);
  });

  it('8: describeInstancesByIps returns empty for no matches', async () => {
    setEc2SendImpl(mockSend({ Reservations: [] }));

    const result = await describeInstancesByIps(['192.168.1.1']);

    expect(result).toEqual([]);
  });
});
