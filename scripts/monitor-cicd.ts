#!/usr/bin/env bun

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  SECRET_SCOPE_RULES,
  compareFingerprints,
  evaluateSecretScope,
  evaluateWorkflowExistence,
  fingerprintSecretValue,
  getWorkflowPoliciesForEnvironment,
  mergeLevels,
  selectLatestMeaningfulRun,
  type IssueLevel,
  type MonitorEnvironment,
  type WorkflowPolicy,
  type WorkflowRunSummary,
  buildWorkflowMetadataApiPath,
  buildWorkflowRunsApiPath,
} from "./monitor-cicd-lib";
import { fetchSecretsForPath } from "../atm-api/src/infisical-client";

type MonitorEnvironmentInput = MonitorEnvironment | "all";

export interface WorkflowRecord {
  environment: MonitorEnvironment;
  repo: string;
  workflow: string;
  branch: string;
  level: IssueLevel;
  status: string;
  message: string;
  ageMinutes: number | null;
  url: string | null;
  updatedAt: string | null;
  workflowRef?: string;
  monitorMode?: "latest-run" | "existence-only" | "disabled";
  severity?: "blocker" | "warning";
}

export interface InfrastructureRecord {
  environment: MonitorEnvironment;
  name: string;
  level: IssueLevel;
  status: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SecretRecord {
  environment: MonitorEnvironment;
  target: string;
  level: IssueLevel;
  status: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IssueRecord {
  environment: MonitorEnvironment;
  category: "workflow" | "infrastructure" | "secrets";
  target: string;
  message: string;
}

export interface MonitorReport {
  checkedAt: string;
  environment: MonitorEnvironmentInput;
  overallStatus: IssueLevel;
  workflows: WorkflowRecord[];
  infrastructure: InfrastructureRecord[];
  secrets: SecretRecord[];
  blockers: IssueRecord[];
  warnings: IssueRecord[];
}

interface RunCommandOptions {
  allowFailure?: boolean;
  env?: Record<string, string | undefined>;
}

type WorkflowRunsLoader = (policy: WorkflowPolicy) => Promise<WorkflowRunSummary[]>;
type WorkflowExistsLoader = (policy: WorkflowPolicy) => Promise<boolean>;
type InfrastructureCollector = (
  environment: MonitorEnvironment,
  blockers: IssueRecord[],
  warnings: IssueRecord[],
) => Promise<InfrastructureRecord[]>;
type SecretCollector = (
  environment: MonitorEnvironment,
  blockers: IssueRecord[],
  warnings: IssueRecord[],
) => Promise<SecretRecord[]>;

export interface MonitorDependencies {
  now?: Date;
  listWorkflowRuns?: WorkflowRunsLoader;
  getWorkflowExists?: WorkflowExistsLoader;
  collectInfrastructureRecords?: InfrastructureCollector;
  collectSecretRecords?: SecretCollector;
}

const DEFAULT_ATM_API_URL =
  process.env.ATM_MONITOR_ATM_API_URL || "http://atm-direct.wekruit.com:8080";
const DEFAULT_ATM_INSTANCE_NAME =
  process.env.ATM_MONITOR_ATM_INSTANCE_NAME || "wekruit-atm-server";
const DEFAULT_EC2_ENV_FILE = process.env.ATM_MONITOR_EC2_ENV_FILE || "/opt/atm/.env";
const DEFAULT_EC2_USER = process.env.ATM_MONITOR_EC2_USER || "ubuntu";
const DEFAULT_STALE_MINUTES = Number(process.env.ATM_MONITOR_MAX_RUN_AGE_MINUTES || "20");
const DEFAULT_GH_RUN_LIMIT = Number(process.env.ATM_MONITOR_RUN_LIMIT || "20");

function parseArgs(): {
  environment: MonitorEnvironmentInput;
  jsonOut?: string;
  summaryOut?: string;
} {
  let environment: MonitorEnvironmentInput = "all";
  let jsonOut: string | undefined;
  let summaryOut: string | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--environment") {
      environment = (args[i + 1] as MonitorEnvironmentInput | undefined) || "all";
      i += 1;
      continue;
    }
    if (arg.startsWith("--environment=")) {
      environment = arg.slice("--environment=".length) as MonitorEnvironmentInput;
      continue;
    }
    if (arg === "--json-out") {
      jsonOut = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--json-out=")) {
      jsonOut = arg.slice("--json-out=".length);
      continue;
    }
    if (arg === "--summary-out") {
      summaryOut = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--summary-out=")) {
      summaryOut = arg.slice("--summary-out=".length);
    }
  }

  if (!["staging", "production", "all"].includes(environment)) {
    throw new Error(`Unsupported environment "${environment}". Use staging, production, or all.`);
  }

  return { environment, jsonOut, summaryOut };
}

function runCommand(command: string, args: string[], options: RunCommandOptions = {}): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...options.env,
      },
    }).trim();
  } catch (error: any) {
    if (options.allowFailure) {
      return "";
    }
    const stderr =
      error?.stderr?.toString?.().trim?.() || error?.message || "Unknown command failure";
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
  }
}

function runJson<T>(command: string, args: string[], options: RunCommandOptions = {}): T | null {
  const output = runCommand(command, args, {
    ...options,
    allowFailure: options.allowFailure ?? false,
  });
  if (!output) return null;
  return JSON.parse(output) as T;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function githubEnv(): Record<string, string | undefined> {
  return { GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN };
}

function environmentList(environment: MonitorEnvironmentInput): MonitorEnvironment[] {
  return environment === "all" ? ["staging", "production"] : [environment];
}

function pushIssue(collection: IssueRecord[], level: IssueLevel, issue: IssueRecord) {
  if (level === "ok" || level === "skip") return;
  collection.push(issue);
}

function normalizeWorkflowRun(raw: Record<string, unknown>): WorkflowRunSummary {
  return {
    workflowName:
      typeof raw.name === "string"
        ? raw.name
        : typeof raw.workflowName === "string"
          ? raw.workflowName
          : undefined,
    displayTitle:
      typeof raw.display_title === "string"
        ? raw.display_title
        : typeof raw.displayTitle === "string"
          ? raw.displayTitle
          : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    conclusion:
      typeof raw.conclusion === "string" || raw.conclusion === null
        ? (raw.conclusion as string | null)
        : null,
    createdAt:
      typeof raw.created_at === "string"
        ? raw.created_at
        : typeof raw.createdAt === "string"
          ? raw.createdAt
          : undefined,
    startedAt:
      typeof raw.run_started_at === "string"
        ? raw.run_started_at
        : typeof raw.startedAt === "string"
          ? raw.startedAt
          : undefined,
    updatedAt:
      typeof raw.updated_at === "string"
        ? raw.updated_at
        : typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : undefined,
    url:
      typeof raw.html_url === "string"
        ? raw.html_url
        : typeof raw.url === "string"
          ? raw.url
          : undefined,
  };
}

async function defaultListWorkflowRuns(policy: WorkflowPolicy): Promise<WorkflowRunSummary[]> {
  const payload =
    runJson<{ workflow_runs?: Array<Record<string, unknown>> }>(
      "gh",
      ["api", buildWorkflowRunsApiPath(policy, DEFAULT_GH_RUN_LIMIT)],
      { env: githubEnv() },
    ) || {};

  return Array.isArray(payload.workflow_runs)
    ? payload.workflow_runs.map((run) => normalizeWorkflowRun(run))
    : [];
}

async function defaultGetWorkflowExists(policy: WorkflowPolicy): Promise<boolean> {
  const payload = runJson<Record<string, unknown>>(
    "gh",
    ["api", buildWorkflowMetadataApiPath(policy)],
    {
      allowFailure: true,
      env: githubEnv(),
    },
  );

  return payload !== null;
}

export async function collectWorkflowRecords(
  environment: MonitorEnvironment,
  blockers: IssueRecord[],
  warnings: IssueRecord[],
  deps: Pick<MonitorDependencies, "now" | "listWorkflowRuns" | "getWorkflowExists"> = {},
): Promise<WorkflowRecord[]> {
  const records: WorkflowRecord[] = [];
  const now = deps.now ?? new Date();
  const listWorkflowRuns = deps.listWorkflowRuns ?? defaultListWorkflowRuns;
  const getWorkflowExists = deps.getWorkflowExists ?? defaultGetWorkflowExists;

  for (const policy of getWorkflowPoliciesForEnvironment(environment)) {
    if (policy.monitorMode === "disabled") continue;

    if (policy.monitorMode === "existence-only") {
      const exists = await getWorkflowExists(policy);
      const assessment = evaluateWorkflowExistence(exists, policy.severity);
      const record: WorkflowRecord = {
        environment,
        repo: policy.repo,
        workflow: policy.displayName,
        branch: policy.branch,
        level: assessment.level,
        status: assessment.status,
        message: assessment.message,
        ageMinutes: assessment.ageMinutes,
        url: null,
        updatedAt: null,
        workflowRef: String(policy.workflowRef),
        monitorMode: policy.monitorMode,
        severity: policy.severity,
      };
      records.push(record);
      pushIssue(
        assessment.level === "blocker" ? blockers : warnings,
        assessment.level,
        {
          environment,
          category: "workflow",
          target: `${policy.repo} / ${policy.displayName}`,
          message: assessment.message,
        },
      );
      continue;
    }

    const runs = await listWorkflowRuns(policy);
    const { run, assessment } = selectLatestMeaningfulRun(
      runs,
      now,
      DEFAULT_STALE_MINUTES,
      policy.severity,
    );
    const record: WorkflowRecord = {
      environment,
      repo: policy.repo,
      workflow: policy.displayName,
      branch: policy.branch,
      level: assessment.level,
      status: assessment.status,
      message: assessment.message,
      ageMinutes: assessment.ageMinutes,
      url: run?.url || null,
      updatedAt: run?.updatedAt || run?.startedAt || run?.createdAt || null,
      workflowRef: String(policy.workflowRef),
      monitorMode: policy.monitorMode,
      severity: policy.severity,
    };
    records.push(record);

    pushIssue(
      assessment.level === "blocker" ? blockers : warnings,
      assessment.level,
      {
        environment,
        category: "workflow",
        target: `${policy.repo} / ${policy.displayName}`,
        message: assessment.message,
      },
    );
  }

  return records;
}

function awsRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
}

function collectInstanceState(): Record<string, unknown> | null {
  return runJson<{ Reservations: Array<{ Instances: Array<Record<string, unknown>> }> }>(
    "aws",
    [
      "ec2",
      "describe-instances",
      "--filters",
      `Name=tag:Name,Values=${DEFAULT_ATM_INSTANCE_NAME}`,
      "Name=instance-state-name,Values=pending,running,stopping,stopped",
      "--output",
      "json",
    ],
    {
      allowFailure: true,
      env: {
        AWS_REGION: awsRegion(),
        AWS_DEFAULT_REGION: awsRegion(),
      },
    },
  ) as Record<string, unknown> | null;
}

function flattenInstances(payload: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!payload) return [];
  const reservations = Array.isArray((payload as any).Reservations)
    ? (payload as any).Reservations
    : [];
  return reservations.flatMap((reservation: any) =>
    Array.isArray(reservation.Instances) ? reservation.Instances : [],
  );
}

async function collectInfrastructureRecords(
  environment: MonitorEnvironment,
  blockers: IssueRecord[],
  warnings: IssueRecord[],
): Promise<InfrastructureRecord[]> {
  const records: InfrastructureRecord[] = [];

  const instancePayload = collectInstanceState();
  const instances = flattenInstances(instancePayload);
  const atmInstance = instances[0] || null;
  const instanceState = String(atmInstance?.State?.Name || "");

  if (!atmInstance) {
    const message = `AWS could not find EC2 instance "${DEFAULT_ATM_INSTANCE_NAME}".`;
    records.push({
      environment,
      name: "ATM EC2",
      level: "blocker",
      status: "missing",
      message,
    });
    blockers.push({ environment, category: "infrastructure", target: "ATM EC2", message });
  } else if (instanceState !== "running") {
    const message = `ATM EC2 instance is ${instanceState}, expected running.`;
    records.push({
      environment,
      name: "ATM EC2",
      level: "blocker",
      status: instanceState || "unknown",
      message,
      details: {
        instanceId: atmInstance.InstanceId,
        publicIp: atmInstance.PublicIpAddress ?? null,
      },
    });
    blockers.push({ environment, category: "infrastructure", target: "ATM EC2", message });
  } else {
    records.push({
      environment,
      name: "ATM EC2",
      level: "ok",
      status: "running",
      message: "ATM EC2 instance is running.",
      details: {
        instanceId: atmInstance.InstanceId,
        publicIp: atmInstance.PublicIpAddress ?? null,
      },
    });
  }

  const atmHealth = await fetchJson(`${DEFAULT_ATM_API_URL}/health`);
  if (!atmHealth) {
    const message = `ATM /health is unreachable at ${DEFAULT_ATM_API_URL}.`;
    records.push({
      environment,
      name: "ATM /health",
      level: "blocker",
      status: "unreachable",
      message,
    });
    blockers.push({ environment, category: "infrastructure", target: "ATM /health", message });
    return records;
  }

  const status = String(atmHealth.status || "unknown");
  const workerStatus = String(atmHealth.workerStatus || "unknown");
  const apiHealthy = Boolean(atmHealth.apiHealthy);

  if (status === "idle" && workerStatus === "all-stopped") {
    records.push({
      environment,
      name: "ATM /health",
      level: "ok",
      status: "healthy-idle",
      message: "ATM is reachable and GhostHands workers are intentionally stopped.",
      details: atmHealth,
    });
  } else if (status === "ok" && apiHealthy) {
    records.push({
      environment,
      name: "ATM /health",
      level: "ok",
      status: "healthy",
      message: "ATM is reachable and has healthy GhostHands probes.",
      details: atmHealth,
    });
  } else {
    const message = `ATM health is ${status} (workerStatus=${workerStatus}, apiHealthy=${apiHealthy}).`;
    records.push({
      environment,
      name: "ATM /health",
      level: "blocker",
      status,
      message,
      details: atmHealth,
    });
    blockers.push({ environment, category: "infrastructure", target: "ATM /health", message });
  }

  return records;
}

function listEnvironmentSecrets(
  repo: string,
  environment: MonitorEnvironment,
): { exists: boolean; names: string[] } {
  const response = runCommand("gh", ["api", `repos/${repo}/environments/${environment}/secrets`], {
    allowFailure: true,
    env: githubEnv(),
  });

  if (!response) {
    return { exists: false, names: [] };
  }

  const payload = JSON.parse(response) as { secrets?: Array<{ name: string }> };
  return {
    exists: true,
    names: Array.isArray(payload.secrets)
      ? payload.secrets.map((secret) => secret.name)
      : [],
  };
}

function listRepoSecrets(repo: string): string[] {
  const payload =
    runJson<{ secrets?: Array<{ name: string }> }>("gh", ["api", `repos/${repo}/actions/secrets`], {
      env: githubEnv(),
    }) || {};

  return Array.isArray(payload.secrets) ? payload.secrets.map((secret) => secret.name) : [];
}

function readAwsSecret(secretId: string): Record<string, string> | null {
  const secretString = runCommand(
    "aws",
    [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      secretId,
      "--query",
      "SecretString",
      "--output",
      "text",
    ],
    {
      allowFailure: true,
      env: {
        AWS_REGION: awsRegion(),
        AWS_DEFAULT_REGION: awsRegion(),
      },
    },
  );

  if (!secretString) return null;
  return JSON.parse(secretString) as Record<string, string>;
}

function readEc2EnvValue(key: string): string | null {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`readEc2EnvValue: invalid key "${key}" — must match [A-Z_][A-Z0-9_]*`);
  }

  const host = process.env.ATM_MONITOR_EC2_HOST;
  const keyPath = process.env.ATM_MONITOR_EC2_KEY_PATH;
  if (!host || !keyPath || !existsSync(keyPath)) {
    return null;
  }

  const output = runCommand(
    "ssh",
    [
      "-i",
      keyPath,
      "-o",
      "StrictHostKeyChecking=no",
      `${DEFAULT_EC2_USER}@${host}`,
      `grep '^${key}=' ${DEFAULT_EC2_ENV_FILE} | cut -d= -f2-`,
    ],
    { allowFailure: true },
  );

  return output || null;
}

async function collectSecretRecords(
  environment: MonitorEnvironment,
  blockers: IssueRecord[],
  warnings: IssueRecord[],
): Promise<SecretRecord[]> {
  const records: SecretRecord[] = [];

  for (const rule of SECRET_SCOPE_RULES) {
    const envSecrets = listEnvironmentSecrets(rule.repo, environment);
    const repoSecrets = listRepoSecrets(rule.repo);
    const assessment = evaluateSecretScope({
      environmentExists: envSecrets.exists,
      environmentName: environment,
      repo: rule.repo,
      environmentSecrets: envSecrets.names,
      repoSecrets,
      requiredEnvSecrets: rule.requiredEnvSecrets,
    });

    records.push({
      environment,
      target: `${rule.repo} environment scope`,
      level: assessment.level,
      status: assessment.level === "ok" ? "scoped" : "drifted",
      message: assessment.message,
      details: {
        missingEnvSecrets: assessment.missingEnvSecrets,
        repoFallbackSecrets: assessment.repoFallbackSecrets,
      },
    });

    pushIssue(
      assessment.level === "blocker" ? blockers : warnings,
      assessment.level,
      {
        environment,
        category: "secrets",
        target: `${rule.repo} environment scope`,
        message: assessment.message,
      },
    );
  }

  let infisicalSecrets: Record<string, string> | null = null;
  try {
    infisicalSecrets = await fetchSecretsForPath("/atm", environment);
  } catch (error) {
    const message = `Infisical /atm secret fetch failed for ${environment}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    records.push({
      environment,
      target: "Infisical /atm",
      level: "blocker",
      status: "unreachable",
      message,
    });
    blockers.push({ environment, category: "secrets", target: "Infisical /atm", message });
  }

  const awsSecrets = readAwsSecret(`ghosthands/${environment}`);
  const runtimeAtmSecret = readEc2EnvValue("ATM_DEPLOY_SECRET");
  const runtimeGhSecret = readEc2EnvValue("GH_DEPLOY_SECRET");

  const fingerprintAssessment = compareFingerprints("Infisical /atm ATM_DEPLOY_SECRET", [
    {
      label: "Infisical /atm ATM_DEPLOY_SECRET",
      value: infisicalSecrets?.ATM_DEPLOY_SECRET || null,
    },
    {
      label: `AWS ghosthands/${environment} ATM_DEPLOY_SECRET`,
      value: awsSecrets?.ATM_DEPLOY_SECRET || null,
    },
    {
      label: "ATM EC2 ATM_DEPLOY_SECRET",
      value: runtimeAtmSecret,
    },
  ]);

  const parityDetails: Record<string, unknown> = {
    canonicalFingerprint: fingerprintAssessment.canonicalFingerprint,
    entries: fingerprintAssessment.entries,
  };

  if (awsSecrets?.GH_DEPLOY_SECRET) {
    parityDetails.awsGhosthandsGhFingerprint = fingerprintSecretValue(awsSecrets.GH_DEPLOY_SECRET);
  }
  if (runtimeGhSecret) {
    parityDetails.runtimeGhFingerprint = fingerprintSecretValue(runtimeGhSecret);
  }

  records.push({
    environment,
    target: "Deploy secret parity",
    level: fingerprintAssessment.level,
    status: fingerprintAssessment.status,
    message: fingerprintAssessment.message,
    details: parityDetails,
  });

  pushIssue(
    fingerprintAssessment.level === "blocker" ? blockers : warnings,
    fingerprintAssessment.level,
    {
      environment,
      category: "secrets",
      target: "Deploy secret parity",
      message: fingerprintAssessment.message,
    },
  );

  if (
    awsSecrets?.ATM_DEPLOY_SECRET &&
    awsSecrets?.GH_DEPLOY_SECRET &&
    awsSecrets.ATM_DEPLOY_SECRET !== awsSecrets.GH_DEPLOY_SECRET
  ) {
    const message = `AWS ghosthands/${environment} has different ATM_DEPLOY_SECRET and GH_DEPLOY_SECRET values.`;
    records.push({
      environment,
      target: `AWS ghosthands/${environment}`,
      level: "blocker",
      status: "drifted",
      message,
      details: {
        atmFingerprint: fingerprintSecretValue(awsSecrets.ATM_DEPLOY_SECRET),
        ghFingerprint: fingerprintSecretValue(awsSecrets.GH_DEPLOY_SECRET),
      },
    });
    blockers.push({ environment, category: "secrets", target: `AWS ghosthands/${environment}`, message });
  }

  if (runtimeAtmSecret && runtimeGhSecret && runtimeAtmSecret !== runtimeGhSecret) {
    const message = "ATM EC2 runtime ATM_DEPLOY_SECRET and GH_DEPLOY_SECRET differ.";
    records.push({
      environment,
      target: "ATM EC2 runtime deploy secrets",
      level: "blocker",
      status: "drifted",
      message,
      details: {
        atmFingerprint: fingerprintSecretValue(runtimeAtmSecret),
        ghFingerprint: fingerprintSecretValue(runtimeGhSecret),
      },
    });
    blockers.push({
      environment,
      category: "secrets",
      target: "ATM EC2 runtime deploy secrets",
      message,
    });
  }

  return records;
}

function renderSummary(report: MonitorReport): string {
  const lines: string[] = [];
  lines.push("## Cross-System CI/CD Monitor");
  lines.push("");
  lines.push(`- Checked at: ${report.checkedAt}`);
  lines.push(`- Environment: ${report.environment}`);
  lines.push(`- Overall status: ${report.overallStatus}`);
  lines.push("");

  for (const environment of environmentList(report.environment)) {
    lines.push(`### ${environment}`);
    lines.push("");

    const environmentBlockers = report.blockers.filter((issue) => issue.environment === environment);
    const environmentWarnings = report.warnings.filter((issue) => issue.environment === environment);

    if (environmentBlockers.length === 0) {
      lines.push("- Blockers: none");
    } else {
      for (const issue of environmentBlockers) {
        lines.push(`- Blocker: [${issue.category}] ${issue.target} — ${issue.message}`);
      }
    }

    if (environmentWarnings.length === 0) {
      lines.push("- Warnings: none");
    } else {
      for (const issue of environmentWarnings) {
        lines.push(`- Warning: [${issue.category}] ${issue.target} — ${issue.message}`);
      }
    }

    const workflowRows = report.workflows.filter((record) => record.environment === environment);
    lines.push("");
    lines.push("| Workflow | Repo | Status | Updated At | Message |");
    lines.push("|----------|------|--------|------------|---------|");
    for (const row of workflowRows) {
      lines.push(
        `| ${row.workflow} | ${row.repo} | ${row.status} | ${row.updatedAt || "-"} | ${row.message} |`,
      );
    }

    const infraRows = report.infrastructure.filter((record) => record.environment === environment);
    lines.push("");
    lines.push("| Infrastructure | Status | Message |");
    lines.push("|----------------|--------|---------|");
    for (const row of infraRows) {
      lines.push(`| ${row.name} | ${row.status} | ${row.message} |`);
    }

    const secretRows = report.secrets.filter((record) => record.environment === environment);
    lines.push("");
    lines.push("| Secret Check | Status | Message |");
    lines.push("|--------------|--------|---------|");
    for (const row of secretRows) {
      lines.push(`| ${row.target} | ${row.status} | ${row.message} |`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

export async function buildReport(
  environment: MonitorEnvironmentInput,
  deps: MonitorDependencies = {},
): Promise<MonitorReport> {
  const blockers: IssueRecord[] = [];
  const warnings: IssueRecord[] = [];
  const workflows: WorkflowRecord[] = [];
  const infrastructure: InfrastructureRecord[] = [];
  const secrets: SecretRecord[] = [];

  const infrastructureCollector = deps.collectInfrastructureRecords ?? collectInfrastructureRecords;
  const secretCollector = deps.collectSecretRecords ?? collectSecretRecords;

  for (const targetEnvironment of environmentList(environment)) {
    workflows.push(
      ...(await collectWorkflowRecords(targetEnvironment, blockers, warnings, deps)),
    );
    infrastructure.push(
      ...(await infrastructureCollector(targetEnvironment, blockers, warnings)),
    );
    secrets.push(...(await secretCollector(targetEnvironment, blockers, warnings)));
  }

  return {
    checkedAt: (deps.now ?? new Date()).toISOString(),
    environment,
    overallStatus: mergeLevels([
      ...workflows.map((entry) => entry.level),
      ...infrastructure.map((entry) => entry.level),
      ...secrets.map((entry) => entry.level),
    ]),
    workflows,
    infrastructure,
    secrets,
    blockers,
    warnings,
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildReport(args.environment);
  const summary = renderSummary(report);

  if (args.jsonOut) {
    writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (args.summaryOut) {
    writeFileSync(args.summaryOut, `${summary}\n`, "utf8");
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, "utf8");
  }

  process.stdout.write(`${summary}\n`);

  if (report.overallStatus === "blocker") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[monitor-cicd] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
