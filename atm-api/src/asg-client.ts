/**
 * ASG Client Module
 *
 * Thin wrapper around @aws-sdk/client-auto-scaling with injectable send for testing.
 * Follows the same DI pattern as ec2-client.ts.
 *
 * @module atm-api/src/asg-client
 */

import {
  AutoScalingClient,
  DescribeAutoScalingInstancesCommand,
  EnterStandbyCommand,
  ExitStandbyCommand,
  type DescribeAutoScalingInstancesCommandOutput,
} from '@aws-sdk/client-auto-scaling';

// ── Dependency injection ─────────────────────────────────────────────

type AsgSendFn = (command: unknown) => Promise<unknown>;

let _asgSendImpl: AsgSendFn | null = null;

const defaultClient = new AutoScalingClient({ region: process.env.AWS_REGION || 'us-east-1' });

function getSend(): AsgSendFn {
  if (_asgSendImpl) return _asgSendImpl;
  return (command: unknown) => defaultClient.send(command as any);
}

/** Override the ASG send function (for testing). Pass null to reset. */
export function setAsgSendImpl(impl: AsgSendFn | null): void {
  _asgSendImpl = impl;
}

// ── Types ────────────────────────────────────────────────────────────

export interface AsgInstanceInfo {
  autoScalingGroupName: string | null;
  lifecycleState: string | null;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Describe an instance's ASG membership. Returns null fields if not ASG-managed.
 */
export async function describeAsgInstance(instanceId: string): Promise<AsgInstanceInfo> {
  const command = new DescribeAutoScalingInstancesCommand({ InstanceIds: [instanceId] });
  const result = (await getSend()(command)) as DescribeAutoScalingInstancesCommandOutput;
  const instance = result.AutoScalingInstances?.[0];
  if (!instance) {
    return { autoScalingGroupName: null, lifecycleState: null };
  }
  return {
    autoScalingGroupName: instance.AutoScalingGroupName ?? null,
    lifecycleState: instance.LifecycleState ?? null,
  };
}

/**
 * Put an instance into Standby in its ASG (decrements DesiredCapacity).
 */
export async function enterStandby(instanceId: string, asgName: string): Promise<void> {
  const command = new EnterStandbyCommand({
    InstanceIds: [instanceId],
    AutoScalingGroupName: asgName,
    ShouldDecrementDesiredCapacity: true,
  });
  await getSend()(command);
  console.log(`[asg-client] EnterStandby ${instanceId} in ${asgName}`);
}

/**
 * Remove an instance from Standby in its ASG (increments DesiredCapacity).
 */
export async function exitStandby(instanceId: string, asgName: string): Promise<void> {
  const command = new ExitStandbyCommand({
    InstanceIds: [instanceId],
    AutoScalingGroupName: asgName,
  });
  await getSend()(command);
  console.log(`[asg-client] ExitStandby ${instanceId} in ${asgName}`);
}
