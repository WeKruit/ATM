/**
 * EC2 Client Module
 *
 * Thin wrapper around @aws-sdk/client-ec2 with injectable send for testing.
 * Follows the same DI pattern as docker-client.ts and pre-deploy-drain.ts.
 *
 * @module atm-api/src/ec2-client
 */

import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
  type StartInstancesCommandOutput,
  type StopInstancesCommandOutput,
  type DescribeInstancesCommandOutput,
} from '@aws-sdk/client-ec2';

// ── Dependency injection ─────────────────────────────────────────────

type Ec2SendFn = (command: unknown) => Promise<unknown>;

let _ec2SendImpl: Ec2SendFn | null = null;

const defaultClient = new EC2Client({ region: process.env.AWS_REGION || 'us-east-1' });

function getSend(): Ec2SendFn {
  if (_ec2SendImpl) return _ec2SendImpl;
  return (command: unknown) => defaultClient.send(command as any);
}

/** Override the EC2 send function (for testing). Pass null to reset. */
export function setEc2SendImpl(impl: Ec2SendFn | null): void {
  _ec2SendImpl = impl;
}

// ── Instance state type ──────────────────────────────────────────────

export interface Ec2InstanceInfo {
  instanceId: string;
  state: 'running' | 'stopped' | 'stopping' | 'pending' | 'shutting-down' | 'terminated' | 'unknown';
  publicIp: string | null;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start an EC2 instance.
 */
export async function startInstance(instanceId: string): Promise<void> {
  const command = new StartInstancesCommand({ InstanceIds: [instanceId] });
  const result = (await getSend()(command)) as StartInstancesCommandOutput;
  const current = result.StartingInstances?.[0]?.CurrentState?.Name;
  console.log(`[ec2-client] StartInstances ${instanceId}: ${current}`);
}

/**
 * Stop an EC2 instance.
 */
export async function stopInstance(instanceId: string): Promise<void> {
  const command = new StopInstancesCommand({ InstanceIds: [instanceId] });
  const result = (await getSend()(command)) as StopInstancesCommandOutput;
  const current = result.StoppingInstances?.[0]?.CurrentState?.Name;
  console.log(`[ec2-client] StopInstances ${instanceId}: ${current}`);
}

/**
 * Describe a single EC2 instance by ID.
 */
export async function describeInstance(instanceId: string): Promise<Ec2InstanceInfo> {
  const command = new DescribeInstancesCommand({ InstanceIds: [instanceId] });
  const result = (await getSend()(command)) as DescribeInstancesCommandOutput;
  const instance = result.Reservations?.[0]?.Instances?.[0];
  if (!instance) {
    throw new Error(`EC2 instance not found: ${instanceId}`);
  }
  return {
    instanceId: instance.InstanceId ?? instanceId,
    state: (instance.State?.Name as Ec2InstanceInfo['state']) ?? 'unknown',
    publicIp: instance.PublicIpAddress ?? null,
  };
}

/**
 * Resolve fleet IPs to instance IDs by filtering on public IP addresses.
 */
export async function describeInstancesByIps(ips: string[]): Promise<Ec2InstanceInfo[]> {
  if (ips.length === 0) return [];

  const command = new DescribeInstancesCommand({
    Filters: [{ Name: 'ip-address', Values: ips }],
  });
  const result = (await getSend()(command)) as DescribeInstancesCommandOutput;

  const instances: Ec2InstanceInfo[] = [];
  for (const reservation of result.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      instances.push({
        instanceId: instance.InstanceId ?? '',
        state: (instance.State?.Name as Ec2InstanceInfo['state']) ?? 'unknown',
        publicIp: instance.PublicIpAddress ?? null,
      });
    }
  }
  return instances;
}
