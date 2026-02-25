/**
 * One-time import script: reads local .env files and pushes each secret
 * to Infisical organized by environment and service path.
 *
 * Usage:
 *   INFISICAL_CLIENT_ID=... \
 *   INFISICAL_CLIENT_SECRET=... \
 *   INFISICAL_PROJECT_ID=... \
 *   bun scripts/import-secrets-to-infisical.ts
 *
 * Optional:
 *   --dry-run   Print what would be imported without making API calls
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const SITE_URL =
  process.env.INFISICAL_SITE_URL || "https://infisical-wekruit.fly.dev";
const CLIENT_ID = process.env.INFISICAL_CLIENT_ID;
const CLIENT_SECRET = process.env.INFISICAL_CLIENT_SECRET;
const PROJECT_ID = process.env.INFISICAL_PROJECT_ID;
const DRY_RUN = process.argv.includes("--dry-run");

if (!CLIENT_ID || !CLIENT_SECRET || !PROJECT_ID) {
  console.error(
    "Missing required env vars: INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID"
  );
  process.exit(1);
}

// ── Secret mapping: source file → Infisical environment + path ──────

const IMPORTS = [
  { file: "../VALET/.env", env: "dev", path: "/valet" },
  { file: "../VALET/.env.staging", env: "staging", path: "/valet" },
  { file: "../VALET/.env.production", env: "prod", path: "/valet" },
  { file: "../GHOST-HANDS/.env", env: "dev", path: "/ghosthands" },
  { file: "../GHOST-HANDS/.env.staging", env: "staging", path: "/ghosthands" },
  { file: "../GHOST-HANDS/.env.production", env: "prod", path: "/ghosthands" },
];

// ── .env parser ─────────────────────────────────────────────────────

function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

// ── Infisical API helpers ───────────────────────────────────────────

let accessToken = "";

async function authenticate(): Promise<void> {
  const res = await fetch(`${SITE_URL}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { accessToken: string };
  accessToken = data.accessToken;
}

async function createFolder(
  environment: string,
  name: string
): Promise<void> {
  const res = await fetch(`${SITE_URL}/api/v1/folders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: PROJECT_ID,
      environment,
      name,
      path: "/",
    }),
  });
  if (res.ok) {
    console.log(`  Created folder /${name} in ${environment}`);
  } else {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    // 400 = already exists, which is fine
    if (res.status === 400) {
      console.log(`  Folder /${name} already exists in ${environment}`);
    } else {
      console.warn(
        `  Failed to create folder /${name} in ${environment}: ${res.status} ${JSON.stringify(body)}`
      );
    }
  }
}

async function createSecret(
  environment: string,
  secretPath: string,
  key: string,
  value: string
): Promise<"created" | "updated" | "error"> {
  const res = await fetch(`${SITE_URL}/api/v3/secrets/raw/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: PROJECT_ID,
      environment,
      secretPath,
      secretValue: value,
      type: "shared",
    }),
  });

  if (res.ok) return "created";

  // If already exists, try update (PATCH)
  if (res.status === 400 || res.status === 409) {
    const updateRes = await fetch(
      `${SITE_URL}/api/v3/secrets/raw/${encodeURIComponent(key)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: PROJECT_ID,
          environment,
          secretPath,
          secretValue: value,
          type: "shared",
        }),
      }
    );
    if (updateRes.ok) return "updated";
    const body = await updateRes.text();
    console.error(`    PATCH failed for ${key}: ${updateRes.status} ${body}`);
    return "error";
  }

  const body = await res.text();
  console.error(`    POST failed for ${key}: ${res.status} ${body}`);
  return "error";
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`Infisical Import Script`);
  console.log(`  Site: ${SITE_URL}`);
  console.log(`  Project: ${PROJECT_ID}`);
  console.log(`  Dry run: ${DRY_RUN}\n`);

  if (!DRY_RUN) {
    console.log("Authenticating...");
    await authenticate();
    console.log("Authenticated.\n");
  }

  // Step 1: Create folders
  console.log("── Creating folders ──");
  const environments = ["dev", "staging", "prod"];
  const folders = ["valet", "ghosthands", "atm"];

  if (!DRY_RUN) {
    for (const env of environments) {
      for (const folder of folders) {
        await createFolder(env, folder);
      }
    }
  } else {
    for (const env of environments) {
      for (const folder of folders) {
        console.log(`  [dry-run] Would create folder /${folder} in ${env}`);
      }
    }
  }

  // Step 2: Import secrets from each .env file
  console.log("\n── Importing secrets ──");

  const rootDir = resolve(import.meta.dir, "..");
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const imp of IMPORTS) {
    const filePath = resolve(rootDir, imp.file);

    if (!existsSync(filePath)) {
      console.log(`\n  SKIP: ${imp.file} (file not found)`);
      continue;
    }

    console.log(`\n  ${imp.file} → ${imp.env}:${imp.path}`);

    const secrets = parseEnvFile(filePath);
    const keys = Object.keys(secrets);
    console.log(`    Found ${keys.length} keys`);

    let created = 0,
      updated = 0,
      skipped = 0,
      errors = 0;

    for (const [name, value] of Object.entries(secrets)) {
      // Skip empty/placeholder values
      if (!value || value === "PLACEHOLDER" || value === "(empty)") {
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        const preview =
          value.length > 8
            ? `${value.slice(0, 4)}...${value.slice(-4)}`
            : "****";
        console.log(`    [dry-run] ${name} = ${preview}`);
        created++;
        continue;
      }

      const result = await createSecret(imp.env, imp.path, name, value);
      if (result === "created") created++;
      else if (result === "updated") updated++;
      else errors++;
    }

    console.log(
      `    Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`
    );
    totalCreated += created;
    totalUpdated += updated;
    totalSkipped += skipped;
    totalErrors += errors;
  }

  console.log("\n── Summary ──");
  console.log(`  Total created: ${totalCreated}`);
  console.log(`  Total updated: ${totalUpdated}`);
  console.log(`  Total skipped: ${totalSkipped}`);
  console.log(`  Total errors:  ${totalErrors}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
