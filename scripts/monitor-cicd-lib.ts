import { createHash } from "node:crypto";

export type MonitorEnvironment = "staging" | "production";
export type IssueLevel = "ok" | "warning" | "blocker" | "skip";
export type WorkflowMonitorMode = "latest-run" | "existence-only" | "disabled";
export type WorkflowSeverity = "blocker" | "warning";

export interface WorkflowRunSummary {
  workflowName?: string;
  displayTitle?: string;
  status?: string;
  conclusion?: string | null;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  url?: string;
}

export interface WorkflowPolicy {
  repo: string;
  workflowRef: string | number;
  displayName: string;
  environments: MonitorEnvironment[];
  branch: string;
  monitorMode: WorkflowMonitorMode;
  severity: WorkflowSeverity;
}

export interface WorkflowAssessment {
  level: IssueLevel;
  status: "healthy" | "running" | "stale" | "failed" | "unknown" | "cancelled" | "configured";
  message: string;
  ageMinutes: number | null;
}

export interface SecretScopeAssessment {
  level: IssueLevel;
  message: string;
  missingEnvSecrets: string[];
  repoFallbackSecrets: string[];
}

export interface FingerprintEntry {
  label: string;
  value?: string | null;
}

export interface FingerprintAssessment {
  level: IssueLevel;
  status: "synced" | "drifted" | "missing";
  canonicalFingerprint: string | null;
  entries: Array<{ label: string; fingerprint: string | null }>;
  mismatches: string[];
  missing: string[];
  message: string;
}

export interface SecretScopeRule {
  repo: string;
  requiredEnvSecrets: string[];
}

export const WORKFLOW_POLICIES: WorkflowPolicy[] = [
  {
    repo: "WeKruit/ATM",
    workflowRef: "ci-atm.yml",
    displayName: "CI — ATM",
    environments: ["staging"],
    branch: "staging",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/ATM",
    workflowRef: "integration-test.yml",
    displayName: "Integration Tests",
    environments: ["staging"],
    branch: "staging",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/ATM",
    workflowRef: "ci-atm.yml",
    displayName: "CI — ATM",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/ATM",
    workflowRef: "cd-atm-api.yml",
    displayName: "CD → ATM API (EC2)",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "blocker",
  },
  {
    repo: "WeKruit/ATM",
    workflowRef: "cd-atm-dashboard.yml",
    displayName: "CD → ATM Dashboard (Fly.io)",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "blocker",
  },
  {
    repo: "WeKruit/VALET",
    workflowRef: "ci.yml",
    displayName: "CI",
    environments: ["staging"],
    branch: "staging",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/VALET",
    workflowRef: "cd-staging.yml",
    displayName: "CD → Staging",
    environments: ["staging"],
    branch: "staging",
    monitorMode: "latest-run",
    severity: "blocker",
  },
  {
    repo: "WeKruit/VALET",
    workflowRef: "ci-integration.yml",
    displayName: "Integration Tests",
    environments: ["staging"],
    branch: "staging",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/VALET",
    workflowRef: "ci.yml",
    displayName: "CI",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/VALET",
    workflowRef: "cd-prod.yml",
    displayName: "CD → Production",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "blocker",
  },
  {
    repo: "WeKruit/VALET",
    workflowRef: "ci-integration.yml",
    displayName: "Integration Tests",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/GH-Desktop-App",
    workflowRef: "ci.yml",
    displayName: "CI/CD",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/GHOST-HANDS",
    workflowRef: "ci.yml",
    displayName: "CI/CD",
    environments: ["staging"],
    branch: "staging",
    monitorMode: "latest-run",
    severity: "warning",
  },
  {
    repo: "WeKruit/GHOST-HANDS",
    workflowRef: "publish-engine.yml",
    displayName: "Publish Engine",
    environments: ["staging"],
    branch: "staging",
    monitorMode: "latest-run",
    severity: "blocker",
  },
  {
    repo: "WeKruit/GHOST-HANDS",
    workflowRef: "rollback.yml",
    displayName: "Rollback",
    environments: ["staging", "production"],
    branch: "main",
    monitorMode: "existence-only",
    severity: "warning",
  },
  {
    repo: "WeKruit/GHOST-HANDS",
    workflowRef: "ci.yml",
    displayName: "CI/CD",
    environments: ["production"],
    branch: "main",
    monitorMode: "latest-run",
    severity: "warning",
  },
];

export const SECRET_SCOPE_RULES: SecretScopeRule[] = [
  {
    repo: "WeKruit/ATM",
    requiredEnvSecrets: [
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_PROJECT_ID",
    ],
  },
  {
    repo: "WeKruit/VALET",
    requiredEnvSecrets: ["ATM_BASE_URL", "ATM_DEPLOY_SECRET"],
  },
  {
    repo: "WeKruit/GH-Desktop-App",
    requiredEnvSecrets: ["ATM_HOST", "ATM_DEPLOY_SECRET", "GH_DEPLOY_SECRET"],
  },
  {
    repo: "WeKruit/GHOST-HANDS",
    requiredEnvSecrets: ["ATM_DEPLOY_SECRET", "GH_DEPLOY_SECRET"],
  },
];

const RUNNING_STATUSES = new Set(["queued", "requested", "waiting", "pending", "in_progress"]);
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "stale",
  "action_required",
]);
const SKIPPABLE_CONCLUSIONS = new Set(["cancelled"]);

function levelForSeverity(severity: WorkflowSeverity): IssueLevel {
  return severity === "blocker" ? "blocker" : "warning";
}

export function environmentToBranch(environment: MonitorEnvironment): string {
  return environment === "staging" ? "staging" : "main";
}

export function getWorkflowPoliciesForEnvironment(
  environment: MonitorEnvironment,
): WorkflowPolicy[] {
  return WORKFLOW_POLICIES.filter(
    (policy) =>
      policy.monitorMode !== "disabled" && policy.environments.includes(environment),
  );
}

export function findWorkflowPolicy(params: {
  repo: string;
  workflowRef?: string | number;
  displayName?: string;
  environment: MonitorEnvironment;
}): WorkflowPolicy | undefined {
  return getWorkflowPoliciesForEnvironment(params.environment).find((policy) => {
    if (policy.repo !== params.repo) return false;
    if (params.workflowRef !== undefined) {
      return String(policy.workflowRef) === String(params.workflowRef);
    }
    if (params.displayName !== undefined) {
      return policy.displayName === params.displayName;
    }
    return false;
  });
}

export function buildWorkflowRunsApiPath(
  policy: WorkflowPolicy,
  perPage = 20,
): string {
  const workflowRef = encodeURIComponent(String(policy.workflowRef));
  const branch = encodeURIComponent(policy.branch);
  return `repos/${policy.repo}/actions/workflows/${workflowRef}/runs?branch=${branch}&per_page=${perPage}`;
}

export function buildWorkflowMetadataApiPath(policy: WorkflowPolicy): string {
  const workflowRef = encodeURIComponent(String(policy.workflowRef));
  return `repos/${policy.repo}/actions/workflows/${workflowRef}`;
}

export function fingerprintSecretValue(value?: string | null): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function runTimestamp(run: WorkflowRunSummary): string | undefined {
  return run.startedAt || run.updatedAt || run.createdAt;
}

export function evaluateWorkflowRun(
  run: WorkflowRunSummary | null | undefined,
  now = new Date(),
  staleMinutes = 20,
  severity: WorkflowSeverity = "blocker",
): WorkflowAssessment {
  if (!run) {
    return {
      level: "warning",
      status: "unknown",
      message: "No recent run found on the monitored branch.",
      ageMinutes: null,
    };
  }

  const status = (run.status || "").toLowerCase();
  const conclusion = (run.conclusion || "").toLowerCase();
  const timestamp = runTimestamp(run);
  const ageMinutes = timestamp
    ? Math.max(0, Math.round((now.getTime() - new Date(timestamp).getTime()) / 60000))
    : null;

  if (status === "completed") {
    if (conclusion === "success") {
      return {
        level: "ok",
        status: "healthy",
        message: "Latest run completed successfully.",
        ageMinutes,
      };
    }

    if (SKIPPABLE_CONCLUSIONS.has(conclusion)) {
      return {
        level: "skip",
        status: "cancelled",
        message: "Latest run was cancelled (superseded). Check prior runs for real status.",
        ageMinutes,
      };
    }

    if (FAILED_CONCLUSIONS.has(conclusion)) {
      return {
        level: levelForSeverity(severity),
        status: "failed",
        message: `Latest run completed with ${conclusion}.`,
        ageMinutes,
      };
    }

    return {
      level: "warning",
      status: "unknown",
      message: `Latest run completed with unexpected conclusion "${conclusion || "unknown"}".`,
      ageMinutes,
    };
  }

  if (RUNNING_STATUSES.has(status)) {
    if (ageMinutes !== null && ageMinutes > staleMinutes) {
      return {
        level: levelForSeverity(severity),
        status: "stale",
        message: `Latest run is still ${status} after ${ageMinutes} minutes.`,
        ageMinutes,
      };
    }

    return {
      level: "ok",
      status: "running",
      message: `Latest run is currently ${status}.`,
      ageMinutes,
    };
  }

  return {
    level: "warning",
    status: "unknown",
    message: `Latest run returned unexpected status "${status || "unknown"}".`,
    ageMinutes,
  };
}

export function evaluateWorkflowExistence(
  exists: boolean,
  severity: WorkflowSeverity = "warning",
): WorkflowAssessment {
  if (exists) {
    return {
      level: "ok",
      status: "configured",
      message: "Workflow is configured; no recent run is required.",
      ageMinutes: null,
    };
  }

  return {
    level: levelForSeverity(severity),
    status: "unknown",
    message: "Workflow is not available via the GitHub Actions workflow API.",
    ageMinutes: null,
  };
}

export function selectLatestMeaningfulRun(
  runs: WorkflowRunSummary[],
  now = new Date(),
  staleMinutes = 20,
  severity: WorkflowSeverity = "blocker",
): {
  run: WorkflowRunSummary | null;
  assessment: WorkflowAssessment;
  skippedCancelledCount: number;
} {
  if (runs.length === 0) {
    return {
      run: null,
      assessment: evaluateWorkflowRun(null, now, staleMinutes, severity),
      skippedCancelledCount: 0,
    };
  }

  let skippedCancelledCount = 0;
  let firstCancelledRun: WorkflowRunSummary | null = null;
  let firstCancelledAssessment: WorkflowAssessment | null = null;
  for (const run of runs) {
    const assessment = evaluateWorkflowRun(run, now, staleMinutes, severity);
    if (assessment.status === "cancelled") {
      skippedCancelledCount += 1;
      if (!firstCancelledRun) {
        firstCancelledRun = run;
        firstCancelledAssessment = assessment;
      }
      continue;
    }

    return {
      run,
      assessment:
        skippedCancelledCount === 0
          ? assessment
          : {
              ...assessment,
              message: `(Skipped ${skippedCancelledCount} cancelled run${
                skippedCancelledCount > 1 ? "s" : ""
              }) ${assessment.message}`,
            },
      skippedCancelledCount,
    };
  }

  return {
    run: firstCancelledRun,
    assessment:
      firstCancelledAssessment ?? evaluateWorkflowRun(firstCancelledRun, now, staleMinutes, severity),
    skippedCancelledCount,
  };
}

export function evaluateSecretScope(params: {
  environmentExists: boolean;
  environmentName: string;
  repo: string;
  environmentSecrets: string[];
  repoSecrets: string[];
  requiredEnvSecrets: string[];
}): SecretScopeAssessment {
  if (!params.environmentExists) {
    return {
      level: "blocker",
      message: `${params.repo} is missing the ${params.environmentName} GitHub environment.`,
      missingEnvSecrets: [...params.requiredEnvSecrets],
      repoFallbackSecrets: [],
    };
  }

  const envSecretSet = new Set(params.environmentSecrets);
  const repoSecretSet = new Set(params.repoSecrets);
  const missingEnvSecrets = params.requiredEnvSecrets.filter((name) => !envSecretSet.has(name));
  const repoFallbackSecrets = missingEnvSecrets.filter((name) => repoSecretSet.has(name));

  if (missingEnvSecrets.length === 0) {
    return {
      level: "ok",
      message: `${params.repo} has the required ${params.environmentName} environment secrets.`,
      missingEnvSecrets,
      repoFallbackSecrets,
    };
  }

  if (repoFallbackSecrets.length > 0) {
    return {
      level: "blocker",
      message: `${params.repo} relies on repo-level fallback for ${repoFallbackSecrets.join(
        ", ",
      )} in ${params.environmentName}.`,
      missingEnvSecrets,
      repoFallbackSecrets,
    };
  }

  return {
    level: "blocker",
    message: `${params.repo} is missing ${missingEnvSecrets.join(", ")} in the ${params.environmentName} environment.`,
    missingEnvSecrets,
    repoFallbackSecrets,
  };
}

export function compareFingerprints(
  canonicalLabel: string,
  entries: FingerprintEntry[],
): FingerprintAssessment {
  const normalized = entries.map((entry) => ({
    label: entry.label,
    fingerprint: fingerprintSecretValue(entry.value),
  }));
  const canonical = normalized.find((entry) => entry.label === canonicalLabel) ?? null;

  if (!canonical?.fingerprint) {
    return {
      level: "blocker",
      status: "missing",
      canonicalFingerprint: null,
      entries: normalized,
      mismatches: [],
      missing: normalized.map((entry) => entry.label),
      message: `Canonical source ${canonicalLabel} is missing a readable value.`,
    };
  }

  const mismatches = normalized
    .filter((entry) => entry.fingerprint && entry.fingerprint !== canonical.fingerprint)
    .map((entry) => entry.label);
  const missing = normalized.filter((entry) => !entry.fingerprint).map((entry) => entry.label);

  if (mismatches.length === 0 && missing.length === 0) {
    return {
      level: "ok",
      status: "synced",
      canonicalFingerprint: canonical.fingerprint,
      entries: normalized,
      mismatches,
      missing,
      message: "All readable secret fingerprints match the canonical source.",
    };
  }

  const driftParts: string[] = [];
  if (mismatches.length > 0) {
    driftParts.push(`mismatch: ${mismatches.join(", ")}`);
  }
  if (missing.length > 0) {
    driftParts.push(`missing: ${missing.join(", ")}`);
  }

  return {
    level: "blocker",
    status: mismatches.length > 0 ? "drifted" : "missing",
    canonicalFingerprint: canonical.fingerprint,
    entries: normalized,
    mismatches,
    missing,
    message: `Secret parity drift detected (${driftParts.join("; ")}).`,
  };
}

export function mergeLevels(levels: IssueLevel[]): IssueLevel {
  if (levels.includes("blocker")) return "blocker";
  if (levels.includes("warning")) return "warning";
  return "ok";
}
