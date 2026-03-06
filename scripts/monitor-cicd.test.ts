import { describe, expect, test } from "bun:test";
import {
  compareFingerprints,
  environmentToBranch,
  evaluateSecretScope,
  evaluateWorkflowRun,
} from "./monitor-cicd-lib";

describe("monitor-cicd-lib", () => {
  test("maps environments to branches", () => {
    expect(environmentToBranch("staging")).toBe("staging");
    expect(environmentToBranch("production")).toBe("main");
  });

  test("marks old in-progress workflows as blockers", () => {
    const result = evaluateWorkflowRun(
      {
        status: "in_progress",
        createdAt: "2026-03-06T00:00:00.000Z",
      },
      new Date("2026-03-06T01:00:00.000Z"),
      20,
    );

    expect(result.level).toBe("blocker");
    expect(result.status).toBe("stale");
  });

  test("treats missing workflow runs as warnings", () => {
    const result = evaluateWorkflowRun(null, new Date("2026-03-06T01:00:00.000Z"), 20);

    expect(result.level).toBe("warning");
    expect(result.status).toBe("unknown");
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
