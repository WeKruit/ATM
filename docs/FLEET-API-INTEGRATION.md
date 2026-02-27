# ATM Fleet API — Integration Guide for VALET QA

**ATM Base URL:** `https://atm-gw1.wekruit.com`
**Auth Header:** `X-Deploy-Secret: <secret>` (required for all POST endpoints)
**Deploy Secret:** Same value for staging — set via lock icon in ATM dashboard header, or stored in `GH_DEPLOY_SECRET` env var on EC2.

---

## Quick Reference

| Action | Method | Endpoint | Auth |
|--------|--------|----------|------|
| List fleet servers | GET | `/fleet` | No |
| Check idle status | GET | `/fleet/idle-status` | No |
| Wake specific worker | POST | `/fleet/:id/wake` | Yes |
| Stop specific worker | POST | `/fleet/:id/stop` | Yes |
| Wake N workers (bulk) | POST | `/fleet/wake` | Yes |
| Worker health (proxied) | GET | `/fleet/:id/health` | No |
| Worker metrics (proxied) | GET | `/fleet/:id/metrics` | No |
| Worker version (proxied) | GET | `/fleet/:id/version` | No |

---

## Current Fleet

| Server ID | Name | IP | Role | Environment | EC2 Instance |
|-----------|------|----|------|-------------|--------------|
| `atm-gw1` | ATM Server | 34.195.147.149 | atm | staging | i-0b369c07ccf903b92 |
| `gh-worker-1` | GH Worker 1 | 44.202.208.128 | ghosthands | staging | i-055ee8761f84cec1b |
| `gh-worker-2` | GH Worker 2 | 35.170.51.196 | ghosthands | staging | i-01a6dc03d22ceb6b0 |

> **Note:** Only `ghosthands` role servers can be woken/stopped. IPs may change after stop/start cycles.

---

## EC2 States

Workers cycle through these states:

```
stopped → (wake) → pending → running → (idle timeout or manual stop) → stopping → stopped
                                    ↕
                                 standby  (ASG standby — entered before stop, exited after wake)
```

| State | Meaning |
|-------|---------|
| `running` | EC2 up, GH containers active, accepting jobs |
| `stopped` | EC2 halted, no cost (except EBS) |
| `standby` | In ASG standby (ASG won't replace it), about to stop or just woke |
| `pending` | EC2 starting up |
| `stopping` | EC2 shutting down |
| `unknown` | State not yet determined (brief period on ATM restart) |

---

## Idle Monitor Behavior

- **Enabled:** `EC2_IDLE_ENABLED=true` on ATM
- **Timeout:** `EC2_IDLE_TIMEOUT_MS` (currently 5 min for testing, will be 30 min in prod)
- **Poll interval:** Every 60s, ATM checks each worker's `/worker/health`
- **Auto-stop flow:** No active jobs for timeout duration → enter ASG standby → stop EC2
- **Min running:** `EC2_MIN_RUNNING=0` (all workers can be stopped)

---

## Endpoint Details

### GET /fleet/idle-status

Returns current state of all workers. **Use this to check if workers are up before running tests.**

```bash
curl -s https://atm-gw1.wekruit.com/fleet/idle-status | jq
```

Response:
```json
{
  "enabled": true,
  "config": {
    "idleTimeoutMs": 300000,
    "minRunning": 0,
    "pollIntervalMs": 60000
  },
  "workers": [
    {
      "serverId": "gh-worker-1",
      "ip": "44.202.208.128",
      "instanceId": "i-055ee8761f84cec1b",
      "ec2State": "running",
      "activeJobs": 0,
      "idleSinceMs": 45000,
      "transitioning": false
    }
  ]
}
```

Key fields per worker:
- **ec2State** — Current EC2 lifecycle state
- **activeJobs** — Jobs running on this worker (from last poll)
- **idleSinceMs** — How long idle (ms). When this exceeds `idleTimeoutMs`, auto-stop triggers.
- **transitioning** — `true` if a start/stop operation is in progress

---

### POST /fleet/:id/wake

Starts a stopped worker. Full stack comes up: EC2 → Docker containers (auto-restart policy) → VNC/Kasm (entrypoint script).

```bash
curl -s -X POST https://atm-gw1.wekruit.com/fleet/gh-worker-1/wake \
  -H "X-Deploy-Secret: $SECRET" | jq
```

**Success (200):**
```json
{
  "status": "started",
  "serverId": "gh-worker-1",
  "instanceId": "i-055ee8761f84cec1b",
  "ip": "44.202.208.128",
  "exitedStandby": true
}
```

**Already running (200):**
```json
{ "status": "already_running", "serverId": "gh-worker-1" }
```

**Errors:**
- `401` — Bad secret
- `400` — Unknown server or non-GH role
- `409` — Instance is `stopping`, retry later

**Timing:** Wake takes ~60-90 seconds (EC2 boot + Docker container start + health check).
The endpoint polls internally and returns once the worker is healthy (or after 120s timeout).

---

### POST /fleet/:id/stop

Stops a running worker. Enters ASG standby first (prevents ASG replacement), then stops EC2.

```bash
curl -s -X POST https://atm-gw1.wekruit.com/fleet/gh-worker-1/stop \
  -H "X-Deploy-Secret: $SECRET" | jq
```

**Success (200):**
```json
{
  "status": "stopping",
  "serverId": "gh-worker-1",
  "instanceId": "i-055ee8761f84cec1b",
  "enteredStandby": true
}
```

**Errors:**
- `409` — Already stopped, transitioning, or has active jobs
  ```json
  { "error": "Worker has active jobs — drain first", "activeJobs": 2 }
  ```

---

### POST /fleet/wake (bulk)

Wake up to N stopped workers at once.

```bash
curl -s -X POST https://atm-gw1.wekruit.com/fleet/wake \
  -H "X-Deploy-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"count": 2}' | jq
```

---

### Proxied Endpoints (GET, no auth)

These proxy through ATM to the worker. **Returns instant offline response if worker is stopped/standby** (no timeout).

| Endpoint | Returns |
|----------|---------|
| `/fleet/:id/health` | Aggregate health (API + Worker status) |
| `/fleet/:id/metrics` | CPU, memory, disk usage |
| `/fleet/:id/version` | Build info, commit SHA, environment |
| `/fleet/:id/workers` | Worker array with job counts |
| `/fleet/:id/containers` | Docker container list |

Offline response (when stopped):
```json
{
  "status": "offline",
  "ec2State": "stopped",
  "activeWorkers": 0,
  "deploySafe": false,
  "apiHealthy": false,
  "workerStatus": "unreachable"
}
```

---

## QA Test Scenarios

### Infrastructure Lifecycle Tests

1. **Wake a stopped worker**
   - Check `/fleet/idle-status` → worker `ec2State: "stopped"`
   - POST `/fleet/:id/wake` → wait for `status: "started"`
   - GET `/fleet/:id/health` → `status: "healthy"`
   - Verify worker accepts jobs

2. **Stop a running worker**
   - Ensure no active jobs (`activeJobs: 0`)
   - POST `/fleet/:id/stop` → `status: "stopping"`
   - Poll `/fleet/idle-status` until `ec2State: "stopped"`
   - GET `/fleet/:id/health` → instant `status: "offline"` response

3. **Idle auto-stop**
   - Wake a worker, submit no jobs
   - Monitor `idleSinceMs` via `/fleet/idle-status`
   - After `idleTimeoutMs`, verify worker transitions to `stopping` → `stopped`

4. **Stop blocked by active jobs**
   - Submit a job to worker
   - POST `/fleet/:id/stop` → `409` with `activeJobs > 0`

5. **Wake already-running worker**
   - POST `/fleet/:id/wake` → `status: "already_running"` (idempotent, no error)

6. **Concurrent wake/stop prevention**
   - Start a wake operation
   - Immediately try to stop → `409` (transitioning)

### QA Setup/Teardown Pattern

```typescript
// Before test suite: ensure at least 1 worker is running
async function ensureWorkerUp(serverId: string): Promise<string> {
  const status = await fetch(`${ATM_URL}/fleet/idle-status`).then(r => r.json());
  const worker = status.workers.find(w => w.serverId === serverId);

  if (worker?.ec2State === 'running') return worker.ip;

  // Wake it
  const res = await fetch(`${ATM_URL}/fleet/${serverId}/wake`, {
    method: 'POST',
    headers: { 'X-Deploy-Secret': SECRET },
  }).then(r => r.json());

  if (res.status === 'started' || res.status === 'already_running') {
    return res.ip;
  }
  throw new Error(`Failed to wake ${serverId}: ${JSON.stringify(res)}`);
}

// After test suite: let idle monitor handle shutdown (no manual stop needed)
// Workers auto-stop after 30min idle
```

---

## Environment Variables (ATM API)

| Variable | Default | Description |
|----------|---------|-------------|
| `EC2_IDLE_ENABLED` | `false` | Enable idle auto-stop |
| `EC2_IDLE_TIMEOUT_MS` | `300000` (5min) | Idle duration before auto-stop |
| `EC2_MIN_RUNNING` | `0` | Minimum workers to keep alive |
| `EC2_POLL_INTERVAL_MS` | `60000` (1min) | Health check polling interval |
| `ATM_DEPLOY_SECRET` / `GH_DEPLOY_SECRET` | Required | Auth secret for POST endpoints |

---

*Last updated: 2026-02-27*
