import { describe, expect, test } from "bun:test";
import {
  buildWorkflowRunsApiPath,
  compareFingerprints,
  evaluateSecretScope,
  evaluateWorkflowExistence,
  evaluateWorkflowRun,
  findWorkflowPolicy,
  getWorkflowPoliciesForEnvironment,
} from "./monitor-cicd-lib";
import { buildReport, type MonitorDependencies } from "./monitor-cicd";

const SUCCESS_RUN = {
  status: "completed",
  conclusion: "success",
  updatedAt: "2026-03-07T00:01:19Z",
  startedAt: "2026-03-07T00:01:03Z",
  url: "https://github.com/WeKruit/example/actions/runs/1",
};

describe("monitor-cicd-lib", () => {
  test("uses workflow-specific run lookups so ATM CI is not hidden by repo-wide monitor noise", () => {
    const policy = findWorkflowPolicy({
      repo: "WeKruit/ATM",
      workflowRef: "ci-atm.yml",
      environment: "production",
    });

    expect(policy).toBeDefined();
    expect(buildWorkflowRunsApiPath(policy!, 20)).toBe(
      "repos/WeKruit/ATM/actions/workflows/ci-atm.yml/runs?branch=main&per_page=20",
    );
    expect(buildWorkflowRunsApiPath(policy!, 20)).not.toContain("/actions/runs?");
  });

  test("excludes staging-only workflows from production monitoring", () => {
    const productionPolicies = getWorkflowPoliciesForEnvironment("production");

    expect(
      productionPolicies.some((policy) => policy.workflowRef === "cd-staging.yml"),
    ).toBe(false);
    expect(
      productionPolicies.some((policy) => policy.workflowRef === "integration-test.yml"),
    ).toBe(false);
    expect(
      productionPolicies.some((policy) => String(policy.workflowRef) === "240340825"),
    ).toBe(false);
  });

  test("marks old in-progress workflows as blockers when policy severity is blocker", () => {
    const result = evaluateWorkflowRun(
      {
        status: "in_progress",
        createdAt: "2026-03-06T00:00:00.000Z",
      },
      new Date("2026-03-06T01:00:00.000Z"),
      20,
      "blocker",
    );

    expect(result.level).toBe("blocker");
    expect(result.status).toBe("stale");
  });

  test("treats existence-only workflows as configured instead of missing recent runs", () => {
    const result = evaluateWorkflowExistence(true, "warning");

    expect(result.level).toBe("ok");
    expect(result.status).toBe("configured");
  });

  test("keeps warning-only workflow failures as warnings", () => {
    const policy = findWorkflowPolicy({
      repo: "WeKruit/GH-Desktop-App",
      workflowRef: "ci.yml",
      environment: "production",
    });

    expect(policy).toBeDefined();
    const result = evaluateWorkflowRun(
      {
        status: "completed",
        conclusion: "failure",
        updatedAt: "2026-03-07T08:51:33Z",
      },
      new Date("2026-03-07T09:00:00.000Z"),
      20,
      policy!.severity,
    );

    expect(result.level).toBe("warning");
    expect(result.status).toBe("failed");
  });

  test("keeps blocker workflows as blockers", () => {
    const policy = findWorkflowPolicy({
      repo: "WeKruit/ATM",
      workflowRef: "cd-atm-api.yml",
      environment: "production",
    });

    expect(policy).toBeDefined();
    const result = evaluateWorkflowRun(
      {
        status: "completed",
        conclusion: "failure",
        updatedAt: "2026-03-07T08:51:33Z",
      },
      new Date("2026-03-07T09:00:00.000Z"),
      20,
      policy!.severity,
    );

    expect(result.level).toBe("blocker");
    expect(result.status).toBe("failed");
  });

  test("flags repo-level secret fallback as drift", () => {
    const result = evaluateSecretScope({
      environmentExists: true,
      environmentName: "production",
      repo: "WeKruit/GH-Desktop-App",
      environmentSecrets: ["ATM_HOST"],
      repoSecrets: ["ATM_DEPLOY_SECRET", "GH_DEPLOY_SECRET"],
      requiredEnvSecrets: ["ATM_HOST", "ATM_DEPLOY_SECRET", "GH_DEPLOY_SECRET"],
    });

    expect(result.level).toBe("blocker");
    expect(result.repoFallbackSecrets).toEqual(["ATM_DEPLOY_SECRET", "GH_DEPLOY_SECRET"]);
  });

  test("compares fingerprints without exposing raw values", () => {
    const result = compareFingerprints("canonical", [
      { label: "canonical", value: "same-value" },
      { label: "aws", value: "same-value" },
      { label: "runtime", value: "different-value" },
    ]);

    expect(result.level).toBe("blocker");
    expect(result.status).toBe("drifted");
    expect(result.canonicalFingerprint).toBeTruthy();
    expect(result.entries.every((entry) => entry.fingerprint !== "same-value")).toBe(true);
  });
});

describe("monitor-cicd", () => {
  function createDeps(
    overrides: Partial<MonitorDependencies> = {},
  ): MonitorDependencies {
    return {
      now: new Date("2026-03-07T09:00:00.000Z"),
      listWorkflowRuns: async (policy) => {
        if (policy.monitorMode !== "latest-run") return [];

        if (policy.repo === "WeKruit/GH-Desktop-App" && policy.workflowRef === "ci.yml") {
          return [
            {
              ...SUCCESS_RUN,
              conclusion: "failure",
            },
          ];
        }

        return [SUCCESS_RUN];
      },
      getWorkflowExists: async () => true,
      collectInfrastructureRecords: async () => [],
      collectSecretRecords: async () => [],
      ...overrides,
    };
  }

  test("does not fail the report when only warning-level workflows are red", async () => {
    const report = await buildReport("production", createDeps());

    expect(report.overallStatus).toBe("warning");
    expect(report.blockers).toHaveLength(0);
    expect(
      report.warnings.some(
        (issue) => issue.target === "WeKruit/GH-Desktop-App / CI/CD",
      ),
    ).toBe(true);
  });

  test("fails the report when a production blocker workflow is red", async () => {
    const report = await buildReport(
      "production",
      createDeps({
        listWorkflowRuns: async (policy) => {
          if (policy.monitorMode !== "latest-run") return [];
          if (policy.repo === "WeKruit/ATM" && policy.workflowRef === "cd-atm-api.yml") {
            return [
              {
                ...SUCCESS_RUN,
                conclusion: "failure",
              },
            ];
          }

          return [SUCCESS_RUN];
        },
      }),
    );

    expect(report.overallStatus).toBe("blocker");
    expect(
      report.blockers.some(
        (issue) => issue.target === "WeKruit/ATM / CD → ATM API (EC2)",
      ),
    ).toBe(true);
  });
});
