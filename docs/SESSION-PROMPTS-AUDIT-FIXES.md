# Audit Fix Prompts — 16 Findings

---

## Session 1: GHOST-HANDS

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/GHOST-HANDS`

```
You are fixing audit findings from a cross-project integration review. Read CLAUDE.md first. These are all independent fixes — use team swarming with 3 parallel agents.

### Agent 1: C1 + C3 — Dispatch mode and LISTEN/NOTIFY fixes

**C1: Dispatch mode env var mismatch**

VALET uses `TASK_DISPATCH_MODE=queue` and GH uses `JOB_DISPATCH_MODE=legacy`. These are different env vars with different values representing the same concept. The inline SQL fix in JobPoller.ts already handles both statuses, but the env vars should be aligned.

Read `packages/ghosthands/src/workers/main.ts` — find where `JOB_DISPATCH_MODE` is read. Document what each mode does (legacy = poll with gh_pickup_next_job, pgboss = pg-boss work(), direct = REST API).

Fix: Add a comment in main.ts explaining the modes and that `legacy` is the correct mode for production (it handles both 'pending' and 'queued' statuses via the fixed JobPoller). No code change needed unless you find the mode selection is broken.

**C3: LISTEN/NOTIFY fails through pgbouncer**

Read `packages/ghosthands/src/workers/JobPoller.ts` — find where it creates the pgPool for LISTEN/NOTIFY. It uses `DATABASE_URL` which goes through Supabase's pgbouncer (transaction mode). LISTEN/NOTIFY requires a persistent connection and doesn't work through pgbouncer.

Fix:
1. Find where the LISTEN pool is created
2. Change it to prefer `DATABASE_DIRECT_URL` (Supabase's direct connection) over `DATABASE_URL`
3. If `DATABASE_DIRECT_URL` isn't available, log a warning that LISTEN/NOTIFY will be degraded (poll-only mode still works via the 5s timer)
4. Also note: the audit found that `pg_notify('gh_job_created', ...)` is never called anywhere — there's no trigger or function that sends the notification. Add a TODO comment noting this dead path.

### Agent 2: H2 + L3 + L4 — Worker lifecycle cleanup

**H2: Stale worker_id entries after container restart**

Every Kamal deploy restarts containers, generating a new worker_id. The old entry stays in `gh_worker_registry` forever with status='active' and a stale heartbeat.

Read `packages/ghosthands/src/workers/main.ts` — find the SIGTERM/shutdown handler.

Fix: On shutdown (SIGTERM), update `gh_worker_registry` to set `status = 'offline'` for this worker_id before exiting. Also: on worker startup, mark any entries with the same `ec2_ip` but different `worker_id` and `last_heartbeat` older than 2 minutes as 'offline' (stale cleanup).

**L3: completed_at overloaded in non-terminal callbacks**

Read the callback mechanism — find where GH sets `completed_at` on job status updates.

Fix: Only set `completed_at` for terminal statuses (completed, failed, cancelled). Non-terminal status updates (progress, paused) should not touch completed_at.

**L4: PgBossConsumer re-enqueue creates duplicates**

Read `packages/ghosthands/src/workers/PgBossConsumer.ts` — find re-enqueue logic.

Fix: Before re-enqueueing a job, check if the job ID already exists in the queue. Use pg-boss's `getJobById()` or check the `gh_automation_jobs` status to avoid duplicates.

### Agent 3: H3 + M3 — Security and metrics

**H3: Service secret in callback URL query param**

Read the job submission flow — find where `callback_url` is constructed. It currently includes `?secret=XXX` in the URL, which gets stored in the DB and logged by proxies.

Fix: Remove the secret from the callback URL query parameter. Instead, GH should send the service secret as an `X-GH-Service-Key` header in the callback POST request. The secret value is already in GH's env as `GH_SERVICE_SECRET`.

Read the callback sender code — find where it makes the HTTP POST to VALET's webhook endpoint. Add the header there.

NOTE: VALET's webhook handler will need to be updated too (covered in VALET session). For now, send BOTH the query param AND the header for backward compatibility. Add a TODO to remove the query param after VALET is updated.

**M3: GH metrics always zero in ATM dashboard**

ATM dashboard shows zeros for CPU/memory/disk on GH workers because GH has no system metrics endpoint.

Fix: Add a `GET /monitoring/system` endpoint to the GH API that returns:
```json
{
  "cpu": { "usagePercent": <from /proc/stat or os.loadavg>, "cores": <os.cpus().length> },
  "memory": { "usedMb": <totalMem - freeMem>, "totalMb": <totalMem>, "usagePercent": <used/total*100> },
  "disk": { "usedGb": 0, "totalGb": 0, "usagePercent": 0 }
}
```

Use Bun/Node built-ins (`os.totalmem()`, `os.freemem()`, `os.loadavg()`, `os.cpus()`). Skip disk metrics (needs `df` or `statfs` — not worth it). Set disk to zeros.

Read `packages/ghosthands/src/api/routes/health.ts` — add the new endpoint near the existing health routes.

## Constraints
- Run `bun test` — all existing tests must pass
- Don't break any existing API contracts (only ADD, never remove)
- H3: keep backward-compatible (send both query param and header)
- Commit: `fix(gh): audit fixes — dispatch alignment, stale workers, callback security, system metrics`
```

---

## Session 2: VALET

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/VALET`

```
You are fixing audit findings from a cross-project integration review. Read CLAUDE.md first. These are all independent fixes — use team swarming with 3 parallel agents.

### Agent 1: H1 + M4 + L2 — Schema and pg-boss alignment

**H1: Drizzle default 'queued' ≠ DDL default 'pending'**

The Drizzle schema for `gh_automation_jobs` sets the default status to `'queued'`, but the actual Supabase DDL default is `'pending'`. This means jobs created through Drizzle get 'queued' while jobs created through raw SQL get 'pending'.

Read `packages/db/src/schema/` — find the gh_automation_jobs table definition. Find the status column default.

Fix: Change the Drizzle default to `'pending'` to match the DDL. Then in the job creation code (`apps/api/src/modules/ghosthands/gh-automation-job.repository.ts`), explicitly set `status: 'queued'` when creating via the queue dispatch path, and `status: 'pending'` when creating via direct dispatch. This makes the intent explicit rather than relying on defaults.

**M4: pg-boss expiry mismatch + missing createQueue**

Read `apps/api/src/modules/tasks/task-queue.service.ts` — line 87-93 area.
Read `GHOST-HANDS/packages/ghosthands/src/workers/PgBossConsumer.ts` — lines 24-25, 72-74.

VALET sends with `expireInSeconds: 14400` (4h), GH creates the queue with `expireInSeconds: 1800` (30min).

Fix:
1. Align expiry: change GH's PgBossConsumer to use 14400 (4 hours) — but since this is a GH file, just note this in a TODO comment in VALET's code and handle it in the GH session
2. In VALET: before the first `boss.send()` for the general `gh_apply_job` queue, call `boss.createQueue()` with `expireInSeconds: 14400`. Currently line 87-89 only creates queues for targeted dispatches.

**L2: insertPendingJob naming contradiction**

Read `apps/api/src/modules/ghosthands/gh-automation-job.repository.ts` — find `insertPendingJob()`.

It's called "insertPendingJob" but inserts with status='queued'. Rename to `insertJob()` or `createJob()` to be accurate. Update all callers.

### Agent 2: H3 (VALET side) + M2 + H6 — Callback security, routing, health

**H3: Service secret in callback URL (VALET side)**

GH is being updated to send `X-GH-Service-Key` header on callbacks (in addition to the query param for now).

Read `apps/api/src/modules/ghosthands/` — find the webhook/callback handler endpoint. It currently validates the secret from the query parameter.

Fix: Update the handler to check BOTH:
1. `X-GH-Service-Key` header (new, preferred)
2. `?secret=` query param (legacy, for backward compat)

Accept either one. Add a TODO to remove query param validation after GH stops sending it.

**M2: Cancel/resume silent fallback to random EC2**

Read `apps/api/src/modules/ghosthands/ghosthands.client.ts` — find `resolveWorkerIpForJob()` and the fallback chain.

Currently, if the job-targeted lookup fails (no workerId in DB, or no ec2_ip), it silently falls back to `resolveHealthyIp()` which picks a random EC2. At N>1, this means cancel goes to the wrong machine.

Fix: When fallback occurs, log a WARNING:
```
log.warn({ jobId, reason: 'workerId not found in gh_worker_registry' }, 'Fleet routing fallback — cancel/resume may reach wrong EC2')
```

Also: if the job has a `workerId` but `findWorkerIp()` returns null (worker not in registry), that's a real problem — log at ERROR level.

**H6: VALET/ATM health state divergence**

Read `apps/api/src/modules/sandboxes/sandbox-health-monitor.ts` — how does VALET determine health?
Read what ATM returns at `/fleet/:id/health` (status: "healthy" | "degraded" | "offline").

Fix: If a `sandbox-health-monitor.ts` exists and directly probes GH, ensure its health determination uses the same logic as ATM's proxy. Ideally VALET should consume ATM's `/fleet` endpoint (WEK-406 from the fleet plan) rather than probing GH independently. If WEK-406 isn't implemented yet, add a TODO. If it is, verify the health states are consistent.

### Agent 3: M1 + WEK-408 remainder — sandboxes ↔ registry cross-reference

**M1: sandboxes ↔ gh_worker_registry disconnected**

The `sandboxes` table tracks EC2 instances (publicIp, healthStatus). The `gh_worker_registry` tracks individual workers (worker_id, ec2_ip, status). There's no foreign key or cross-reference between them.

Read `apps/api/src/modules/sandboxes/sandbox.repository.ts` — understand both tables.

Fix: Add a method `syncWorkerRegistryWithSandboxes()` that:
1. Queries `gh_worker_registry` for all active workers
2. For each unique `ec2_ip`, verifies a matching `sandboxes` row exists with that IP
3. Updates the sandbox's `healthStatus` based on worker status (all workers offline → sandbox unhealthy)
4. Logs discrepancies (worker registered from unknown IP, sandbox with no workers)

This doesn't need to run on every request — it can be called from the health monitor on a 60s interval.

## Constraints
- Run `pnpm typecheck` — 12/12 packages pass
- Run `pnpm test` — 717+ tests pass
- H3: accept both header and query param (don't break existing flow)
- Commit: `fix(valet): audit fixes — schema alignment, callback security, fleet routing warnings`
```

---

## Session 3: ATM

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/ATM`

```
You are fixing audit findings from a cross-project integration review. Read CLAUDE.md first. These are all independent fixes — use team swarming with 3 parallel agents.

### Agent 1: H4 + H5 — Dashboard display fixes

**H4: FleetOverview status check: 'ok' vs 'healthy' string mismatch**

Read `atm-dashboard/src/pages/FleetOverviewPage.tsx` — find where it checks health status to determine the card color/badge.

The ATM proxy at `server.ts` returns `status: "healthy"` in the HealthResponse. But the dashboard may be checking for `status === "ok"` (the raw GH response value).

Fix: Find all status string comparisons in the dashboard. The proxy normalizes to "healthy" | "degraded" | "offline". Make sure the dashboard checks against THOSE values, not "ok". Check ALL pages: FleetOverviewPage, FleetPage, OverviewPage.

**H5: KamalPage deploy panel collapse**

Read `atm-dashboard/src/pages/KamalPage.tsx`.

When user clicks "Deploy via Kamal":
1. `setDeploying(true)` + `setShowStream(true)` fires
2. POST to `/deploy/kamal` fires
3. SSE stream opens at `/deploy/stream`

The problem: the POST response arrives and the handler likely resets state, causing the stream panel to collapse. The SSE stream is still going but the panel is gone.

Fix: The flow should be:
1. Click → `setDeploying(true)` + `setShowStream(true)` + fire POST
2. POST response: if error (401, 409), show error and reset. If success, do NOT reset — keep the stream open
3. SSE stream `onComplete` callback: THAT's when you reset `setDeploying(false)` and refresh status
4. The stream panel should stay visible as long as `showStream` is true, regardless of POST response

Also verify: the deploy secret input persists correctly via sessionStorage (same pattern as SecretsPage).

### Agent 2: L1 + L5 + Fleet proxy metrics — Config and naming cleanup

**L1: Staging IP may be stale**

Read `atm-dashboard/public/fleet.json` — verify the IPs match the actual EC2 instances.

Current known IPs:
- ATM EC2: 34.195.147.149
- GH EC2: 44.223.180.11

Verify these are correct in fleet.json. If they already match, mark as resolved.

**L5: ATM auth naming uses GH_ prefix**

Read `atm-api/src/server.ts` — find where `GH_DEPLOY_SECRET` env var is read. This is confusing because ATM is its own project, not GH.

Fix: Accept BOTH `ATM_DEPLOY_SECRET` (new) and `GH_DEPLOY_SECRET` (legacy fallback):
```typescript
const DEPLOY_SECRET = process.env.ATM_DEPLOY_SECRET || process.env.GH_DEPLOY_SECRET;
```

Update `.env.example` to use `ATM_DEPLOY_SECRET` as the primary name.

**Fleet proxy: wire GH system metrics**

The GH team is adding a `GET /monitoring/system` endpoint that returns real CPU/memory data. Update the ATM fleet proxy to fetch from this endpoint instead of returning zeros.

Read `atm-api/src/server.ts` — find the `/fleet/:id/metrics` handler (currently returns hardcoded zeros).

Fix: Try to fetch `http://{gh_ip}:3100/monitoring/system` first. If it succeeds, map the response to the MetricsResponse type. If it fails (404 = old GH without the endpoint), fall back to zeros. This way it works with both old and new GH versions.

### Agent 3: Deploy SSE stream improvements

The `/deploy/stream` SSE endpoint exists but the Kamal deploy doesn't write to it in real-time. Read how the deploy flow works:

Read `atm-api/src/server.ts`:
- Find the POST `/deploy/kamal` handler (~line 1173)
- Find the GET `/deploy/stream` SSE handler (~line 1116)
- Find where `deployStream` is defined — how do deploy logs get piped to the SSE stream?

The deploy process runs Kamal as a child process. Verify that:
1. stdout/stderr from the Kamal process are piped to the SSE stream
2. On completion, a `{type: "complete", success: true/false}` event is sent
3. The stream stays open during the entire deploy (can be 20-120s)

If the piping isn't wired, fix it. The `LogStream.tsx` component already handles `{type: "log", line: "..."}` and `{type: "complete", success: boolean}` events.

## Constraints
- No new npm packages
- Run `bun test` in atm-api — existing tests pass
- Run `bun run build` in atm-dashboard — compiles clean
- Commit: `fix(atm): audit fixes — dashboard status strings, deploy panel UX, fleet proxy metrics, SSE stream`

## Deployment

After committing, deploy:
```bash
rsync -avz -e "ssh -i ~/.ssh/wekruit-atm-server.pem" "atm-api/" ubuntu@34.195.147.149:/opt/atm/atm-api/ --exclude node_modules --exclude .env
rsync -avz -e "ssh -i ~/.ssh/wekruit-atm-server.pem" "atm-dashboard/" ubuntu@34.195.147.149:/opt/atm/atm-dashboard/ --exclude node_modules
rsync -avz -e "ssh -i ~/.ssh/wekruit-atm-server.pem" "config/" ubuntu@34.195.147.149:/opt/atm/config/
ssh -i ~/.ssh/wekruit-atm-server.pem ubuntu@34.195.147.149 "cd /opt/atm && docker compose up -d --build"
```
```
