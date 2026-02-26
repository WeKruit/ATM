# Phase 2 Session Prompts — Fleet Enablement

---

## Session 1: GHOST-HANDS

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/GHOST-HANDS`

```
You are the engineering team leader for GHOST-HANDS Phase 2 fleet work. Read CLAUDE.md and follow its required reading chain. Then read `../ATM/docs/MULTI-EC2-FLEET-PLAN.md` for full context.

## Goal

Write integration tests proving GH workers are fleet-safe: N workers on N EC2s sharing one pg-boss queue, with graceful drain and deregistration.

## Use Team Swarming

Spin up 2 agents in parallel — these tickets are independent:

### Agent 1: WEK-303 — Multi-worker queue coexistence test

Create `tests/integration/multi-worker-queue.test.ts`.

Read these files first to understand the patterns:
- `packages/ghosthands/src/workers/main.ts` — worker boot, pg-boss setup, heartbeat registration, job pickup loop
- `packages/ghosthands/src/db/queries/worker-registry.ts` or wherever `gh_worker_registry` INSERT/UPDATE lives
- `packages/ghosthands/src/db/queries/job-pickup.ts` or wherever `gh_pickup_next_job()` SQL lives
- Existing integration tests in `tests/integration/` for test patterns + DB setup

Test scenarios (mock pg-boss, don't need real Supabase):
1. **Two workers register** — both INSERT into `gh_worker_registry` with different `worker_id` and `ec2_ip`. Verify 2 rows exist, different IPs.
2. **Concurrent heartbeats** — both workers heartbeat simultaneously. Verify no conflicts, both `last_heartbeat` updated.
3. **Job distribution** — 3 jobs in queue, 2 workers polling. Verify each worker picks jobs (not all going to one). Use `pg-boss`'s `fetch()` or the `gh_pickup_next_job` function.
4. **Worker isolation** — deregister worker-1. Verify worker-2 still picks jobs. Verify worker-1's row is marked offline but worker-2's is untouched.
5. **N=1 regression** — single worker picks all 3 jobs. Proves single-worker case still works.

### Agent 2: WEK-304 — Graceful drain + deregistration end-to-end test

Create `tests/integration/drain-deregister.test.ts`.

Read these files first:
- `packages/ghosthands/src/workers/main.ts` — find the drain handler (POST /worker/drain) and the shutdown/deregister logic
- `packages/ghosthands/src/api/routes/valet.ts` — find deregister endpoint (POST /api/v1/gh/valet/workers/deregister)
- The worker HTTP server section in main.ts (~line 409-480) for all worker endpoints

Test scenarios:
1. **Drain while idle** — POST /worker/drain → worker status becomes "draining" → no new jobs picked from queue → worker enters draining state
2. **Drain while busy** — worker has an active job → POST /worker/drain → worker finishes current job → THEN goes to draining → no new jobs picked
3. **Deregister** — POST deregister endpoint → worker marked offline in `gh_worker_registry` → verify callbacks sent for any active jobs with cancellation status
4. **Drain → deregister sequence** — drain first, wait for idle, then deregister. Verify clean shutdown.
5. **Deploy safety** — while draining, `/worker/health` returns `{ deploy_safe: false }`. After drain completes and no active jobs, returns `{ deploy_safe: true }`.

## Constraints
- Both test files must work with `bun test`
- Use the same test patterns/helpers as existing integration tests in the repo
- Mock the database and pg-boss — don't require live Supabase
- Tests must pass at N=1 too (single worker)
- Don't modify any production code — test-only changes
- Run `bun test` at the end — all 998+ existing unit tests must still pass alongside new ones
- Commit: `test(gh): WEK-303 WEK-304 multi-worker queue coexistence and drain integration tests`
```

---

## Session 2: VALET

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/VALET`

```
You are the engineering team leader for VALET Phase 2 fleet work. Read CLAUDE.md and follow its required reading chain. Then read `../ATM/docs/MULTI-EC2-FLEET-PLAN.md` (Epic 2) for full context.

## Goal

Complete fleet enablement: monitoring endpoints accept per-worker routing, startup validator allows fleet mode without GHOSTHANDS_API_URL, and worker admin routes pass workerId for targeted routing.

## Use Team Swarming

Spin up 3 agents in parallel — all tickets are independent:

### Agent 1: WEK-404 + WEK-405 — Monitoring routes + startup validator

**WEK-404:** Read `apps/api/src/modules/ghosthands/ghosthands.monitoring.ts` (128 lines).

Find the worker-status and worker-health GET endpoints. Add optional `?workerId=` query parameter support:

```typescript
// Pseudocode for each endpoint:
const workerId = request.query.workerId as string | undefined;
const result = await ghosthandsClient.getWorkerStatus(workerId); // already accepts optional workerId from WEK-402
```

- If `?workerId=xxx` is provided, the client routes to that specific worker's EC2
- If no workerId, behaves exactly as before (any-healthy routing)
- Both endpoints need this treatment

**WEK-405:** Read `apps/api/src/plugins/startup-validator.ts` (175 lines).

Find where `GHOSTHANDS_API_URL` is checked. Change it from a hard failure to a warning:

```typescript
// Before: throw or return error if GHOSTHANDS_API_URL missing
// After: log.warn('GHOSTHANDS_API_URL not set — fleet mode will resolve from DB')
```

Fleet mode uses `gh_worker_registry.ec2_ip` from the database for all routing. The env var is only needed as a local dev fallback. The startup validator should NOT block app boot when it's missing.

### Agent 2: WEK-407 — Worker admin routes fleet context

Read `apps/api/src/modules/ghosthands/worker.admin-routes.ts` (127 lines).

Find `GET /api/v1/admin/workers` and `GET /api/v1/admin/workers/:workerId`. These call `ghosthandsClient.getWorkerStatus()` and `ghosthandsClient.getWorkerHealth()`.

Update them to pass the `workerId` param through:
- `GET /api/v1/admin/workers/:workerId` — extract `workerId` from route params, pass to `getWorkerStatus(workerId)` and `getWorkerHealth(workerId)`. This ensures the request goes to the EC2 where that specific worker lives.
- `GET /api/v1/admin/workers` — no change needed (lists all, any-healthy routing is fine)

Also check if there are any drain/deregister endpoints in this file — if so, update them to accept and pass workerId too.

### Agent 3: WEK-408 — Docs update

Read `.env.example` — find the `GHOSTHANDS_API_URL` entry. Add a comment:
```
# GHOSTHANDS_API_URL — Optional in fleet mode (resolves from gh_worker_registry).
# Only needed for local dev or single-EC2 fallback.
# GHOSTHANDS_API_URL=http://localhost:3100
```

Read `docs/CURRENT-STATE.md` — find any mention of GHOSTHANDS_API_URL being required. Update to say it's optional when sandboxes are configured in the database.

## Constraints
- No changes to ghosthands.client.ts — the routing methods (getWorkerStatus(workerId?), etc.) were already added in WEK-402
- No changes to sandbox.repository.ts — findWorkerIp() was already added in WEK-401
- Run `pnpm typecheck` — all 12 packages must pass
- Run `pnpm test` — all 717+ tests must pass
- Commit: `feat(valet): WEK-404 WEK-405 WEK-407 WEK-408 fleet monitoring routes and startup validator`
```

---

## Session 3: ATM

**Open in:** `cd ~/Desktop/WeKruit/VALET\ \&\ GH/ATM`

```
You are the engineering team leader for ATM Phase 2 fleet work. Read CLAUDE.md. Then read `docs/MULTI-EC2-FLEET-PLAN.md` (Epic 3) for full context.

## Goal

Three things: (1) fix the broken Kamal deploy button, (2) make fleet config dynamic for N EC2s, (3) prepare Kamal multi-host deploy config. The end state: adding a new EC2 means adding one IP to one config file and the entire system adapts — dashboard, proxy, deploys, secrets.

## Use Team Swarming

Spin up 3 agents in parallel:

### Agent 1: Fix Kamal deploy button + deploy page UX

The "Deploy via Kamal" button in `atm-dashboard/src/pages/KamalPage.tsx` is broken — it sets `showStream(true)` which opens a `LogStream` to `/deploy/stream`, but NEVER actually POSTs to `/deploy/kamal` to trigger the deploy. The SSE stream just sits there with no data.

The flow should be:
1. User clicks "Deploy via Kamal"
2. Dashboard POSTs to `/deploy/kamal` with `X-Deploy-Secret` header and `{destination, version}` body
3. Simultaneously opens the SSE stream at `/deploy/stream` to show live logs
4. On POST response (success/failure), update UI accordingly
5. On SSE complete event, refresh status

Read these files:
- `atm-dashboard/src/pages/KamalPage.tsx` — the deploy button (line 149) and LogStream usage (line 193)
- `atm-dashboard/src/components/LogStream.tsx` — SSE EventSource component, understands `{type:"log",line}` and `{type:"complete",success}` events
- `atm-dashboard/src/api.ts` — `post()` helper that accepts path, body, secret, base
- `atm-api/src/server.ts` line 1173 — `POST /deploy/kamal` handler (requires X-Deploy-Secret)
- `atm-api/src/server.ts` line 1116 — `GET /deploy/stream` SSE handler

Implementation:
- Add deploy secret input to the Kamal page (like SecretsPage.tsx does — use sessionStorage for persistence). Read `atm-dashboard/src/pages/SecretsPage.tsx` lines 16, 41-44, 131-163 for the pattern.
- Add destination selector (dropdown: staging/production)
- onClick: POST to `/deploy/kamal` with `{destination, version: destination}` AND open SSE stream
- Handle POST errors (401 unauthorized, 409 deploy in progress)
- On success/failure, update deploying state

Also add a Rollback button that POSTs to `/rollback/kamal` with same auth pattern.

### Agent 2: WEK-504 — Dynamic fleet config for N EC2s

Currently `fleet.json` has hardcoded entries and the server.ts fleet proxy only handles routes matching known server IDs. Make it truly dynamic.

Read these files:
- `atm-dashboard/public/fleet.json` — current static config (2 entries: atm-gw1 + gh-worker-1)
- `atm-api/src/server.ts` — the fleet proxy handler (~line 587-730) and the GET /fleet endpoint

Changes to `atm-api/src/server.ts`:
1. On startup, load fleet config from `fleet.json` (already happens) OR from env var `FLEET_CONFIG` (JSON string)
2. The `GET /fleet` endpoint should return the full servers array dynamically
3. The fleet proxy at `/fleet/:serverId/*` should look up the server by ID from the loaded config, get its IP, and route accordingly. Currently it may have hardcoded IP lookups — make it fully dynamic from the config.
4. Add a `POST /fleet/reload` endpoint (authenticated) that reloads fleet.json from disk without restart

Changes to `atm-dashboard/public/fleet.json`:
- Add a comment/note field explaining the format
- Make sure adding a new entry like `{"id": "gh-worker-2", "name": "GH Worker 2", "host": "/fleet/gh-worker-2", "ip": "10.0.0.2", ...}` would automatically:
  - Show up in the Fleet Overview dashboard page
  - Be routable via `/fleet/gh-worker-2/health` etc.
  - No code changes needed — just config

### Agent 3: WEK-505 — Multi-host Kamal deploy config

Read these files:
- `config/deploy.yml` — base Kamal config (servers.web.hosts and servers.workers.hosts are empty arrays — filled by destination overrides)
- `config/deploy.staging.yml` — staging override (hosts: [44.223.180.11] for both web and workers)
- `config/deploy.production.yml` — production override (hosts: [] — empty, not yet configured)
- `atm-api/src/kamal-runner.ts` — the kamalDeploy() function that runs `kamal deploy -d {destination}`

Current state: staging has 1 host IP. To add more EC2s, you just add IPs to the hosts arrays.

Changes:
1. Add a comment block to `config/deploy.staging.yml` explaining multi-host:
   ```yaml
   # To add a new GH EC2, append its IP to both web and workers hosts:
   # hosts:
   #   - 44.223.180.11    # gh-worker-1
   #   - 10.0.0.2          # gh-worker-2
   ```
2. Do the same for `config/deploy.production.yml`
3. Read `atm-api/src/kamal-runner.ts` and verify it doesn't have any single-host assumptions. Kamal v2 natively handles multi-host — just verify the runner passes through correctly.
4. Add a `GET /kamal/hosts` endpoint to `atm-api/src/server.ts` that reads the Kamal config YAML and returns the hosts list per role per destination. This lets the dashboard show which EC2s Kamal will deploy to.

## Constraints
- All GET endpoints stay unauthenticated (monitoring)
- All POST endpoints require X-Deploy-Secret
- Deploy secret is stored in sessionStorage on the dashboard (same pattern as SecretsPage)
- No new npm packages — use built-in fetch, EventSource, URLSearchParams
- Run `bun test` in atm-api — existing tests must pass
- Run `bun run build` in atm-dashboard — must compile clean
- Commit: `feat(atm): WEK-504 WEK-505 dynamic fleet config + multi-host Kamal + deploy button fix`

## Deployment

After committing, deploy to EC2:
```bash
# Sync and rebuild
rsync -avz -e "ssh -i ~/.ssh/wekruit-atm-server.pem" "atm-api/" ubuntu@34.195.147.149:/opt/atm/atm-api/ --exclude node_modules --exclude .env
rsync -avz -e "ssh -i ~/.ssh/wekruit-atm-server.pem" "atm-dashboard/" ubuntu@34.195.147.149:/opt/atm/atm-dashboard/ --exclude node_modules
rsync -avz -e "ssh -i ~/.ssh/wekruit-atm-server.pem" "config/" ubuntu@34.195.147.149:/opt/atm/config/
ssh -i ~/.ssh/wekruit-atm-server.pem ubuntu@34.195.147.149 "cd /opt/atm && docker compose up -d --build"
```

Then verify:
- http://atm-direct.wekruit.com:8000/dashboard?tab=kamal — deploy button works with secret
- http://atm-direct.wekruit.com:8000/fleet — returns all fleet members
- http://atm-direct.wekruit.com:8000/kamal/hosts — returns host IPs per destination
```
