#!/usr/bin/env bun

import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  resolveStackVerifyTargets,
  type StackVerifyEnvironment,
  type StackVerifyMode,
  type StackVerifyTarget,
} from './stack-verify-lib';

interface VerifyArgs {
  environment: StackVerifyEnvironment;
  mode: StackVerifyMode;
  wait: boolean;
  jsonOut?: string;
}

interface WorkflowRunRecord {
  databaseId: number;
  status: string;
  conclusion?: string | null;
  createdAt: string;
  updatedAt?: string;
  url?: string;
}

interface DispatchResult {
  target: StackVerifyTarget;
  runId?: number;
  status: 'dispatched' | 'success' | 'failed' | 'timeout';
  conclusion?: string | null;
  url?: string;
  message: string;
}

function parseArgs(): VerifyArgs {
  const args = process.argv.slice(2);
  const result: VerifyArgs = {
    environment: 'production',
    mode: 'ci',
    wait: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--environment') {
      result.environment = (args[i + 1] as StackVerifyEnvironment | undefined) || result.environment;
      i += 1;
      continue;
    }
    if (arg.startsWith('--environment=')) {
      result.environment = arg.slice('--environment='.length) as StackVerifyEnvironment;
      continue;
    }
    if (arg === '--mode') {
      result.mode = (args[i + 1] as StackVerifyMode | undefined) || result.mode;
      i += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      result.mode = arg.slice('--mode='.length) as StackVerifyMode;
      continue;
    }
    if (arg === '--wait') {
      result.wait = (args[i + 1] || 'true') !== 'false';
      i += 1;
      continue;
    }
    if (arg.startsWith('--wait=')) {
      result.wait = arg.slice('--wait='.length) !== 'false';
      continue;
    }
    if (arg === '--json-out') {
      result.jsonOut = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--json-out=')) {
      result.jsonOut = arg.slice('--json-out='.length);
    }
  }

  if (!['staging', 'production', 'all'].includes(result.environment)) {
    throw new Error(`Unsupported environment "${result.environment}"`);
  }
  if (!['ci', 'deploy', 'full'].includes(result.mode)) {
    throw new Error(`Unsupported mode "${result.mode}"`);
  }

  return result;
}

function runCommand(command: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
      },
    }).trim();
  } catch (error: any) {
    if (allowFailure) {
      return '';
    }
    const stderr = error?.stderr?.toString?.().trim?.() || error?.message || 'Unknown command failure';
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr}`);
  }
}

function runJson<T>(command: string, args: string[], allowFailure = false): T | null {
  const output = runCommand(command, args, allowFailure);
  if (!output) return null;
  return JSON.parse(output) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(): string {
  return new Date().toISOString();
}

function dispatchWorkflow(target: StackVerifyTarget): void {
  const args = [
    'workflow',
    'run',
    target.workflowFile,
    '--repo',
    target.repo,
    '--ref',
    target.ref,
  ];

  for (const [key, value] of Object.entries(target.inputs || {})) {
    args.push('-f', `${key}=${value}`);
  }

  runCommand('gh', args);
}

async function waitForRun(target: StackVerifyTarget, dispatchedAt: string): Promise<WorkflowRunRecord> {
  const appearanceDeadline = Date.now() + 90_000;

  while (Date.now() < appearanceDeadline) {
    const runs =
      runJson<WorkflowRunRecord[]>(
        'gh',
        [
          'run',
          'list',
          '--repo',
          target.repo,
          '--workflow',
          target.workflowFile,
          '--branch',
          target.ref,
          '--event',
          'workflow_dispatch',
          '--limit',
          '20',
          '--json',
          'databaseId,status,conclusion,createdAt,updatedAt,url',
        ],
        true,
      ) || [];

    const matched = runs
      .filter((run) => new Date(run.createdAt).getTime() >= new Date(dispatchedAt).getTime() - 15_000)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (matched) {
      return matched;
    }

    await sleep(5000);
  }

  throw new Error(`Timed out waiting for ${target.repo} / ${target.workflowName} to appear.`);
}

async function waitForCompletion(target: StackVerifyTarget, runId: number): Promise<WorkflowRunRecord> {
  const deadline = Date.now() + 60 * 60_000;

  while (Date.now() < deadline) {
    const run = runJson<WorkflowRunRecord>(
      'gh',
      [
        'run',
        'view',
        String(runId),
        '--repo',
        target.repo,
        '--json',
        'databaseId,status,conclusion,createdAt,updatedAt,url',
      ],
    );

    if (!run) {
      throw new Error(`Could not read run ${runId} for ${target.repo}`);
    }

    if (run.status === 'completed') {
      return run;
    }

    await sleep(15_000);
  }

  throw new Error(`Timed out waiting for ${target.repo} / ${target.workflowName} to finish.`);
}

function renderSummary(args: VerifyArgs, results: DispatchResult[]): string {
  const lines = [
    `# Stack Verify`,
    '',
    `- Checked at: ${isoNow()}`,
    `- Environment: ${args.environment}`,
    `- Mode: ${args.mode}`,
    `- Waited: ${args.wait ? 'yes' : 'no'}`,
    '',
    '| Repo | Workflow | Ref | Status | Conclusion | URL |',
    '|------|----------|-----|--------|------------|-----|',
  ];

  for (const result of results) {
    lines.push(
      `| ${result.target.repo} | ${result.target.workflowName} | ${result.target.ref} | ${result.status} | ${
        result.conclusion || '-'
      } | ${result.url || '-'} |`,
    );
  }

  const failures = results.filter((result) => result.status === 'failed' || result.status === 'timeout');
  if (failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const failure of failures) {
      lines.push(`- ${failure.target.repo} / ${failure.target.workflowName}: ${failure.message}`);
    }
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const targets = resolveStackVerifyTargets(args.environment, args.mode);
  const results: DispatchResult[] = [];

  for (const target of targets) {
    const dispatchedAt = isoNow();
    try {
      dispatchWorkflow(target);
      if (!args.wait) {
        results.push({
          target,
          status: 'dispatched',
          message: 'Workflow dispatch submitted.',
        });
        continue;
      }

      const startedRun = await waitForRun(target, dispatchedAt);
      const completedRun = await waitForCompletion(target, startedRun.databaseId);
      const success = completedRun.conclusion === 'success';

      results.push({
        target,
        runId: startedRun.databaseId,
        status: success ? 'success' : 'failed',
        conclusion: completedRun.conclusion || null,
        url: completedRun.url,
        message: success
          ? 'Workflow completed successfully.'
          : `Workflow completed with ${completedRun.conclusion || 'unknown'}.`,
      });
    } catch (error) {
      results.push({
        target,
        status: error instanceof Error && error.message.includes('Timed out') ? 'timeout' : 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = renderSummary(args, results);
  if (args.jsonOut) {
    writeFileSync(
      args.jsonOut,
      `${JSON.stringify({ checkedAt: isoNow(), ...args, results }, null, 2)}\n`,
      'utf8',
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8');
  }
  process.stdout.write(`${summary}\n`);

  if (results.some((result) => result.status === 'failed' || result.status === 'timeout')) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[stack-verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
