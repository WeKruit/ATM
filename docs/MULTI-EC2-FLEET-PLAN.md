# Multi-EC2 Fleet Architecture: 3 Epics Across VALET, ATM, GHOST-HANDS

**Created:** 2026-02-25
**Status:** P0 + P1 complete — deployed to staging 2026-02-26

### TODO: ATM Dashboard Access (Option B — Security Hardening)
- Currently: `atm-direct.wekruit.com:8000` bypasses Cloudflare (DNS-only, grey cloud)
- Goal: Route through Cloudflare proxy for DDoS protection + HTTPS
- Plan: Switch ATM to listen on port **8080** (Cloudflare-supported) or add nginx reverse proxy 8080→8000
- Then flip `atm-gw1.wekruit.com` back to orange cloud (proxied)
- Adds: HTTPS termination, DDoS protection, rate limiting via Cloudflare

---

## Integration Architecture — Full Picture

```
                    ┌──────────────────────────────┐
                    │         VALET (Fly.io)         │
                    │  User app + Admin dashboard    │
                    └──────┬───────────┬────────────┘
                           │           │
              Job dispatch │           │ Fleet health / Admin UI
              (pg-boss +   │           │ (deploys, secrets, drain)
               REST API)   │           │
                           │           │
               ┌───────────▼──┐   ┌────▼────────────────┐
               │  Shared DB   │   │    ATM (EC2:8000)    │
               │  (Supabase)  │   │  Fleet mgr / CI-CD   │
               │              │   └────┬────────┬────────┘
               │ gh_auto_jobs │        │        │
               │ gh_worker_reg│   Kamal │   Fleet│ proxy
               │ gh_job_events│   SSH   │   /fleet/:id/*
               │ sandboxes    │        │        │
               └──────────────┘   ┌────▼────────▼────────┐
                                  │  GH EC2 #1 (:3100/01) │
                                  │  API + Worker          │
                                  └────────────────────────┘
                                  ┌────────────────────────┐
                                  │  GH EC2 #2 (future)    │
                                  │  API + Worker          │
                                  └────────────────────────┘
```

### Data Flows

| Flow | Path | Protocol | Today | Multi-EC2 Change |
|------|------|----------|-------|-----------------|
| **Job submit** | VALET → pg-boss → GH Worker | pg-boss queue | Workers pull from shared queue | No change — workers self-select |
| **Job submit (REST)** | VALET → GH API:3100 | HTTP POST | `resolveHealthyIp()` → first healthy sandbox | Use `resolveApiUrlForJob()` for targeted ops |
| **Cancel/Resume** | VALET → GH API:3100 | HTTP POST | Routes to any GH API | **Must route to EC2 holding the job's worker** |
| **Callbacks** | GH Worker → VALET webhook | HTTP POST | `callback_url` per job | No change — URL is VALET's fixed endpoint |
| **Worker registration** | GH Worker → Supabase | SQL INSERT/UPDATE | Auto-registers with `ec2_ip` | No change — each worker registers its own IP |
| **Health probing** | ATM → GH API + Worker | HTTP GET | Polls single EC2 | ATM polls all EC2s, aggregates in `/fleet` |
| **Fleet health sync** | ATM → VALET DB | ATM `/fleet` → VALET polls | VALET queries sandboxes directly | VALET polls ATM `/fleet`, caches in sandboxes table |
| **Deploy** | ATM → GH EC2 | Kamal SSH | Single destination host | Kamal config lists N hosts |
| **Secrets** | ATM → Infisical → Kamal | REST API + file write | Per-environment, not per-host | No change |
| **Dashboard proxy** | Browser → ATM → GH | HTTP proxy | `/fleet/gh-worker-1/*` | `/fleet/:id/*` routes to any EC2 |

### Shared Database Tables (Integration Surface)

| Table | Written by | Read by | Purpose |
|-------|-----------|---------|---------|
| `gh_automation_jobs` | VALET (create), GH (status updates) | Both | Job lifecycle, workerId tracking |
| `gh_worker_registry` | GH workers (heartbeat) | VALET (routing), ATM (fleet) | Worker → EC2 IP mapping |
| `gh_job_events` | GH (progress tracker) | VALET (progress display) | Immutable audit log |
| `sandboxes` | VALET admin | VALET (routing), ATM (fleet config) | EC2 instance registry |

### What Already Works for N EC2s (Zero Changes)

- pg-boss queue routing — workers pull jobs, VALET doesn't route submissions
- `gh_pickup_next_job()` SQL — handles `target_worker_id` filtering
- Worker heartbeat — auto-registers in `gh_worker_registry` with `ec2_ip`
- Callback flow — `callback_url` is VALET's fixed URL, works from any EC2
- Kamal multi-host — `config/deploy.yml` lists hosts, just add more IPs
- VALET sandbox model — `sandboxes` table supports N rows with `publicIp`, `healthStatus`

---

## Epic 1: GHOST-HANDS — Fleet-Ready Worker Infrastructure

**Repo:** `WeKruit/GHOST-HANDS`
**WEK ticket prefix:** WEK-3xx

### Context & Problem

GH workers are designed for single-EC2 operation but already have the primitives for multi-EC2 (worker registration with `ec2_ip`, pg-boss queue, callback URLs). However, three gaps exist:

1. **No build traceability** — Docker images don't bake `COMMIT_SHA` at build time, so `/health/version` returns "unknown" — ATM dashboard can't show which code is running
2. **Health response format mismatch** — ATM proxy forwards raw GH responses, but the dashboard expects `{deploySafe, apiHealthy, workerStatus}`. GH returns `{status, service, version}`. This is an ATM problem to solve (see Epic 3), but GH should expose a richer health shape.
3. **No fleet-awareness verification** — Never tested 2+ workers on separate EC2s pulling from the same pg-boss queue simultaneously

### Solution

Minimal GH changes — mostly verification and build improvements.

### Sub-Issues

#### WEK-301: Bake COMMIT_SHA into Docker image
**Type:** enhancement | **Priority:** P1 | **Estimate:** S

- Modify `Dockerfile` to accept `COMMIT_SHA`, `BUILD_TIME`, `IMAGE_TAG` build args and set as ENV
- Modify GitHub Actions workflow to pass `--build-arg COMMIT_SHA=$(git rev-parse HEAD)`
- Verify `/health/version` returns correct commit_sha after deploy

**Files:**
- `Dockerfile` (build args → ENV)
- `.github/workflows/build-and-push.yml` (pass build args)
- `packages/ghosthands/src/api/routes/health.ts` (verify reads process.env.COMMIT_SHA)

#### WEK-302: Standardize worker health response for fleet proxy
**Type:** enhancement | **Priority:** P1 | **Estimate:** S

- Add `deploy_safe` field to `/worker/health` response (already exists per exploration: `{status, active_jobs, deploy_safe}`)
- Add `api_healthy` field to `/health` response (self-check: can reach DB?)
- Document exact response shapes in `docs/API-CONTRACTS.md`

**Files:**
- `packages/ghosthands/src/workers/main.ts` (worker HTTP endpoints, ~line 409-480)
- `packages/ghosthands/src/api/routes/health.ts` (add `api_healthy` field)
- New: `docs/API-CONTRACTS.md` (response shapes for ATM integration)

#### WEK-303: Verify multi-worker queue coexistence
**Type:** test | **Priority:** P1 | **Estimate:** M

- Write integration test: 2 workers, 3 jobs, verify each worker picks exactly its share
- Verify `gh_worker_registry` has 2 rows with different `ec2_ip`
- Verify deregistering one worker doesn't affect the other
- Verify concurrent heartbeats don't conflict

**Files:**
- New: `tests/integration/multi-worker-queue.test.ts`
- `packages/ghosthands/src/workers/main.ts` (reference for registration logic)

#### WEK-304: Graceful drain + deregistration end-to-end test
**Type:** test | **Priority:** P2 | **Estimate:** S

- Test: `POST /worker/drain` → worker finishes current job → status becomes "draining" → no new jobs picked
- Test: `POST /api/v1/gh/valet/workers/deregister` → worker marked offline → active jobs cancelled → callbacks sent
- Verify drain works while job is mid-execution

**Files:**
- New: `tests/integration/drain-deregister.test.ts`
- `packages/ghosthands/src/workers/main.ts`
- `packages/ghosthands/src/api/routes/valet.ts` (deregister endpoint)

---

## Epic 2: VALET — Fleet-Aware Job Routing

**Repo:** `WeKruit/VALET`
**WEK ticket prefix:** WEK-4xx

### Context & Problem

`GhostHandsClient` uses `resolveHealthyIp()` which picks the FIRST healthy sandbox and routes ALL requests there. This works at N=1 but breaks at N>1:

- `cancelJob(jobId)` routes to random EC2, not the one executing the job
- `resumeJob(jobId)` same — HITL resolution data must reach the correct worker
- `getWorkerStatus()` / `drainWorker()` only check one worker
- `GHOSTHANDS_API_URL` can only point to one IP

**Data already in DB that enables routing:**
- `gh_automation_jobs.workerId` → which GH worker has the job
- `gh_worker_registry.ec2_ip` → which EC2 that worker lives on
- `sandboxes.publicIp` → which EC2 instances are healthy

### Solution

Three routing strategies in GhostHandsClient:

| Strategy | Methods | Resolution |
|----------|---------|-----------|
| **Job-targeted** | cancel, resume, retry, getJobStatus | `gh_automation_jobs.workerId` → `gh_worker_registry.ec2_ip` |
| **Any-healthy** | submit, healthCheck, getModels, sessions, fleet | Existing `resolveHealthyIp()` (no change) |
| **Worker-specific** | getWorkerStatus, getWorkerHealth, drainWorker | Explicit `workerId` param → `gh_worker_registry.ec2_ip` |

### Sub-Issues

#### WEK-401: Add findWorkerIp() to SandboxRepository
**Type:** enhancement | **Priority:** P0 | **Estimate:** S

```typescript
async findWorkerIp(workerId: string): Promise<string | null> {
  const rows = await this.db.execute(
    sql`SELECT ec2_ip FROM gh_worker_registry
        WHERE worker_id = ${workerId}
          AND status IN ('active', 'draining')
          AND ec2_ip IS NOT NULL
        ORDER BY last_heartbeat DESC LIMIT 1`
  );
  return rows[0]?.ec2_ip ?? null;
}
```

**Files:**
- `apps/api/src/modules/sandboxes/sandbox.repository.ts`

#### WEK-402: Fleet-aware GhostHandsClient routing
**Type:** enhancement | **Priority:** P0 | **Estimate:** L

- Add GhAutomationJobRepository dependency via late-bind setter
- Private resolution methods: `resolveWorkerIpForJob(jobId)`, `resolveWorkerIpById(workerId)`, `resolveApiUrlForJob(jobId)`, `resolveWorkerUrlById(workerId)`
- Targeted request methods alongside existing generic ones
- Refactor cancel/resume/retry/getJobStatus to use job-targeted routing
- Refactor getWorkerStatus/getWorkerHealth/drainWorker to accept optional workerId

**Files:**
- `apps/api/src/modules/ghosthands/ghosthands.client.ts` (major refactor)

#### WEK-403: Wire GhJobRepository into DI container
**Type:** enhancement | **Priority:** P0 | **Estimate:** S

Add `client.setGhJobRepository(ghJobRepo)` alongside existing `client.setSandboxRepository(sandboxRepo)`.

**Files:**
- `apps/api/src/plugins/container.ts`

#### WEK-404: Update monitoring routes with optional workerId
**Type:** enhancement | **Priority:** P1 | **Estimate:** S

Update worker-status and worker-health endpoints to accept `?workerId=` query param.

**Files:**
- `apps/api/src/modules/ghosthands/ghosthands.monitoring.ts`

#### WEK-405: Downgrade GHOSTHANDS_API_URL startup check
**Type:** enhancement | **Priority:** P1 | **Estimate:** S

Change from fail → warn. Fleet mode uses DB resolution; env var is optional fallback.

**Files:**
- `apps/api/src/plugins/startup-validator.ts`

#### WEK-406: Fleet health sync from ATM
**Type:** enhancement | **Priority:** P1 | **Estimate:** M

Periodic task (every 30s) polls ATM `/fleet` endpoint and updates `sandboxes` table health fields.

**Files:**
- `apps/api/src/modules/sandboxes/sandbox-health-monitor.ts`
- `apps/api/src/modules/sandboxes/sandbox.repository.ts`

#### WEK-407: Update worker admin routes for fleet context
**Type:** enhancement | **Priority:** P1 | **Estimate:** S

Pass workerId to GH client for targeted routing when fetching worker details.

**Files:**
- `apps/api/src/modules/ghosthands/worker.admin-routes.ts`

#### WEK-408: Mark GHOSTHANDS_API_URL as optional in docs
**Type:** docs | **Priority:** P2 | **Estimate:** S

**Files:**
- `.env.example`
- `docs/CURRENT-STATE.md`

---

## Epic 3: ATM — Fleet Management & Dashboard

**Repo:** `WeKruit/ATM`
**WEK ticket prefix:** WEK-5xx

### Context & Problem

1. **Degraded health display** — proxy forwards raw GH response but dashboard expects different shape → shows "Degraded"
2. **No URL routing** — tab/machine state is React-only, URL stays `/dashboard`
3. **Orphaned containers** — 3 old docker-compose containers on GH EC2
4. **Single-host fleet config** — only knows about 1 GH EC2

### Sub-Issues

#### WEK-501: Fix fleet proxy health aggregation
**Type:** bug | **Priority:** P0 | **Estimate:** M

Modify fleet proxy to intercept GH endpoints and transform responses into dashboard-compatible shapes:

| Proxy path | Dashboard type |
|-----------|---------------|
| `/fleet/:id/health` | `{status, deploySafe, apiHealthy, workerStatus, activeWorkers, uptimeMs}` |
| `/fleet/:id/version` | `{deployServer, version, ghosthands, uptimeMs}` |
| `/fleet/:id/workers` | `Worker[]` |
| `/fleet/:id/metrics` | `{cpu, memory, disk}` with zeros |
| `/fleet/:id/containers` | `Container[]` empty |
| `/fleet/:id/deploys` | `Deploy[]` empty |

**GH source endpoints:**
- API:3100 `/health` → `{status, service, version, environment, commit_sha, timestamp}`
- Worker:3101 `/worker/health` → `{status, active_jobs, deploy_safe}`
- Worker:3101 `/worker/status` → `{worker_id, ec2_instance_id, ec2_ip, active_jobs, max_concurrent, is_running, is_draining, uptime_ms}`

**Files:**
- `atm-api/src/server.ts` (~line 591-634)

#### WEK-502: Dashboard URL routing with URLSearchParams
**Type:** enhancement | **Priority:** P0 | **Estimate:** S

Use `URLSearchParams` + `history.replaceState`:
- Read `?tab=` and `?machine=` on mount
- Update URL on tab/machine change
- Copy URL → paste → same view loads

**Files:**
- `atm-dashboard/src/App.tsx`

#### WEK-503: Clean up orphaned containers on GH EC2
**Type:** ops | **Priority:** P0 | **Estimate:** S

Manual SSH cleanup on 44.223.180.11.

#### WEK-504: Dynamic fleet configuration for N EC2s
**Type:** enhancement | **Priority:** P1 | **Estimate:** M

Replace hardcoded `gh-worker-1` with dynamic fleet config.

**Files:**
- `atm-api/src/server.ts`
- `atm-dashboard/public/fleet.json`

#### WEK-505: Multi-host Kamal deploy config
**Type:** enhancement | **Priority:** P1 | **Estimate:** S

Update Kamal config to support multiple host IPs.

**Files:**
- `config/deploy.staging.yml`
- `config/deploy.production.yml`

#### WEK-506: Parallel Kamal deploy option
**Type:** enhancement | **Priority:** P2 | **Estimate:** M

Add `?parallel=true` option to `POST /deploy/kamal`.

**Files:**
- `atm-api/src/kamal-runner.ts`
- `atm-api/src/server.ts`

#### WEK-507: Fleet auto-discovery from Kamal config
**Type:** enhancement | **Priority:** P2 | **Estimate:** M

Read host IPs from Kamal YAML instead of separate fleet.json.

**Files:**
- `atm-api/src/server.ts`

---

## Cross-Epic Dependencies

```
                    WEK-302 (GH health shapes)
                         │ nice-to-have
                         ▼
WEK-501 (ATM proxy) ◄── transforms either way
                         │
                         ▼
                    WEK-406 (VALET fleet sync)
                         │ depends on ATM /fleet
                         ▼
                    WEK-402 (VALET fleet routing)
                         │ uses gh_worker_registry
```

**All 3 epics can run in parallel** — integration testing after P0 tickets are done.

---

## Execution Phases

### Phase 1: P0 Fixes (parallel)

| Team | Tickets |
|------|---------|
| GH | WEK-301, WEK-302 |
| VALET | WEK-401, WEK-402, WEK-403 |
| ATM | WEK-501, WEK-502, WEK-503 |

### Phase 2: P1 Fleet Enablement (parallel)

| Team | Tickets |
|------|---------|
| GH | WEK-303, WEK-304 |
| VALET | WEK-404, WEK-405, WEK-406, WEK-407 |
| ATM | WEK-504, WEK-505 |

### Phase 3: P2 Scaling (parallel)

| Team | Tickets |
|------|---------|
| VALET | WEK-408 |
| ATM | WEK-506, WEK-507 |

### Phase 4: Integration Verification (sequential)

1. Deploy all three to staging
2. Run VALET integration tests (cancel, resume, health probe)
3. ATM dashboard shows all fleet members correctly
4. Test with `GHOSTHANDS_API_URL` unset — pure DB routing
