# Session Prompts for Multi-EC2 Fleet Work

Copy-paste each prompt into its own Claude Code session.

---

## Session 1: GHOST-HANDS (Epic 1 — P0)

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/GHOST-HANDS`

```
I need you to implement 2 tickets for fleet-readiness. Read the full plan at `../ATM/docs/MULTI-EC2-FLEET-PLAN.md` (Epic 1: GHOST-HANDS), then read your own CLAUDE.md and follow its required reading chain.

## WEK-301: Bake COMMIT_SHA into Docker image

The ATM dashboard hits `/health/version` and gets "unknown" for commit SHA because we never pass it at build time.

1. Read `Dockerfile` — add ARG + ENV for `COMMIT_SHA`, `BUILD_TIME`, `IMAGE_TAG`
2. Read `.github/workflows/build-and-push.yml` — add `--build-arg COMMIT_SHA=${{ github.sha }}` and `--build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)` and `--build-arg IMAGE_TAG=${{ steps.meta.outputs.tags }}`
3. Read `packages/ghosthands/src/api/routes/health.ts` — verify the `/health/version` handler reads `process.env.COMMIT_SHA`. If it already does, confirm. If not, add it.
4. Verify: `docker build --build-arg COMMIT_SHA=test123 .` then check the image has the env set.

## WEK-302: Standardize health responses for ATM fleet proxy

ATM proxy needs to transform GH health responses. GH should expose richer data to make this easier. Currently:
- `/health` returns `{status, service, version}` — needs an `api_healthy` boolean (can we reach DB?)
- `/worker/health` at port 3101 already returns `{status, active_jobs, deploy_safe}` — verify this is true
- `/worker/status` at port 3101 already returns `{worker_id, ec2_instance_id, ec2_ip, active_jobs, max_concurrent, is_running, is_draining, uptime_ms}` — verify this is true

Steps:
1. Read `packages/ghosthands/src/api/routes/health.ts` — find the `/health` handler, add `api_healthy: true` field (do a lightweight DB ping if possible, otherwise default true)
2. Read `packages/ghosthands/src/workers/main.ts` — find the worker HTTP server section (~line 409-480), verify `/worker/health` and `/worker/status` response shapes match what I listed above
3. Create `docs/API-CONTRACTS.md` documenting the exact response shapes for both API:3100 and Worker:3101 endpoints that ATM consumes

## Constraints
- ZERO breaking changes — only ADD fields, never remove or rename existing ones
- All new fields must be additive (old consumers ignore them)
- Run `bun test` after changes — all existing tests must pass
- Commit with format: `feat(gh): WEK-301 WEK-302 fleet-ready health endpoints and Docker build args`
```

---

## Session 2: VALET (Epic 2 — P0)

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/VALET`

```
I need you to implement 3 tickets for fleet-aware job routing. Read the full plan at `../ATM/docs/MULTI-EC2-FLEET-PLAN.md` (Epic 2: VALET), then read your own CLAUDE.md and follow its required reading chain.

## The Problem

`GhostHandsClient` uses `resolveHealthyIp()` which picks the FIRST healthy sandbox for ALL requests. At N>1 EC2s, cancel/resume/retry go to a random EC2 instead of the one holding the job's browser session. The browser session is in-memory on a specific worker on a specific EC2 — we must route to it.

## The Data We Already Have

- `gh_automation_jobs.workerId` → which GH worker has the job (set by GH when it picks up the job)
- `gh_worker_registry` table → has `worker_id`, `ec2_ip`, `status`, `last_heartbeat`
- `sandboxes` table → has `publicIp`, `healthStatus` per EC2

## WEK-401: Add findWorkerIp() to SandboxRepository

Read `apps/api/src/modules/sandboxes/sandbox.repository.ts`. Near `resolveWorkerId()` (~line 307), add:

```typescript
async findWorkerIp(workerId: string): Promise<string | null> {
  // Query gh_worker_registry for ec2_ip where worker_id matches
  // Include 'draining' status because cancel/resume must still reach draining workers
  // ORDER BY last_heartbeat DESC LIMIT 1
  // Return ec2_ip or null
}
```

Use the same DB query patterns already in this file (check what ORM/query builder is used — likely drizzle).

## WEK-402: Fleet-aware GhostHandsClient routing

Read `apps/api/src/modules/ghosthands/ghosthands.client.ts` thoroughly. This is the big one.

Three routing strategies:

| Strategy | Methods | How to resolve URL |
|----------|---------|-------------------|
| **Job-targeted** | cancelJob, retryJob, resumeJob, getJobStatus | jobId → query `gh_automation_jobs` for `workerId` → query `gh_worker_registry` for `ec2_ip` → `http://{ip}:{port}` |
| **Any-healthy** | submitApplication, healthCheck, getModels, everything else | Existing `resolveHealthyIp()` — NO CHANGE |
| **Worker-specific** | getWorkerStatus, getWorkerHealth, drainWorker | Accept optional `workerId` param → query `gh_worker_registry` for `ec2_ip` |

Implementation steps:

1. Add a GhAutomationJobRepository dependency using the same late-bind pattern as `setSandboxRepository()`:
   ```typescript
   private ghJobRepo: GhAutomationJobRepository | null = null;
   setGhJobRepository(repo: GhAutomationJobRepository): void { this.ghJobRepo = repo; }
   ```

2. Add private resolution methods:
   - `resolveWorkerIpForJob(jobId: string)` — looks up workerId from gh_automation_jobs, then ec2_ip from gh_worker_registry
   - `resolveApiUrlForJob(jobId: string)` → `http://{ip}:3100`, falls back to `resolveApiUrl()` if lookup fails
   - `resolveWorkerUrlForJob(jobId: string)` → `http://{ip}:3101`, falls back to `resolveWorkerUrl()`
   - `resolveWorkerUrlById(workerId: string)` → `http://{ip}:3101`

3. Add targeted request methods (like existing `request()` and `workerRequest()` but with explicit URL):
   - `requestTargeted<T>(method, path, targetUrl, body?, timeoutMs?)`
   - `workerRequestTargeted<T>(method, path, targetUrl, timeoutMs?)`

4. Refactor these methods to use job-targeted routing:
   - `cancelJob(jobId)` — resolve URL from job's worker, then POST cancel there
   - `retryJob(jobId)` — same
   - `resumeJob(jobId, params?)` — same (critical for HITL — resolution_data must reach correct browser)
   - `getJobStatus(jobId)` — same

5. Refactor these to accept optional `workerId`:
   - `getWorkerStatus(workerId?)` — if provided, route to that worker's EC2
   - `getWorkerHealth(workerId?)` — same
   - `drainWorker(workerId?)` — same

6. Add logging: when using targeted routing, log `"GhostHands targeted request: {method} {path} → {resolvedIp} (jobId={jobId})"` so we can verify in production.

**CRITICAL**: At N=1, all routing resolves to the same single IP — behavior is identical to today. The fallback chain is: job-targeted lookup → any-healthy IP → GHOSTHANDS_API_URL env var.

## WEK-403: Wire into DI container

Read `apps/api/src/plugins/container.ts`. Find where `client.setSandboxRepository(sandboxRepo)` is called (~line 201). Add `client.setGhJobRepository(ghJobRepo)` right next to it. You'll need to find or create the GhAutomationJobRepository — check if one already exists in the codebase. It might be called `GhJobRepository` or similar, look in `apps/api/src/modules/ghosthands/` or `apps/api/src/modules/automation/`.

## Constraints
- ZERO changes needed on the GH side — this is purely VALET-side routing logic
- At N=1, behavior MUST be identical to today
- If DB lookup fails (no workerId, no ec2_ip), fall back gracefully to existing `resolveHealthyIp()` — never throw
- Run `pnpm typecheck` after changes — must pass across all 12 packages
- Run `pnpm test` — all 717+ tests must pass
- Commit with format: `feat(valet): WEK-401 WEK-402 WEK-403 fleet-aware job routing`
```

---

## Session 3: ATM (Epic 3 — P0)

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/ATM`

```
I need you to implement 2 tickets for the ATM dashboard. Read `docs/MULTI-EC2-FLEET-PLAN.md` (Epic 3: ATM), then read CLAUDE.md.

## WEK-501: Fix fleet proxy health aggregation

### The Bug
The dashboard shows "Degraded" and "Deploy safe: no" for GH workers because the fleet proxy at `atm-api/src/server.ts` (~line 591) dumb-forwards raw GH HTTP responses. But the dashboard React components expect specific TypeScript shapes defined in `atm-dashboard/src/api.ts`.

### What GH Actually Returns

API at port 3100:
- `GET /health` → `{ status: "ok", service: "ghosthands", version: "0.1.0", environment: "staging", commit_sha: "abc123", timestamp: "..." }`
- `GET /health/version` → `{ version: "0.1.0", commit_sha: "abc123", build_time: "...", uptime: 12345 }`

Worker at port 3101:
- `GET /worker/health` → `{ status: "idle"|"busy"|"draining", active_jobs: 0, deploy_safe: true }`
- `GET /worker/status` → `{ worker_id: "...", ec2_instance_id: "...", ec2_ip: "...", active_jobs: 0, max_concurrent: 1, is_running: true, is_draining: false, uptime_ms: 12345 }`

### What the Dashboard Expects

Read `atm-dashboard/src/api.ts` for the exact TypeScript types. The key ones:

- `HealthResponse`: `{ status, activeWorkers, deploySafe, apiHealthy, workerStatus, currentDeploy?, uptimeMs }`
- `VersionResponse`: `{ deployServer, version, ghosthands: GhVersionInfo | null, uptimeMs }`
- `Worker[]`: `[{ workerId, containerId, containerName, status, activeJobs, statusPort, uptime, image }]`
- `MetricsResponse`: `{ cpu: {...}, memory: {...}, disk: {...} }`
- `Container[]`: containers array
- `Deploy[]`: deploy history array

### Implementation

Read `atm-api/src/server.ts` fully, especially the fleet proxy handler (~line 591-634).

For the fleet proxy path `/fleet/:serverId/*`, instead of blindly forwarding, intercept known sub-paths and build proper responses:

1. `/fleet/:id/health` → Fetch BOTH `http://{gh_ip}:3100/health` AND `http://{gh_ip}:3101/worker/health` and `http://{gh_ip}:3101/worker/status`. Merge into `HealthResponse`:
   ```
   {
     status: apiHealth.status === "ok" ? "healthy" : "degraded",
     activeWorkers: workerStatus.active_jobs,
     deploySafe: workerHealth.deploy_safe,
     apiHealthy: apiHealth.status === "ok",
     workerStatus: workerHealth.status,
     uptimeMs: workerStatus.uptime_ms
   }
   ```

2. `/fleet/:id/version` → Fetch `http://{gh_ip}:3100/health` (it has version + commit_sha). Build `VersionResponse`.

3. `/fleet/:id/workers` → Fetch `http://{gh_ip}:3101/worker/health` + `/worker/status`. Build `Worker[]` with one entry.

4. `/fleet/:id/metrics` → Return zeroed `MetricsResponse` (GH has no system metrics endpoint).

5. `/fleet/:id/containers` → Return empty `Container[]` (ATM can't query Docker on remote GH).

6. `/fleet/:id/deploys` → Return empty `Deploy[]` (or read from ATM's own deploy history if the deploy was for this server).

**Error handling**: If GH is unreachable, return degraded status — never 502. Wrap each fetch in try/catch, return sensible defaults on failure.

### Also read these dashboard pages to understand what they render:
- `atm-dashboard/src/pages/OverviewPage.tsx` — uses HealthResponse
- `atm-dashboard/src/pages/FleetOverviewPage.tsx` — uses HealthResponse per server
- `atm-dashboard/src/pages/MetricsPage.tsx` — uses MetricsResponse
- `atm-dashboard/src/pages/FleetPage.tsx` — fleet cards

## WEK-502: Dashboard URL routing

### The Bug
Tab and machine selection is React state only. URL stays at `/dashboard` regardless of what you're viewing. Can't bookmark or share a specific view.

### Implementation

Read `atm-dashboard/src/App.tsx` (lines 30-64 for state management).

Use `URLSearchParams` + `history.replaceState` (NO React Router — it's overkill for this SPA):

1. On mount: read `?tab=` and `?machine=` from `window.location.search`, use as initial state
2. When tab or machine changes: call `history.replaceState(null, '', '?' + newParams.toString())`
3. URL patterns:
   - Fleet overview: `?tab=fleet`
   - Machine view: `?tab=overview&machine=gh-worker-1`
   - Machine sub-tabs: `?tab=metrics&machine=gh-worker-1`
   - Global tabs: `?tab=secrets` or `?tab=kamal` or `?tab=deploys` (no machine param)
4. Default (no params): same as `?tab=fleet`

Test: navigate around the dashboard, verify URL changes. Copy URL → paste in new tab → same view loads.

## Constraints
- Don't install any new npm packages — URLSearchParams is built-in
- Fleet proxy must handle GH being unreachable gracefully (return degraded, not crash)
- All GET endpoints stay unauthenticated
- Run `bun test` in atm-api after changes
- Run `bun run build` in atm-dashboard to verify it compiles
- Commit with format: `fix(atm): WEK-501 WEK-502 fleet proxy health aggregation + dashboard URL routing`
```

---

## After All 3 Sessions Complete

Come back to any session and run Phase 2 tickets, or do integration testing:

```
All 3 P0 epics are done. Let's verify integration:
1. curl the ATM fleet proxy and check the health response shape
2. Check the dashboard visually
3. Verify VALET typecheck passes with the new routing code
```
