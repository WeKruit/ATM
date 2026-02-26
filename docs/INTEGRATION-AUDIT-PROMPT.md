# Full Stack Integration Audit: VALET ↔ GH ↔ ATM

Paste this into a Claude Code session opened at:
`cd ~/Desktop/WeKruit/VALET\ \&\ GH/`

---

```
You are a senior engineer auditing the full integration between three projects. Your job is to find every inconsistency, broken flow, dead code path, and mismatched assumption — then produce a prioritized fix list.

## The Three Projects

1. **VALET** (`./VALET/`) — User-facing app on Fly.io. Submits automation jobs, shows progress, manages workers.
2. **GHOST-HANDS** (`./GHOST-HANDS/`) — Browser automation engine on EC2. Runs jobs in Chromium, reports back via callbacks.
3. **ATM** (`./ATM/`) — Operations platform on EC2. Fleet health, deploys, secrets, dashboard.

## Required Reading (do this first)

Read these files in order — do NOT skip any:
1. `./ATM/docs/MULTI-EC2-FLEET-PLAN.md` — The fleet architecture plan (data flows, shared tables, integration surface)
2. `./VALET/CLAUDE.md` → follow its required reading chain
3. `./GHOST-HANDS/CLAUDE.md` → follow its required reading chain
4. `./GHOST-HANDS/docs/API-CONTRACTS.md` — GH endpoint response shapes

## Known Bug: Worker Never Picks Up Jobs

A job was submitted from VALET (task a3c415a6, job a2e11f72) but GH worker never picked it up. Worker starts with `dispatchMode: "legacy"`, connects to Postgres, registers in gh_worker_registry, starts status server — but has ZERO job polling activity. Only 9 log lines. Job sat there until user cancelled it.

This is the #1 priority to diagnose.

## Audit Scope — Investigate Each Area

### 1. Job Dispatch Flow (CRITICAL)

Read and trace the FULL path:

**VALET side:**
- `VALET/apps/api/src/modules/ghosthands/ghosthands.client.ts` — how does VALET submit jobs? REST POST? pg-boss enqueue? Both?
- `VALET/apps/api/src/modules/automation/` — find the job creation flow. What table does it write to? What queue?
- `VALET/apps/worker/` — does VALET have its own worker that dispatches to GH?

**GH side:**
- `GHOST-HANDS/packages/ghosthands/src/workers/main.ts` — the worker boot. Find EXACTLY where it subscribes to pg-boss or starts polling. Is there a bug where legacy mode doesn't start the poll loop?
- `GHOST-HANDS/packages/ghosthands/src/api/routes/valet.ts` — the REST API for job submission from VALET
- `GHOST-HANDS/packages/ghosthands/src/workers/dispatch/` — dispatch modes (legacy vs pg-boss vs direct)

**Questions to answer:**
- What queue name does VALET publish jobs to?
- What queue name does GH worker subscribe to?
- Do they match?
- Is there a race where the job gets created in the DB but never enqueued?
- Does `dispatchMode: "legacy"` actually start a polling loop, or does it only listen for NOTIFY?
- Is there a missing `pgBoss.start()` or `pgBoss.work()` call?

### 2. Worker Registration & Routing

**VALET side:**
- `VALET/apps/api/src/modules/sandboxes/sandbox.repository.ts` — `findWorkerIp()`, `resolveWorkerId()`, `resolveHealthyIp()`
- `VALET/apps/api/src/modules/ghosthands/ghosthands.client.ts` — the new fleet routing (resolveWorkerIpForJob, resolveApiUrlForJob, etc.)

**GH side:**
- Where does the worker write to `gh_worker_registry`? What fields?
- What `worker_id` format does it use? Does VALET expect the same format?
- Does `ec2_ip` get set correctly?

**Questions:**
- After a Kamal deploy (container restart), does the worker get a NEW worker_id? Does the old one get cleaned up?
- Is `sandboxes` table in sync with `gh_worker_registry`? Or are they redundant/conflicting?
- Does VALET's `resolveHealthyIp()` query `sandboxes` or `gh_worker_registry` or both?

### 3. Callback Flow

- When GH finishes a job, what URL does it callback to? Is it hardcoded or per-job?
- Read `GHOST-HANDS/packages/ghosthands/src/workers/` — find the callback mechanism
- Read `VALET/apps/api/src/modules/ghosthands/` — find the webhook/callback handler
- Is the callback URL correct for staging? Production? Does it use the right auth?

### 4. Health Probing (Redundancy Check)

Three systems probe GH health independently:
- **VALET** probes GH directly (sandbox health monitor)
- **ATM** probes GH via fleet proxy
- **ATM dashboard** fetches from ATM proxy

**Questions:**
- Is VALET still probing GH directly, or does it use ATM's `/fleet` endpoint now?
- Are there conflicting health states? (ATM says healthy, VALET says degraded, or vice versa)
- What happens when ATM and VALET disagree on health?

### 5. ATM Dashboard Issues

- **Deploy button UX**: The deploy panel shows briefly then disappears. The POST to `/deploy/kamal` fires but the LogStream/SSE panel collapses. Check `ATM/atm-dashboard/src/pages/KamalPage.tsx` — is there a state reset on the POST response that hides the stream?
- **Secret storage**: The deploy secret input uses `sessionStorage`. Is it being read back on mount? Check if the key name is consistent between KamalPage and SecretsPage.
- **Fleet overview**: Do the health cards accurately reflect the proxy responses? Compare `ATM/atm-dashboard/src/pages/FleetOverviewPage.tsx` with what `/fleet` returns.
- **Metrics page**: Shows all zeros for GH workers. Is this clearly communicated in the UI (e.g., "System metrics not available for remote workers")?

### 6. Environment Variable Consistency

Check these across all three projects:
- `GH_SERVICE_SECRET` / `GH_SERVICE_KEY` / `X-GH-Service-Key` — is the header name consistent?
- `GH_DEPLOY_SECRET` / `X-Deploy-Secret` — ATM uses this, does VALET use the same value?
- `DATABASE_URL` — do VALET and GH point to the same Supabase instance?
- `GHOSTHANDS_API_URL` — VALET env var, now optional. Is it still set in Fly.io secrets?
- `CALLBACK_URL` / `callback_url` — what does GH use for callbacks?

### 7. Kamal Deploy Config

- `ATM/config/deploy.yml` — verify entrypoint, ports, env secrets match what GH actually needs
- `ATM/config/deploy.staging.yml` — hosts correct?
- Are the secret names in `env.secret` the exact names GH reads from `process.env`?
- Does the pre-deploy stop cause job loss? (stops containers before new ones start)

### 8. Database Schema Consistency

Check the shared tables:
- `gh_automation_jobs` — what columns does VALET write vs GH write? Any NOT NULL violations?
- `gh_worker_registry` — is the schema what both sides expect? Column names match?
- `gh_job_events` — who writes, who reads? Format consistent?
- `sandboxes` — does ATM's fleet config need to sync here?

## Output Format

Produce a report with:

1. **CRITICAL** — Blocks job execution (like the dispatch bug)
2. **HIGH** — Causes incorrect behavior visible to users
3. **MEDIUM** — Inconsistencies that work at N=1 but break at N>1
4. **LOW** — Code smell, dead paths, redundancy

For each finding:
```
### [SEVERITY] Title
**Where:** file paths
**What:** description of the inconsistency
**Impact:** what breaks
**Fix:** what to change (be specific — file, line, change)
```

Do NOT fix anything. Only audit and report.
```
