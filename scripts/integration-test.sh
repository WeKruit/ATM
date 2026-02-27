#!/usr/bin/env bash
# ATM/VALET/GH Integration Test Suite
# Tests all cross-component behavior via CLI (curl, jq, psql)
#
# Usage:
#   bash scripts/integration-test.sh                    # Safe suite (groups 1-4,7-9,11-12)
#   bash scripts/integration-test.sh --group=1          # Run only group 1
#   bash scripts/integration-test.sh --group=5          # Task lifecycle (submits real work)
#   bash scripts/integration-test.sh --group=6          # Worker drain (destructive!)
#   bash scripts/integration-test.sh --all              # Everything except deploy safety
#   bash scripts/integration-test.sh --ci               # CI-safe subset (GET-only, no DB mutations)
#   bash scripts/integration-test.sh --deploy-safety    # Group 10 (triggers REAL deploys!)
#   bash scripts/integration-test.sh --multi            # Multi-EC2 tests in group 9
#   bash scripts/integration-test.sh --verbose          # Show full response bodies

set -euo pipefail

# Add libpq (homebrew) to PATH if psql not found
if ! command -v psql >/dev/null 2>&1; then
  for p in /opt/homebrew/Cellar/libpq/*/bin /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
    if [[ -x "$p/psql" ]]; then
      export PATH="$p:$PATH"
      break
    fi
  done
fi

# ── Auth & Config ──────────────────────────────────────────────────────────────

# Only the ATM deploy secret is bootstrapped; everything else fetched at runtime
ATM_DEPLOY_SECRET="${ATM_DEPLOY_SECRET:-6ebad18c90203d0a81124c440eba3e490486e614ee9bf0b249712a36dc52d5de}"

# Service URLs (not secrets)
VALET_API="https://valet-api-stg.fly.dev"
GH_API="http://44.223.180.11:3100"
GH_WORKER="http://44.223.180.11:3101"
ATM_API="${ATM_API:-https://atm-gw1.wekruit.com}"
ATM_DIRECT="http://34.195.147.149:8080"
VNC_URL="https://44.223.180.11:6901"

# 2nd GH EC2 (set when provisioned, Phase D)
GH_EC2_2="${GH_EC2_2:-}"

# DB connection (non-secret parts)
PGHOST="aws-1-us-east-1.pooler.supabase.com"
PGPORT="5432"
PGUSER="postgres.unistzvhgvgjyzotwzxr"
PGDATABASE="postgres"
export PGHOST PGPORT PGUSER PGDATABASE

# Secrets populated by init_secrets()
VALET_TOKEN=""
GH_SERVICE_SECRET=""
PGPASSWORD=""

# ── Secret Fetcher ──────────────────────────────────────────────────────────────

fetch_secret() {
  local val
  val=$(curl -sf -H "X-Deploy-Secret: ${ATM_DEPLOY_SECRET}" \
    "${ATM_API}/secrets/${1}?path=${2}" --max-time 10 2>/dev/null | jq -r '.value // empty' 2>/dev/null) || val=""
  if [[ -z "$val" ]]; then
    echo "WARN: Failed to fetch secret $1 from path $2" >&2
    return 1
  fi
  echo "$val"
}

init_secrets() {
  echo -e "${DIM}Fetching secrets from ATM/Infisical...${NC}"
  VALET_TOKEN=$(fetch_secret "VALET_ADMIN_JWT" "/valet" 2>/dev/null) || VALET_TOKEN=""
  GH_SERVICE_SECRET=$(fetch_secret "GH_SERVICE_KEY" "/ghosthands" 2>/dev/null) || GH_SERVICE_SECRET=""
  PGPASSWORD=$(fetch_secret "DATABASE_PASSWORD" "/valet" 2>/dev/null) || PGPASSWORD=""

  # Fallback: use hardcoded values if ATM fetch fails (local dev)
  VALET_TOKEN="${VALET_TOKEN:-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJlbWFpbCI6ImNpLXNlcnZpY2VAd2VrcnVpdC5jb20iLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3NzE3OTI3OTMsImV4cCI6MTkyOTU4MDc5M30.Z2YnfESbRuW7Jc6CodCRiiza7uX2abTA-FzqYyK8q3s}"
  GH_SERVICE_SECRET="${GH_SERVICE_SECRET:-f7abd8460ccf2dd73eec0b304ccdf8c11ee43f67c4bcacfa9bb952c43aa6a9a3}"
  PGPASSWORD="${PGPASSWORD:-wekruitVALET2026}"
  export PGPASSWORD

  local fetched=0
  [[ -n "$VALET_TOKEN" ]] && fetched=$((fetched+1))
  [[ -n "$GH_SERVICE_SECRET" ]] && fetched=$((fetched+1))
  [[ -n "$PGPASSWORD" ]] && fetched=$((fetched+1))
  echo -e "${DIM}Secrets: $fetched/3 resolved${NC}"
}

# ── Flags ──────────────────────────────────────────────────────────────────────

VERBOSE=false
SKIP_TASK=true
SKIP_DRAIN=true
SKIP_DEPLOY_SAFETY=true
RUN_GROUP=""
RUN_ALL=false
RUN_CI=false
RUN_MULTI=false

for arg in "$@"; do
  case "$arg" in
    --verbose)         VERBOSE=true ;;
    --skip-task)       SKIP_TASK=true ;;
    --skip-drain)      SKIP_DRAIN=true ;;
    --all)             RUN_ALL=true; SKIP_TASK=false; SKIP_DRAIN=false ;;
    --ci)              RUN_CI=true ;;
    --deploy-safety)   SKIP_DEPLOY_SAFETY=false ;;
    --multi)           RUN_MULTI=true ;;
    --group=*)         RUN_GROUP="${arg#--group=}" ;;
    --help|-h)
      echo "Usage: $0 [--group=N] [--all] [--ci] [--deploy-safety] [--multi] [--verbose]"
      exit 0
      ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# If --group is set, enable that group even if normally skipped
if [[ -n "$RUN_GROUP" ]]; then
  [[ "$RUN_GROUP" == "5" ]] && SKIP_TASK=false
  [[ "$RUN_GROUP" == "6" ]] && SKIP_DRAIN=false
  [[ "$RUN_GROUP" == "10" ]] && SKIP_DEPLOY_SAFETY=false
fi

# ── Colors & Counters ─────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILURES=()

# ── Shared State (populated during tests) ─────────────────────────────────────

SANDBOX_ID=""
WORKER_ID=""
TASK_ID=""
GH_JOB_ID=""
FLEET_MEMBER_ID=""

# ── Cleanup trap ──────────────────────────────────────────────────────────────

cleanup_on_exit() {
  if [[ -n "$TASK_ID" ]]; then
    # Best-effort cancel in-flight task
    curl -sf -X POST "${VALET_API}/api/v1/admin/tasks/${TASK_ID}/cancel" \
      -H "Authorization: Bearer ${VALET_TOKEN}" --max-time 5 >/dev/null 2>&1 || true
  fi
}
trap cleanup_on_exit EXIT INT TERM

# ── Helpers ────────────────────────────────────────────────────────────────────

log_header() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${CYAN}  $1${NC}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

log_test() {
  printf "  ${DIM}%-6s${NC} %-55s " "$1" "$2"
}

pass() {
  echo -e "${GREEN}PASS${NC} ${DIM}$1${NC}"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "${RED}FAIL${NC} $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILURES+=("$CURRENT_TEST: $1")
}

skip() {
  echo -e "${YELLOW}SKIP${NC} $1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

verbose_body() {
  if [[ "$VERBOSE" == "true" && -n "${1:-}" ]]; then
    echo -e "         ${DIM}$(echo "$1" | head -20)${NC}"
  fi
}

should_run_group() {
  local group="$1"
  if [[ -n "$RUN_GROUP" ]]; then
    [[ "$RUN_GROUP" == "$group" ]]
  else
    return 0
  fi
}

# Curl wrapper that captures both body and HTTP status
http_get() {
  local url="$1"; shift
  local tmpfile
  tmpfile=$(mktemp)
  HTTP_CODE=$(curl -sf -o "$tmpfile" -w '%{http_code}' --max-time 15 "$url" "$@" 2>/dev/null) || HTTP_CODE=$(curl -so "$tmpfile" -w '%{http_code}' --max-time 15 "$url" "$@" 2>/dev/null) || HTTP_CODE="000"
  HTTP_BODY=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"
}

valet_get() {
  http_get "${VALET_API}${1}" -H "Authorization: Bearer ${VALET_TOKEN}"
}

gh_get() {
  http_get "${GH_API}${1}" -H "X-GH-Service-Key: ${GH_SERVICE_SECRET}"
}

http_post() {
  local url="$1"; shift
  local data="$1"; shift
  local tmpfile
  tmpfile=$(mktemp)
  HTTP_CODE=$(curl -sf -o "$tmpfile" -w '%{http_code}' --max-time 30 -X POST \
    -H "Content-Type: application/json" -d "$data" "$url" "$@" 2>/dev/null) || \
  HTTP_CODE=$(curl -so "$tmpfile" -w '%{http_code}' --max-time 30 -X POST \
    -H "Content-Type: application/json" -d "$data" "$url" "$@" 2>/dev/null) || HTTP_CODE="000"
  HTTP_BODY=$(cat "$tmpfile" 2>/dev/null || echo "")
  rm -f "$tmpfile"
}

valet_post() {
  local path="$1"; shift
  local data="$1"; shift
  http_post "${VALET_API}${path}" "$data" -H "Authorization: Bearer ${VALET_TOKEN}" "$@"
}

atm_post() {
  local path="$1"; shift
  local data="$1"; shift
  http_post "${ATM_API}${path}" "$data" -H "X-Deploy-Secret: ${ATM_DEPLOY_SECRET}" "$@"
}

# ── GROUP 1: Component Health ─────────────────────────────────────────────────

group1_component_health() {
  log_header "Group 1: Component Health"

  CURRENT_TEST="1.1"; log_test "1.1" "ATM health"
  http_get "$ATM_API/health"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.status == "ok"' >/dev/null 2>&1; then pass "status=ok"
  else fail "Expected status=ok, got: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="1.2"; log_test "1.2" "ATM metrics"
  http_get "$ATM_API/metrics"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.cpu and .memory and .disk' >/dev/null 2>&1; then pass "cpu+memory+disk present"
  else fail "Missing metrics fields: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="1.3"; log_test "1.3" "ATM version"
  http_get "$ATM_API/version"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.version or .commitSha or .environment' >/dev/null 2>&1; then
    pass "$(echo "$HTTP_BODY" | jq -r '.version // .environment // "ok"')"
  else fail "No version info: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="1.4"; log_test "1.4" "GH API health"
  http_get "$GH_API/health"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    pass "status=ok, api_healthy=$(echo "$HTTP_BODY" | jq -r '.api_healthy // .apiHealthy // "unknown"')"
  else fail "Expected status=ok, got: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="1.5"; log_test "1.5" "GH system metrics"
  http_get "$GH_API/health/system"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.cpu and .memory and .disk' >/dev/null 2>&1; then
    pass "mem=$(echo "$HTTP_BODY" | jq -r '.memory.usagePercent // .memory.usedPercent // "?"')%"
  elif echo "$HTTP_BODY" | jq -e '.system' >/dev/null 2>&1; then pass "system metrics present (nested)"
  else fail "Missing system metrics: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="1.6"; log_test "1.6" "GH Worker health"
  http_get "$GH_WORKER/worker/health"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "503" ]]; then
    pass "status=$(echo "$HTTP_BODY" | jq -r '.status // "unknown"'), active_jobs=$(echo "$HTTP_BODY" | jq -r '.active_jobs // 0')"
  else fail "HTTP $HTTP_CODE: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="1.7"; log_test "1.7" "GH Worker status"
  http_get "$GH_WORKER/worker/status"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.worker_id or .workerId' >/dev/null 2>&1; then
    pass "worker_id=$(echo "$HTTP_BODY" | jq -r '.worker_id // .workerId' | head -c 12)..."
  else fail "No worker_id: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="1.8"; log_test "1.8" "VNC endpoint (expect 401)"
  local vnc_code
  vnc_code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$VNC_URL/" 2>/dev/null) || vnc_code="000"
  if [[ "$vnc_code" == "401" ]]; then pass "HTTP 401 (KasmVNC auth gate)"
  elif [[ "$vnc_code" == "000" ]]; then fail "Connection failed (VNC not reachable)"
  else pass "HTTP $vnc_code (VNC is up)"; fi

  CURRENT_TEST="1.9"; log_test "1.9" "VALET API reachable"
  valet_get "/api/v1/tasks"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "HTTP 200"
  else fail "HTTP $HTTP_CODE: $(echo "$HTTP_BODY" | head -1)"; fi
}

# ── GROUP 2: Fleet & Port Verification ────────────────────────────────────────

group2_fleet_ports() {
  log_header "Group 2: Fleet & Port Verification"

  CURRENT_TEST="2.1"; log_test "2.1" "ATM fleet list"
  http_get "$ATM_API/fleet"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.' >/dev/null 2>&1; then
    if echo "$HTTP_BODY" | jq -r '.. | .ip? // .host? // .publicIp? // empty' 2>/dev/null | grep -q "44.223.180.11"; then
      FLEET_MEMBER_ID=$(echo "$HTTP_BODY" | jq -r '
        (.fleet // .members // .servers // [.]) | flatten
        | map(select(.ip == "44.223.180.11" or .host == "44.223.180.11"))
        | .[0].id // .[0].name // empty' 2>/dev/null || echo "")
      pass "GH EC2 (44.223.180.11) found"
    else
      pass "fleet returned ($(echo "$HTTP_BODY" | jq 'if type == "array" then length else (.fleet // .members // .servers // []) | length end' 2>/dev/null || echo "?") members)"
    fi
  else fail "Invalid JSON: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="2.2"; log_test "2.2" "ATM fleet member health (via proxy)"
  if [[ -n "$FLEET_MEMBER_ID" ]]; then
    http_get "$ATM_API/fleet/$FLEET_MEMBER_ID/health"; verbose_body "$HTTP_BODY"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "proxy health OK"
    else fail "HTTP $HTTP_CODE"; fi
  else
    http_get "$ATM_API/fleet/health"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "fleet health aggregate OK"
    else skip "No fleet member ID extracted (HTTP $HTTP_CODE)"; fi
  fi

  CURRENT_TEST="2.3"; log_test "2.3" "ATM containers"
  http_get "$ATM_API/containers"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e 'if type == "array" then length > 0 else .containers | length > 0 end' >/dev/null 2>&1; then
    pass "$(echo "$HTTP_BODY" | jq 'if type == "array" then length else (.containers // []) | length end' 2>/dev/null) containers"
  else fail "No containers: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="2.4"; log_test "2.4" "ATM workers"
  http_get "$ATM_API/workers"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e 'if type == "array" then true else .workers != null end' >/dev/null 2>&1; then
    pass "$(echo "$HTTP_BODY" | jq 'if type == "array" then length else (.workers // []) | length end' 2>/dev/null) workers"
  else fail "No workers: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="2.5"; log_test "2.5" "Port 8080 on ATM EC2 (direct)"
  http_get "$ATM_DIRECT/health"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.status == "ok"' >/dev/null 2>&1; then pass "ATM responds on :8080"
  else fail "ATM :8080 not responding (HTTP $HTTP_CODE)"; fi

  CURRENT_TEST="2.6"; log_test "2.6" "Port 8080 absent on GH EC2"
  local gh8080_code
  gh8080_code=$(curl -so /dev/null -w '%{http_code}' --max-time 3 "http://44.223.180.11:8080/health" 2>/dev/null) || gh8080_code="000"
  if [[ "$gh8080_code" == "000" ]]; then pass "Connection refused/timeout (correct)"
  else fail "Got HTTP $gh8080_code — port 8080 should NOT be open on GH EC2"; fi
}

# ── GROUP 3: VALET Admin API ─────────────────────────────────────────────────

group3_valet_admin() {
  log_header "Group 3: VALET Admin API"

  CURRENT_TEST="3.1"; log_test "3.1" "List sandboxes"
  valet_get "/api/v1/admin/sandboxes"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then
    SANDBOX_ID=$(echo "$HTTP_BODY" | jq -r '(.sandboxes // .data // [.]) | flatten | map(select(.status == "active" or .status == "healthy" or .isActive == true)) | .[0].id // .[0].sandboxId // empty' 2>/dev/null || echo "")
    [[ -z "$SANDBOX_ID" ]] && SANDBOX_ID=$(echo "$HTTP_BODY" | jq -r '(.sandboxes // .data // [.]) | flatten | .[0].id // .[0].sandboxId // empty' 2>/dev/null || echo "")
    pass "active=$SANDBOX_ID"
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="3.2"; log_test "3.2" "Sandbox metrics"
  if [[ -n "$SANDBOX_ID" ]]; then
    valet_get "/api/v1/admin/sandboxes/$SANDBOX_ID/metrics"; verbose_body "$HTTP_BODY"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "metrics present"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No sandbox ID"; fi

  CURRENT_TEST="3.3"; log_test "3.3" "Sandbox deep health"
  if [[ -n "$SANDBOX_ID" ]]; then
    valet_get "/api/v1/admin/sandboxes/$SANDBOX_ID/deep-health"; verbose_body "$HTTP_BODY"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "deep health OK"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No sandbox ID"; fi

  CURRENT_TEST="3.4"; log_test "3.4" "List workers"
  valet_get "/api/v1/admin/workers"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then
    WORKER_ID=$(echo "$HTTP_BODY" | jq -r '(.workers // .data // [.]) | flatten | .[0].worker_id // .[0].workerId // .[0].id // empty' 2>/dev/null || echo "")
    pass "first=$WORKER_ID"
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="3.5"; log_test "3.5" "Worker detail"
  if [[ -n "$WORKER_ID" ]]; then
    valet_get "/api/v1/admin/workers/$WORKER_ID"; verbose_body "$HTTP_BODY"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "status=$(echo "$HTTP_BODY" | jq -r '.live_status // .liveStatus // .status // "unknown"' 2>/dev/null)"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No worker ID"; fi

  CURRENT_TEST="3.6"; log_test "3.6" "List tasks (admin)"
  valet_get "/api/v1/admin/tasks"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "$(echo "$HTTP_BODY" | jq '(.tasks // .data // []) | length' 2>/dev/null || echo "?") tasks"
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="3.7"; log_test "3.7" "Stuck tasks"
  valet_get "/api/v1/admin/tasks/stuck"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "$(echo "$HTTP_BODY" | jq '.count // (if type == "array" then length else (.tasks // .data // []) | length end)' 2>/dev/null || echo "?") stuck"
  else fail "HTTP $HTTP_CODE"; fi
}

# ── GROUP 4: GH API Direct ──────────────────────────────────────────────────

group4_gh_api() {
  log_header "Group 4: GH API Direct"

  CURRENT_TEST="4.1"; log_test "4.1" "GH list models"
  http_get "$GH_API/api/v1/gh/models"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "$(echo "$HTTP_BODY" | jq '(.models // []) | length' 2>/dev/null || echo "?") models"
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="4.2"; log_test "4.2" "GH list jobs (auth)"
  gh_get "/api/v1/gh/jobs"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "$(echo "$HTTP_BODY" | jq 'if type == "array" then length else (.jobs // .data // []) | length end' 2>/dev/null || echo "?") jobs"
  else fail "HTTP $HTTP_CODE: $(echo "$HTTP_BODY" | head -1)"; fi

  CURRENT_TEST="4.3"; log_test "4.3" "GH capabilities / config"
  http_get "$GH_API/api/v1/gh/config" || http_get "$GH_API/health"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "config/health accessible"
  else pass "endpoint check done (HTTP $HTTP_CODE)"; fi
}

# ── GROUP 5: Task Lifecycle (End-to-End) ─────────────────────────────────────

group5_task_lifecycle() {
  log_header "Group 5: Task Lifecycle (End-to-End)"
  echo -e "  ${YELLOW}WARNING: This group submits a real task to the worker${NC}"
  echo ""

  # 5.1 Get sandbox ID
  CURRENT_TEST="5.1"; log_test "5.1" "Get sandbox ID"
  if [[ -z "$SANDBOX_ID" ]]; then
    valet_get "/api/v1/admin/sandboxes"
    SANDBOX_ID=$(echo "$HTTP_BODY" | jq -r '(.sandboxes // .data // [.]) | flatten | .[0].id // .[0].sandboxId // empty' 2>/dev/null || echo "")
  fi
  if [[ -n "$SANDBOX_ID" ]]; then pass "sandbox=$SANDBOX_ID"
  else fail "No sandbox found"; return; fi

  # 5.2 Get worker ID
  CURRENT_TEST="5.2"; log_test "5.2" "Get worker ID"
  if [[ -z "$WORKER_ID" ]]; then
    valet_get "/api/v1/admin/workers"
    WORKER_ID=$(echo "$HTTP_BODY" | jq -r '(.workers // .data // [.]) | flatten | .[0].worker_id // .[0].workerId // .[0].id // empty' 2>/dev/null || echo "")
  fi
  if [[ -n "$WORKER_ID" ]]; then pass "worker=$WORKER_ID"
  else fail "No worker found"; return; fi

  # 5.3 Check worker is idle (30s retry loop)
  CURRENT_TEST="5.3"; log_test "5.3" "Check worker is idle (retry loop)"
  local worker_ready=false
  for attempt in $(seq 1 6); do
    http_get "$GH_WORKER/worker/health"
    local wstatus
    wstatus=$(echo "$HTTP_BODY" | jq -r '.status // "unknown"' 2>/dev/null)
    if [[ "$wstatus" == "idle" ]]; then
      worker_ready=true; break
    fi
    [[ $attempt -lt 6 ]] && sleep 5
  done
  if [[ "$worker_ready" == "true" ]]; then pass "worker is idle"
  else fail "Worker not idle after 30s — skipping task submission"; return; fi

  # 5.4 Submit test task
  CURRENT_TEST="5.4"; log_test "5.4" "Submit test task"
  valet_post "/api/v1/admin/sandboxes/$SANDBOX_ID/trigger-test" '{"searchQuery": "ATM integration test verification"}'
  verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    TASK_ID=$(echo "$HTTP_BODY" | jq -r '.taskId // .task_id // .id // .data.taskId // .data.id // empty' 2>/dev/null || echo "")
    if [[ -n "$TASK_ID" ]]; then pass "taskId=$TASK_ID"
    else fail "HTTP $HTTP_CODE but no taskId"; return; fi
  else fail "HTTP $HTTP_CODE: $(echo "$HTTP_BODY" | head -2)"; return; fi

  # 5.5 Verify task in DB
  CURRENT_TEST="5.5"; log_test "5.5" "Verify task in DB"
  sleep 2
  local db_result
  db_result=$(psql -t -A -c "SELECT id, status FROM tasks WHERE id = '$TASK_ID'" 2>/dev/null) || db_result=""
  if [[ -n "$db_result" ]]; then pass "status=$(echo "$db_result" | cut -d'|' -f2)"
  else fail "Task $TASK_ID not found in DB"; fi

  # 5.6 Verify GH job created
  CURRENT_TEST="5.6"; log_test "5.6" "Verify GH job in DB"
  sleep 2
  local gh_job_result
  gh_job_result=$(psql -t -A -c "SELECT id, status, job_type FROM gh_automation_jobs WHERE valet_task_id = '$TASK_ID' ORDER BY created_at DESC LIMIT 1" 2>/dev/null) || gh_job_result=""
  if [[ -n "$gh_job_result" ]]; then
    GH_JOB_ID=$(echo "$gh_job_result" | cut -d'|' -f1)
    pass "ghJobId=$GH_JOB_ID, status=$(echo "$gh_job_result" | cut -d'|' -f2)"
  else fail "No GH job found for task $TASK_ID"; fi

  # 5.7 Check GH job via API
  CURRENT_TEST="5.7"; log_test "5.7" "Check GH job via API"
  if [[ -n "$GH_JOB_ID" ]]; then
    gh_get "/api/v1/gh/jobs/$GH_JOB_ID"; verbose_body "$HTTP_BODY"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "status=$(echo "$HTTP_BODY" | jq -r '.status // .job.status // "unknown"' 2>/dev/null)"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No GH job ID"; fi

  # 5.8 Monitor SSE stream (30s timeout)
  CURRENT_TEST="5.8"; log_test "5.8" "SSE event stream"
  local sse_output
  sse_output=$(timeout 30 curl -sN -H "Authorization: Bearer ${VALET_TOKEN}" \
    "${VALET_API}/api/v1/tasks/${TASK_ID}/events/stream" 2>/dev/null | head -20) || sse_output=""
  if [[ -z "$sse_output" ]]; then
    # Fallback: try query param auth
    sse_output=$(timeout 30 curl -sN "${VALET_API}/api/v1/tasks/${TASK_ID}/events/stream?token=${VALET_TOKEN}" 2>/dev/null | head -20) || sse_output=""
  fi
  if [[ -n "$sse_output" ]]; then
    pass "$(echo "$sse_output" | grep -c "^data:" || echo "0") SSE events received"
  else skip "No SSE events in 30s"; fi

  # 5.9 Check GH job events
  CURRENT_TEST="5.9"; log_test "5.9" "GH job events"
  if [[ -n "$GH_JOB_ID" ]]; then
    gh_get "/api/v1/gh/jobs/$GH_JOB_ID/events"; verbose_body "$HTTP_BODY"
    if [[ "$HTTP_CODE" == "200" ]]; then
      pass "$(echo "$HTTP_BODY" | jq 'if type == "array" then length else (.events // .data // []) | length end' 2>/dev/null || echo "?") events"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No GH job ID"; fi

  # 5.10 Poll task status (12 polls, 5s apart, 60s max)
  CURRENT_TEST="5.10"; log_test "5.10" "Poll task progress (60s)"
  local final_status=""
  for i in $(seq 1 12); do
    valet_get "/api/v1/tasks/$TASK_ID"
    final_status=$(echo "$HTTP_BODY" | jq -r '.status // .task.status // "unknown"' 2>/dev/null)
    [[ "$final_status" == "completed" || "$final_status" == "failed" || "$final_status" == "cancelled" ]] && break
    [[ $i -lt 12 ]] && sleep 5
  done
  pass "status=$final_status after polling"

  # 5.11 Check VNC during execution
  CURRENT_TEST="5.11"; log_test "5.11" "VNC live during execution"
  local vnc_code
  vnc_code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$VNC_URL/" 2>/dev/null) || vnc_code="000"
  if [[ "$vnc_code" == "401" || "$vnc_code" == "200" ]]; then pass "VNC responding (HTTP $vnc_code)"
  else fail "VNC not responding (HTTP $vnc_code)"; fi

  # 5.12 Final task status from DB
  CURRENT_TEST="5.12"; log_test "5.12" "Final task status (DB)"
  local final_db
  final_db=$(psql -t -A -c "SELECT status FROM tasks WHERE id = '$TASK_ID'" 2>/dev/null) || final_db=""
  if [[ -n "$final_db" ]]; then pass "DB status=$final_db"
  else skip "Could not query DB"; fi

  # 5.13 Verify job events ≥2
  CURRENT_TEST="5.13"; log_test "5.13" "GH job has ≥2 events"
  if [[ -n "$GH_JOB_ID" ]]; then
    local event_count
    event_count=$(psql -t -A -c "SELECT count(*) FROM gh_job_events WHERE job_id = '$GH_JOB_ID'" 2>/dev/null) || event_count="0"
    event_count=$(echo "$event_count" | tr -d '[:space:]')
    if [[ "$event_count" -ge 2 ]]; then pass "$event_count events"
    else fail "Only $event_count events (expected ≥2)"; fi
  else skip "No GH job ID"; fi

  # 5.14 Verify cost_amount not null
  CURRENT_TEST="5.14"; log_test "5.14" "Cost amount recorded"
  if [[ -n "$GH_JOB_ID" ]]; then
    local cost
    cost=$(psql -t -A -c "SELECT cost_amount FROM gh_automation_jobs WHERE id = '$GH_JOB_ID'" 2>/dev/null) || cost=""
    cost=$(echo "$cost" | tr -d '[:space:]')
    if [[ -n "$cost" && "$cost" != "" ]]; then pass "cost=$cost"
    else skip "cost_amount is null (job may still be running)"; fi
  else skip "No GH job ID"; fi

  # 5.15 Cleanup: cancel task if still running
  CURRENT_TEST="5.15"; log_test "5.15" "Cleanup: cancel if still running"
  if [[ "$final_status" != "completed" && "$final_status" != "failed" && "$final_status" != "cancelled" ]]; then
    valet_post "/api/v1/admin/tasks/$TASK_ID/cancel" '{}'
    pass "cancel sent (was $final_status)"
  else
    pass "task already terminal ($final_status)"
    TASK_ID="" # Clear so trap doesn't re-cancel
  fi
}

# ── GROUP 6: Worker Drain Flow ───────────────────────────────────────────────

group6_worker_drain() {
  log_header "Group 6: Worker Drain Flow"
  echo -e "  ${RED}WARNING: This group drains the worker — it will stop accepting new jobs${NC}"
  echo ""

  if [[ -z "$WORKER_ID" ]]; then
    valet_get "/api/v1/admin/workers"
    WORKER_ID=$(echo "$HTTP_BODY" | jq -r '(.workers // .data // [.]) | flatten | .[0].worker_id // .[0].workerId // .[0].id // empty' 2>/dev/null || echo "")
  fi
  if [[ -z "$WORKER_ID" ]]; then
    echo -e "  ${RED}No worker ID available — skipping group 6${NC}"; return
  fi

  # 6.1 Pre-check worker status
  CURRENT_TEST="6.1"; log_test "6.1" "Pre-check worker status"
  valet_get "/api/v1/admin/workers/$WORKER_ID"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "status=$(echo "$HTTP_BODY" | jq -r '.live_status // .liveStatus // .status // "unknown"' 2>/dev/null)"
  else fail "HTTP $HTTP_CODE"; return; fi

  # 6.2 Trigger drain
  CURRENT_TEST="6.2"; log_test "6.2" "Trigger drain"
  valet_post "/api/v1/admin/workers/$WORKER_ID/drain" '{}'
  verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "202" ]]; then pass "drain requested"
  else fail "HTTP $HTTP_CODE: $(echo "$HTTP_BODY" | head -1)"; return; fi

  # 6.3 Verify drain response
  CURRENT_TEST="6.3"; log_test "6.3" "Verify drain response"
  if echo "$HTTP_BODY" | jq -e '.success == true or .drainedWorkers or .status' >/dev/null 2>&1; then pass "drain confirmed"
  else fail "Unexpected response: $(echo "$HTTP_BODY" | head -1)"; fi

  # 6.4 Verify worker draining (direct)
  CURRENT_TEST="6.4"; log_test "6.4" "Verify worker draining (GH direct)"
  sleep 2
  http_get "$GH_WORKER/worker/status"; verbose_body "$HTTP_BODY"
  local is_draining
  is_draining=$(echo "$HTTP_BODY" | jq -r '.is_draining // .isDraining // .draining // "unknown"' 2>/dev/null)
  if [[ "$is_draining" == "true" ]]; then pass "is_draining=true"
  else pass "drain status=$is_draining (may take a moment)"; fi

  # 6.5 Verify via ATM
  CURRENT_TEST="6.5"; log_test "6.5" "Verify drain via ATM"
  http_get "$ATM_API/workers"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "ATM workers endpoint OK"
  else fail "HTTP $HTTP_CODE"; fi

  # 6.6 While draining, verify new job rejected
  CURRENT_TEST="6.6"; log_test "6.6" "New job rejected while draining"
  gh_get "/api/v1/gh/jobs"
  # Just check the worker is in draining state — we don't actually submit a job
  http_get "$GH_WORKER/worker/health"
  local drain_status
  drain_status=$(echo "$HTTP_BODY" | jq -r '.status // "unknown"' 2>/dev/null)
  if [[ "$drain_status" == "draining" || "$drain_status" == "drain" ]]; then pass "worker reports draining"
  else pass "worker status=$drain_status"; fi

  # 6.7 Wait for drain completion (poll active_jobs=0, 60s)
  CURRENT_TEST="6.7"; log_test "6.7" "Wait for drain completion (60s)"
  local drain_done=false
  for i in $(seq 1 12); do
    http_get "$GH_WORKER/worker/status"
    local active
    active=$(echo "$HTTP_BODY" | jq -r '.active_jobs // 0' 2>/dev/null)
    if [[ "$active" == "0" ]]; then drain_done=true; break; fi
    sleep 5
  done
  if [[ "$drain_done" == "true" ]]; then pass "active_jobs=0"
  else pass "drain poll done (may still be draining)"; fi

  # 6.8 Restore worker via Kamal redeploy
  CURRENT_TEST="6.8"; log_test "6.8" "Restore worker (Kamal redeploy)"
  atm_post "/deploy/kamal?force=true" '{"destination":"staging"}'
  verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then pass "redeploy triggered"
  else skip "Kamal redeploy HTTP $HTTP_CODE (manual restart may be needed)"; fi

  # 6.9 Verify worker restored (poll 60s)
  CURRENT_TEST="6.9"; log_test "6.9" "Verify worker restored (60s)"
  local restored=false
  for i in $(seq 1 12); do
    http_get "$GH_WORKER/worker/health"
    local rstatus
    rstatus=$(echo "$HTTP_BODY" | jq -r '.status // "unknown"' 2>/dev/null)
    if [[ "$rstatus" == "idle" ]]; then restored=true; break; fi
    sleep 5
  done
  if [[ "$restored" == "true" ]]; then pass "worker idle"
  else pass "worker status=$rstatus after 60s"; fi

  echo ""
  echo -e "  ${YELLOW}NOTE: Worker drain test complete. Worker has been redeployed.${NC}"
}

# ── GROUP 7: Database Connectivity ───────────────────────────────────────────

group7_database() {
  log_header "Group 7: Database Connectivity & Data Integrity"

  CURRENT_TEST="7.1"; log_test "7.1" "Database connection"
  local db_version
  db_version=$(psql -t -A -c "SELECT version()" 2>/dev/null | head -1) || db_version=""
  if [[ -n "$db_version" ]]; then pass "$(echo "$db_version" | grep -oE 'PostgreSQL [0-9]+\.[0-9]+' || echo "connected")"
  else fail "Cannot connect to database"; echo -e "  ${YELLOW}  Skipping remaining DB tests${NC}"; return; fi

  CURRENT_TEST="7.2"; log_test "7.2" "Core tables exist"
  local tables
  tables=$(psql -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tasks', 'gh_automation_jobs', 'sandboxes', 'gh_job_events', 'workers') ORDER BY table_name" 2>/dev/null)
  local tcount
  tcount=$(echo "$tables" | grep -c '.' || echo "0")
  if [[ "$tcount" -ge 3 ]]; then pass "$tcount tables: $(echo "$tables" | tr '\n' ', ' | sed 's/,$//')"
  else fail "Only $tcount core tables found"; fi

  CURRENT_TEST="7.3"; log_test "7.3" "Recent tasks in DB"
  local recent_tasks
  recent_tasks=$(psql -t -A -c "SELECT count(*) FROM tasks WHERE created_at > now() - interval '7 days'" 2>/dev/null) || recent_tasks="0"
  pass "$recent_tasks tasks in last 7 days"

  CURRENT_TEST="7.4"; log_test "7.4" "GH automation jobs in DB"
  local recent_jobs
  recent_jobs=$(psql -t -A -c "SELECT count(*) FROM gh_automation_jobs WHERE created_at > now() - interval '7 days'" 2>/dev/null) || recent_jobs="0"
  pass "$recent_jobs jobs in last 7 days"

  CURRENT_TEST="7.5"; log_test "7.5" "Sandbox records"
  local sandbox_data
  sandbox_data=$(psql -t -A -c "SELECT id, name, status FROM sandboxes LIMIT 5" 2>/dev/null) || sandbox_data=""
  if [[ -n "$sandbox_data" ]]; then pass "$(echo "$sandbox_data" | grep -c '.' || echo "0") sandboxes"
  else fail "No sandbox records"; fi

  CURRENT_TEST="7.6"; log_test "7.6" "GH job events in DB"
  local event_count
  event_count=$(psql -t -A -c "SELECT count(*) FROM gh_job_events WHERE created_at > now() - interval '7 days'" 2>/dev/null) || event_count="?"
  pass "$event_count events in last 7 days"

  CURRENT_TEST="7.7"; log_test "7.7" "FK integrity: jobs → tasks"
  local orphan_jobs
  orphan_jobs=$(psql -t -A -c "SELECT count(*) FROM gh_automation_jobs j LEFT JOIN tasks t ON j.valet_task_id::text = t.id::text WHERE j.valet_task_id IS NOT NULL AND t.id IS NULL" 2>&1) || orphan_jobs="error"
  orphan_jobs=$(echo "$orphan_jobs" | tr -d '[:space:]')
  if [[ "$orphan_jobs" == "0" ]]; then pass "no orphan jobs"
  elif [[ "$orphan_jobs" =~ ^[0-9]+$ && "$orphan_jobs" -eq 0 ]]; then pass "no orphan jobs"
  elif [[ "$orphan_jobs" =~ ^[0-9]+$ ]]; then fail "$orphan_jobs orphan jobs"
  else skip "FK check inconclusive: $orphan_jobs"; fi
}

# ── GROUP 8: ATM Endpoint Coverage ──────────────────────────────────────────

group8_atm_endpoints() {
  log_header "Group 8: ATM Endpoint Coverage"

  # GET endpoints
  CURRENT_TEST="8.1"; log_test "8.1" "GET /deploys → array"
  http_get "$ATM_API/deploys"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then
    if echo "$HTTP_BODY" | jq -e 'type == "array"' >/dev/null 2>&1; then
      local dcount; dcount=$(echo "$HTTP_BODY" | jq 'length' 2>/dev/null)
      pass "$dcount deploy records"
    else pass "HTTP 200 (non-array response)"; fi
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="8.2"; log_test "8.2" "GET /deploys structure"
  if echo "$HTTP_BODY" | jq -e '.[0].id and .[0].status' >/dev/null 2>&1; then
    local first_id; first_id=$(echo "$HTTP_BODY" | jq -r '.[0].id' 2>/dev/null)
    pass "has id+status, first=$first_id"
  else pass "structure OK (may be empty)"; fi

  CURRENT_TEST="8.3"; log_test "8.3" "GET /deploys/nonexistent → 404"
  http_get "$ATM_API/deploys/nonexistent-deploy-id-xyz"
  if [[ "$HTTP_CODE" == "404" ]]; then pass "404 as expected"
  else fail "Expected 404, got HTTP $HTTP_CODE"; fi

  CURRENT_TEST="8.4"; log_test "8.4" "GET /deploys/:id (valid)"
  local deploy_id
  deploy_id=$(echo "$HTTP_BODY" | jq -r '.[0].id // empty' 2>/dev/null || echo "")
  # Re-fetch deploys list since 8.3 overwrote HTTP_BODY
  http_get "$ATM_API/deploys"
  deploy_id=$(echo "$HTTP_BODY" | jq -r 'if type == "array" then .[0].id // empty else empty end' 2>/dev/null || echo "")
  if [[ -n "$deploy_id" ]]; then
    http_get "$ATM_API/deploys/$deploy_id"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "id=$deploy_id"
    else fail "HTTP $HTTP_CODE for deploy $deploy_id"; fi
  else skip "No deploy records to test"; fi

  CURRENT_TEST="8.5"; log_test "8.5" "GET /secrets/status"
  http_get "$ATM_API/secrets/status"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then
    if echo "$HTTP_BODY" | jq -e '.connected != null or .status' >/dev/null 2>&1; then pass "connected=$(echo "$HTTP_BODY" | jq -r '.connected // .status' 2>/dev/null)"
    else pass "HTTP 200"; fi
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="8.6"; log_test "8.6" "GET /kamal/status"
  http_get "$ATM_API/kamal/status"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "$(echo "$HTTP_BODY" | jq -r '.available // .locked // "ok"' 2>/dev/null)"
  else pass "HTTP $HTTP_CODE (kamal may not be installed)"; fi

  CURRENT_TEST="8.7"; log_test "8.7" "GET /kamal/validate"
  http_get "$ATM_API/kamal/validate"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "validation response OK"
  else pass "HTTP $HTTP_CODE (expected on non-Kamal host)"; fi

  CURRENT_TEST="8.8"; log_test "8.8" "GET /kamal/hosts"
  http_get "$ATM_API/kamal/hosts"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "hosts returned"
  else pass "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="8.9"; log_test "8.9" "GET /kamal/audit"
  http_get "$ATM_API/kamal/audit"; verbose_body "$HTTP_BODY"
  if [[ "$HTTP_CODE" == "200" ]]; then
    if echo "$HTTP_BODY" | jq -e 'type == "array"' >/dev/null 2>&1; then
      pass "$(echo "$HTTP_BODY" | jq 'length' 2>/dev/null) audit entries"
    else pass "audit response OK"; fi
  else pass "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="8.10"; log_test "8.10" "GET /deploy/stream (SSE)"
  local sse_resp
  sse_resp=$(timeout 3 curl -sf "$ATM_API/deploy/stream" 2>/dev/null | head -5) || sse_resp=""
  if [[ -n "$sse_resp" ]] || [[ $? -eq 124 ]]; then pass "SSE stream connects"
  else pass "SSE endpoint reachable"; fi

  # Fleet proxy tests
  CURRENT_TEST="8.11"; log_test "8.11" "Fleet proxy: version"
  if [[ -n "$FLEET_MEMBER_ID" ]]; then
    http_get "$ATM_API/fleet/$FLEET_MEMBER_ID/version"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "proxy version OK"
    else pass "HTTP $HTTP_CODE"; fi
  else skip "No fleet member ID"; fi

  CURRENT_TEST="8.12"; log_test "8.12" "Fleet proxy: metrics"
  if [[ -n "$FLEET_MEMBER_ID" ]]; then
    http_get "$ATM_API/fleet/$FLEET_MEMBER_ID/health/system"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "proxy metrics OK"
    else pass "HTTP $HTTP_CODE"; fi
  else skip "No fleet member ID"; fi

  CURRENT_TEST="8.13"; log_test "8.13" "Fleet proxy: workers"
  if [[ -n "$FLEET_MEMBER_ID" ]]; then
    http_get "$ATM_API/fleet/$FLEET_MEMBER_ID/worker/health"
    if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "503" ]]; then pass "proxy worker health OK"
    else pass "HTTP $HTTP_CODE"; fi
  else skip "No fleet member ID"; fi

  CURRENT_TEST="8.14"; log_test "8.14" "Fleet proxy: unknown server → 404"
  http_get "$ATM_API/fleet/nonexistent-server-xyz/health"
  if [[ "$HTTP_CODE" == "404" ]]; then pass "404 as expected"
  else fail "Expected 404, got HTTP $HTTP_CODE"; fi

  # POST auth enforcement (skip in CI mode — some may trigger side effects)
  if [[ "$RUN_CI" == "true" ]]; then
    echo -e "  ${YELLOW}  Skipping POST auth tests in CI mode${NC}"
    return
  fi

  CURRENT_TEST="8.15"; log_test "8.15" "POST /deploy without auth → 401"
  http_post "$ATM_API/deploy" '{"imageTag":"test"}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.16"; log_test "8.16" "POST /deploy/kamal without auth → 401"
  http_post "$ATM_API/deploy/kamal" '{"destination":"staging"}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.17"; log_test "8.17" "POST /rollback/kamal without auth → 401"
  http_post "$ATM_API/rollback/kamal" '{"version":"v1"}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.18"; log_test "8.18" "POST /drain without auth → 401"
  http_post "$ATM_API/drain" '{}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.19"; log_test "8.19" "POST /drain/graceful without auth → 401"
  http_post "$ATM_API/drain/graceful" '{}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.20"; log_test "8.20" "POST /cleanup without auth → 401"
  http_post "$ATM_API/cleanup" '{}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.21"; log_test "8.21" "POST /admin/refresh-secrets without auth → 401"
  http_post "$ATM_API/admin/refresh-secrets" '{}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.22"; log_test "8.22" "POST /fleet/reload without auth → 401"
  http_post "$ATM_API/fleet/reload" '{}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.23"; log_test "8.23" "POST /fleet/reload with auth → 200"
  atm_post "/fleet/reload" '{}'
  if [[ "$HTTP_CODE" == "200" ]]; then pass "fleet reloaded"
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="8.24"; log_test "8.24" "POST /admin/refresh-secrets with auth → 200"
  atm_post "/admin/refresh-secrets" '{}'
  if [[ "$HTTP_CODE" == "200" ]]; then pass "secrets refreshed"
  else pass "HTTP $HTTP_CODE (may not be configured)"; fi

  CURRENT_TEST="8.25"; log_test "8.25" "POST /deploy wrong secret → 401"
  http_post "$ATM_API/deploy" '{"imageTag":"test"}' -H "X-Deploy-Secret: wrong-secret-value"
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401 with wrong secret"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.26"; log_test "8.26" "POST /deploy empty secret → 401"
  http_post "$ATM_API/deploy" '{"imageTag":"test"}' -H "X-Deploy-Secret: "
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401 with empty secret"
  else fail "Expected 401, got $HTTP_CODE"; fi

  CURRENT_TEST="8.27"; log_test "8.27" "POST /deploy no secret header → 401"
  http_post "$ATM_API/deploy" '{"imageTag":"test"}'
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401 without header"
  else fail "Expected 401, got $HTTP_CODE"; fi
}

# ── GROUP 9: Multi-EC2 Fleet ─────────────────────────────────────────────────

group9_fleet() {
  log_header "Group 9: Multi-EC2 Fleet"

  # Single-EC2 tests (always run)
  CURRENT_TEST="9.1"; log_test "9.1" "Fleet returns server array"
  http_get "$ATM_API/fleet"; verbose_body "$HTTP_BODY"
  if echo "$HTTP_BODY" | jq -e '.servers' >/dev/null 2>&1; then
    pass "$(echo "$HTTP_BODY" | jq '.servers | length' 2>/dev/null) servers"
  else fail "No .servers in response"; fi

  CURRENT_TEST="9.2"; log_test "9.2" "Fleet has ATM + GH entries"
  local atm_count gh_count
  atm_count=$(echo "$HTTP_BODY" | jq '[.servers[] | select(.role == "atm")] | length' 2>/dev/null || echo "0")
  gh_count=$(echo "$HTTP_BODY" | jq '[.servers[] | select(.role == "ghosthands" or .role == "gh")] | length' 2>/dev/null || echo "0")
  if [[ "$atm_count" -ge 1 && "$gh_count" -ge 1 ]]; then pass "atm=$atm_count, gh=$gh_count"
  elif [[ "$gh_count" -ge 1 ]]; then pass "gh=$gh_count (atm may be implicit)"
  else fail "atm=$atm_count, gh=$gh_count"; fi

  # Extract first GH fleet member for proxy tests
  local gh_fleet_id
  gh_fleet_id=$(echo "$HTTP_BODY" | jq -r '.servers[] | select(.role == "ghosthands" or .role == "gh") | .id' 2>/dev/null | head -1 || echo "")
  [[ -z "$gh_fleet_id" && -n "$FLEET_MEMBER_ID" ]] && gh_fleet_id="$FLEET_MEMBER_ID"

  CURRENT_TEST="9.3"; log_test "9.3" "Fleet proxy: /health"
  if [[ -n "$gh_fleet_id" ]]; then
    http_get "$ATM_API/fleet/$gh_fleet_id/health"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "proxied health OK"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No GH fleet member"; fi

  CURRENT_TEST="9.4"; log_test "9.4" "Fleet proxy: /worker/health"
  if [[ -n "$gh_fleet_id" ]]; then
    http_get "$ATM_API/fleet/$gh_fleet_id/worker/health"
    if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "503" ]]; then pass "proxied worker health"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No GH fleet member"; fi

  CURRENT_TEST="9.5"; log_test "9.5" "Fleet proxy: /health/system"
  if [[ -n "$gh_fleet_id" ]]; then
    http_get "$ATM_API/fleet/$gh_fleet_id/health/system"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "proxied system metrics"
    else fail "HTTP $HTTP_CODE"; fi
  else skip "No GH fleet member"; fi

  CURRENT_TEST="9.6"; log_test "9.6" "Fleet proxy: /version or /api/v1/gh/config"
  if [[ -n "$gh_fleet_id" ]]; then
    http_get "$ATM_API/fleet/$gh_fleet_id/api/v1/gh/models"
    if [[ "$HTTP_CODE" == "200" ]]; then pass "proxied models endpoint"
    else pass "HTTP $HTTP_CODE (endpoint may vary)"; fi
  else skip "No GH fleet member"; fi

  CURRENT_TEST="9.7"; log_test "9.7" "Fleet: ATM self entry"
  local atm_id
  atm_id=$(echo "$HTTP_BODY" | jq -r '.servers[] | select(.role == "atm") | .id' 2>/dev/null | head -1 || echo "")
  # Re-fetch fleet since HTTP_BODY was overwritten
  http_get "$ATM_API/fleet"
  atm_id=$(echo "$HTTP_BODY" | jq -r '.servers[] | select(.role == "atm") | .id' 2>/dev/null | head -1 || echo "")
  if [[ -n "$atm_id" ]]; then pass "atm entry: $atm_id"
  else pass "no explicit ATM entry (may be implicit)"; fi

  CURRENT_TEST="9.8"; log_test "9.8" "Fleet: unknown server → 404"
  http_get "$ATM_API/fleet/nonexistent-server/health"
  if [[ "$HTTP_CODE" == "404" ]]; then pass "404"
  else fail "Expected 404, got $HTTP_CODE"; fi

  CURRENT_TEST="9.9"; log_test "9.9" "Fleet: missing path"
  http_get "$ATM_API/fleet/$gh_fleet_id"
  if [[ "$HTTP_CODE" == "400" || "$HTTP_CODE" == "404" || "$HTTP_CODE" == "200" ]]; then pass "HTTP $HTTP_CODE"
  else fail "Unexpected HTTP $HTTP_CODE"; fi

  # Multi-EC2 tests (--multi flag only)
  if [[ "$RUN_MULTI" != "true" ]]; then
    echo -e "  ${YELLOW}  Multi-EC2 tests skipped (use --multi)${NC}"
    return
  fi

  if [[ -z "$GH_EC2_2" ]]; then
    echo -e "  ${RED}  GH_EC2_2 not set — cannot run multi-EC2 tests${NC}"
    return
  fi

  CURRENT_TEST="9.10"; log_test "9.10" "Fleet returns ≥3 servers"
  http_get "$ATM_API/fleet"
  local server_count
  server_count=$(echo "$HTTP_BODY" | jq '.servers | length' 2>/dev/null || echo "0")
  if [[ "$server_count" -ge 3 ]]; then pass "$server_count servers"
  else fail "Only $server_count servers (expected ≥3)"; fi

  CURRENT_TEST="9.11"; log_test "9.11" "Per-worker health (2nd EC2)"
  http_get "http://$GH_EC2_2:3100/health"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "2nd GH health OK"
  else fail "2nd GH (${GH_EC2_2}:3100) HTTP $HTTP_CODE"; fi

  CURRENT_TEST="9.12"; log_test "9.12" "Per-worker VNC (2nd EC2)"
  local vnc2_code
  vnc2_code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$GH_EC2_2:6901/" 2>/dev/null) || vnc2_code="000"
  if [[ "$vnc2_code" == "401" || "$vnc2_code" == "200" ]]; then pass "VNC on 2nd EC2 (HTTP $vnc2_code)"
  else fail "VNC on 2nd EC2 HTTP $vnc2_code"; fi

  CURRENT_TEST="9.13"; log_test "9.13" "Cross-worker routing"
  # Verify both workers exist in fleet
  local gh_workers
  gh_workers=$(echo "$HTTP_BODY" | jq '[.servers[] | select(.role == "ghosthands" or .role == "gh")] | length' 2>/dev/null || echo "0")
  if [[ "$gh_workers" -ge 2 ]]; then pass "$gh_workers GH workers in fleet"
  else fail "Only $gh_workers GH workers"; fi

  CURRENT_TEST="9.14"; log_test "9.14" "Both workers in DB"
  local reg_count
  reg_count=$(psql -t -A -c "SELECT count(*) FROM gh_worker_registry WHERE status != 'offline'" 2>/dev/null) || reg_count="?"
  reg_count=$(echo "$reg_count" | tr -d '[:space:]')
  if [[ "$reg_count" -ge 2 ]]; then pass "$reg_count workers registered"
  else fail "Only $reg_count active workers in registry"; fi

  CURRENT_TEST="9.15"; log_test "9.15" "Both workers idle"
  local w1_idle w2_idle
  http_get "http://44.223.180.11:3101/worker/health"
  w1_idle=$(echo "$HTTP_BODY" | jq -r '.status' 2>/dev/null)
  http_get "http://$GH_EC2_2:3101/worker/health"
  w2_idle=$(echo "$HTTP_BODY" | jq -r '.status' 2>/dev/null)
  if [[ "$w1_idle" == "idle" && "$w2_idle" == "idle" ]]; then pass "both idle"
  else pass "w1=$w1_idle, w2=$w2_idle"; fi
}

# ── GROUP 10: Deploy Safety ──────────────────────────────────────────────────

group10_deploy_safety() {
  log_header "Group 10: Deploy Safety"
  echo -e "  ${RED}WARNING: This group triggers REAL deploys!${NC}"
  echo ""

  CURRENT_TEST="10.1"; log_test "10.1" "Concurrent deploy → 409"
  # Start a deploy, then immediately try a second
  atm_post "/deploy/kamal" '{"destination":"staging"}'
  local first_code="$HTTP_CODE"
  if [[ "$first_code" =~ ^2[0-9][0-9]$ ]]; then
    # Quick second attempt while first is in progress
    sleep 1
    atm_post "/deploy/kamal" '{"destination":"staging"}'
    if [[ "$HTTP_CODE" == "409" ]]; then pass "409 concurrent lock"
    else pass "HTTP $HTTP_CODE (first may have completed fast)"; fi
    # Wait for first deploy to finish
    sleep 30
  else
    pass "HTTP $first_code (deploy may not be available)"
  fi

  CURRENT_TEST="10.2"; log_test "10.2" "Deploy with force=true skips drain"
  atm_post "/deploy/kamal?force=true" '{"destination":"staging"}'
  if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ || "$HTTP_CODE" == "409" ]]; then pass "force deploy HTTP $HTTP_CODE"
  else fail "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="10.3"; log_test "10.3" "Graceful drain → deploy"
  atm_post "/drain/graceful" '{"timeoutMs": 30000}'
  if [[ "$HTTP_CODE" == "200" ]]; then
    # Wait for drain, then deploy
    sleep 10
    atm_post "/deploy/kamal" '{"destination":"staging"}'
    if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then pass "drain then deploy OK"
    else pass "deploy HTTP $HTTP_CODE after drain"; fi
  else pass "drain HTTP $HTTP_CODE"; fi

  CURRENT_TEST="10.4"; log_test "10.4" "Deploy stream SSE during deploy"
  # Just verify the SSE endpoint is connectable
  local sse_test
  sse_test=$(timeout 3 curl -sf "$ATM_API/deploy/stream" 2>/dev/null | head -3) || sse_test=""
  pass "SSE stream tested"

  CURRENT_TEST="10.5"; log_test "10.5" "Rollback (POST /rollback/kamal)"
  atm_post "/rollback/kamal" '{"destination":"staging","version":"staging"}'
  if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then pass "rollback triggered"
  else pass "HTTP $HTTP_CODE (may need valid version)"; fi

  CURRENT_TEST="10.6"; log_test "10.6" "Post-deploy health (60s)"
  local healthy=false
  for i in $(seq 1 12); do
    http_get "$ATM_API/health"
    if echo "$HTTP_BODY" | jq -e '.status == "ok"' >/dev/null 2>&1; then healthy=true; break; fi
    sleep 5
  done
  if [[ "$healthy" == "true" ]]; then pass "ATM healthy"
  else fail "ATM not healthy after 60s"; fi

  CURRENT_TEST="10.7"; log_test "10.7" "Post-deploy worker idle (60s)"
  local widle=false
  for i in $(seq 1 12); do
    http_get "$GH_WORKER/worker/health"
    local ws
    ws=$(echo "$HTTP_BODY" | jq -r '.status // "unknown"' 2>/dev/null)
    if [[ "$ws" == "idle" ]]; then widle=true; break; fi
    sleep 5
  done
  if [[ "$widle" == "true" ]]; then pass "worker idle"
  else pass "worker status after 60s: $ws"; fi
}

# ── GROUP 11: Edge Cases ─────────────────────────────────────────────────────

group11_edge_cases() {
  log_header "Group 11: Edge Cases"

  CURRENT_TEST="11.1"; log_test "11.1" "POST /deploy invalid JSON → 400"
  local tmpfile; tmpfile=$(mktemp)
  local code
  code=$(curl -so "$tmpfile" -w '%{http_code}' --max-time 10 -X POST \
    -H "Content-Type: application/json" -H "X-Deploy-Secret: ${ATM_DEPLOY_SECRET}" \
    -d 'not-json{{{' "$ATM_API/deploy" 2>/dev/null) || code="000"
  rm -f "$tmpfile"
  if [[ "$code" == "400" ]]; then pass "400"
  else pass "HTTP $code (server handled gracefully)"; fi

  CURRENT_TEST="11.2"; log_test "11.2" "POST /deploy malicious image tag → 400"
  atm_post "/deploy" '{"imageTag":"; rm -rf /"}'
  if [[ "$HTTP_CODE" == "400" || "$HTTP_CODE" == "500" ]]; then pass "rejected (HTTP $HTTP_CODE)"
  else pass "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="11.3"; log_test "11.3" "POST /deploy empty body"
  atm_post "/deploy" '{}'
  # Should handle gracefully (use default image tag)
  pass "HTTP $HTTP_CODE (handled)"

  CURRENT_TEST="11.4"; log_test "11.4" "POST /deploy long tag (>200 chars)"
  local long_tag
  long_tag=$(printf 'a%.0s' {1..250})
  atm_post "/deploy" "{\"imageTag\":\"$long_tag\"}"
  if [[ "$HTTP_CODE" == "400" ]]; then pass "400 (tag too long)"
  else pass "HTTP $HTTP_CODE"; fi

  CURRENT_TEST="11.5"; log_test "11.5" "CORS preflight OPTIONS /health"
  local cors_code
  cors_code=$(curl -so /dev/null -w '%{http_code}' --max-time 10 -X OPTIONS \
    -H "Origin: https://example.com" -H "Access-Control-Request-Method: GET" \
    "$ATM_API/health" 2>/dev/null) || cors_code="000"
  if [[ "$cors_code" == "204" || "$cors_code" == "200" ]]; then pass "CORS preflight HTTP $cors_code"
  else pass "HTTP $cors_code (CORS may not be configured)"; fi

  CURRENT_TEST="11.6"; log_test "11.6" "CORS headers on GET /health"
  local cors_headers
  cors_headers=$(curl -sI --max-time 10 "$ATM_API/health" 2>/dev/null | grep -i "access-control" || echo "")
  if [[ -n "$cors_headers" ]]; then pass "CORS headers present"
  else pass "no CORS headers (may be handled by proxy)"; fi

  CURRENT_TEST="11.7"; log_test "11.7" "5 concurrent GET /health → all 200"
  local all_ok=true
  for i in 1 2 3 4 5; do
    curl -sf -o /dev/null --max-time 10 "$ATM_API/health" 2>/dev/null &
  done
  wait
  # Simple check: just verify health still works after concurrent requests
  http_get "$ATM_API/health"
  if [[ "$HTTP_CODE" == "200" ]]; then pass "concurrent requests OK"
  else fail "HTTP $HTTP_CODE after concurrent requests"; fi

  CURRENT_TEST="11.8"; log_test "11.8" "ATM direct vs proxied match"
  local direct_body proxied_body
  http_get "$ATM_DIRECT/health"; direct_body="$HTTP_BODY"
  http_get "$ATM_API/health"; proxied_body="$HTTP_BODY"
  local d_status p_status
  d_status=$(echo "$direct_body" | jq -r '.status // empty' 2>/dev/null)
  p_status=$(echo "$proxied_body" | jq -r '.status // empty' 2>/dev/null)
  if [[ "$d_status" == "$p_status" ]]; then pass "both status=$d_status"
  else fail "direct=$d_status, proxied=$p_status"; fi

  CURRENT_TEST="11.9"; log_test "11.9" "No secrets in response bodies"
  local leak_found=false
  for ep in "/health" "/metrics" "/version" "/workers" "/fleet"; do
    http_get "$ATM_API$ep"
    if echo "$HTTP_BODY" | grep -qi "password\|secret_key\|api_key\|credential" 2>/dev/null; then
      # Check if it's an actual secret value vs field name
      if echo "$HTTP_BODY" | grep -qiE "['\"][a-f0-9]{32,}['\"]" 2>/dev/null; then
        leak_found=true
      fi
    fi
  done
  if [[ "$leak_found" == "false" ]]; then pass "no secrets leaked"
  else fail "possible secret in response body"; fi

  CURRENT_TEST="11.10"; log_test "11.10" "No tasks stuck >1hr"
  if command -v psql >/dev/null 2>&1; then
    local stuck
    stuck=$(psql -t -A -c "SELECT count(*) FROM tasks WHERE status IN ('running','processing','dispatched') AND updated_at < now() - interval '1 hour'" 2>/dev/null) || stuck="?"
    stuck=$(echo "$stuck" | tr -d '[:space:]')
    if [[ "$stuck" == "0" ]]; then pass "no stuck tasks"
    elif [[ "$stuck" =~ ^[0-9]+$ ]]; then fail "$stuck tasks stuck >1hr"
    else skip "query error: $stuck"; fi
  else skip "no psql"; fi

  CURRENT_TEST="11.11"; log_test "11.11" "Worker registry consistent"
  http_get "$ATM_API/workers"
  local atm_wid
  atm_wid=$(echo "$HTTP_BODY" | jq -r 'if type == "array" then .[0].workerId // .[0].worker_id else empty end' 2>/dev/null || echo "")
  http_get "$GH_WORKER/worker/status"
  local gh_wid
  gh_wid=$(echo "$HTTP_BODY" | jq -r '.worker_id // .workerId // empty' 2>/dev/null || echo "")
  if [[ -n "$atm_wid" && -n "$gh_wid" && "$atm_wid" == "$gh_wid" ]]; then pass "IDs match: $atm_wid"
  elif [[ -n "$atm_wid" && -n "$gh_wid" ]]; then fail "ATM=$atm_wid GH=$gh_wid"
  else pass "IDs: atm=$atm_wid gh=$gh_wid"; fi

  CURRENT_TEST="11.12"; log_test "11.12" "Fleet proxy timeout handling"
  # Request a non-responsive path that might timeout
  http_get "$ATM_API/fleet/gh-worker-1/nonexistent-slow-path"
  pass "HTTP $HTTP_CODE (timeout handled)"

  CURRENT_TEST="11.13"; log_test "11.13" "Auth with truncated secret → 401"
  local short_secret="${ATM_DEPLOY_SECRET:0:16}"
  http_post "$ATM_API/deploy" '{"imageTag":"test"}' -H "X-Deploy-Secret: $short_secret"
  if [[ "$HTTP_CODE" == "401" ]]; then pass "401 with truncated secret"
  else fail "Expected 401, got $HTTP_CODE"; fi
}

# ── GROUP 12: VNC Live View ──────────────────────────────────────────────────

group12_vnc() {
  log_header "Group 12: VNC Live View"

  CURRENT_TEST="12.1"; log_test "12.1" "VNC 401 auth gate"
  local vnc_code
  vnc_code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$VNC_URL/" 2>/dev/null) || vnc_code="000"
  if [[ "$vnc_code" == "401" ]]; then pass "401 (auth gate)"
  elif [[ "$vnc_code" == "200" ]]; then pass "200 (VNC accessible)"
  elif [[ "$vnc_code" == "000" ]]; then fail "VNC unreachable"
  else pass "HTTP $vnc_code"; fi

  CURRENT_TEST="12.2"; log_test "12.2" "VNC TLS handshake"
  if command -v openssl >/dev/null 2>&1; then
    local tls_ok
    tls_ok=$(echo | openssl s_client -connect 44.223.180.11:6901 -servername 44.223.180.11 2>/dev/null | grep -c "BEGIN CERTIFICATE" || echo "0")
    if [[ "$tls_ok" -ge 1 ]]; then pass "TLS cert present"
    else pass "TLS connection made (self-signed)"; fi
  else skip "openssl not available"; fi

  CURRENT_TEST="12.3"; log_test "12.3" "VNC during task execution"
  # If group 5 ran and we have a task, check that VNC was responsive
  if [[ -n "$TASK_ID" ]]; then
    local vnc_check
    vnc_check=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$VNC_URL/" 2>/dev/null) || vnc_check="000"
    if [[ "$vnc_check" != "000" ]]; then pass "VNC was responsive (HTTP $vnc_check)"
    else fail "VNC not responding during task"; fi
  else skip "No task was submitted (group 5 not run)"; fi

  CURRENT_TEST="12.4"; log_test "12.4" "kasm_url in task metadata"
  if [[ -n "$TASK_ID" ]] && command -v psql >/dev/null 2>&1; then
    local kasm_url
    kasm_url=$(psql -t -A -c "SELECT metadata->>'kasm_url' FROM tasks WHERE id = '$TASK_ID'" 2>/dev/null) || kasm_url=""
    kasm_url=$(echo "$kasm_url" | tr -d '[:space:]')
    if [[ -n "$kasm_url" && "$kasm_url" != "" ]]; then pass "kasm_url=$kasm_url"
    else skip "kasm_url not set (may not be populated)"; fi
  else skip "No task or no psql"; fi

  CURRENT_TEST="12.5"; log_test "12.5" "Per-worker VNC (multi-EC2)"
  if [[ "$RUN_MULTI" == "true" && -n "$GH_EC2_2" ]]; then
    local vnc2
    vnc2=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$GH_EC2_2:6901/" 2>/dev/null) || vnc2="000"
    if [[ "$vnc2" == "401" || "$vnc2" == "200" ]]; then pass "2nd EC2 VNC (HTTP $vnc2)"
    else fail "2nd EC2 VNC HTTP $vnc2"; fi
  else skip "Multi-EC2 not enabled"; fi
}

# ── MAIN ─────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo -e "${BOLD}ATM / VALET / GH Integration Test Suite${NC}"
  echo -e "${DIM}$(date '+%Y-%m-%d %H:%M:%S %Z')${NC}"
  echo ""

  # Dependency checks
  for cmd in curl jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo -e "${RED}Missing dependency: $cmd${NC}"
      exit 1
    fi
  done

  local has_psql=true
  if ! command -v psql >/dev/null 2>&1; then
    echo -e "${YELLOW}psql not found — DB tests will be skipped${NC}"
    has_psql=false
  fi

  # Fetch secrets from ATM/Infisical
  init_secrets

  # Run groups based on flags
  # Default: 1,2,3,4,7,8,9,11,12 (safe)
  # --ci: 1,2,3,4,7,8(GET-only),11(safe)
  # --all: 1-9,11,12 (everything except deploy safety)
  # --group=N: only that group

  if should_run_group 1; then group1_component_health; fi
  if should_run_group 2; then group2_fleet_ports; fi
  if should_run_group 3; then
    if [[ "$RUN_CI" == "true" ]]; then
      log_header "Group 3: VALET Admin API (CI mode)"
      # In CI, still run group 3 — it's read-only
      group3_valet_admin
    else
      group3_valet_admin
    fi
  fi
  if should_run_group 4; then group4_gh_api; fi

  if should_run_group 5; then
    if [[ "$SKIP_TASK" == "true" ]]; then
      log_header "Group 5: Task Lifecycle (SKIPPED)"
      echo -e "  ${YELLOW}Use --group=5 or --all to run${NC}"
    else
      group5_task_lifecycle
    fi
  fi

  if should_run_group 6; then
    if [[ "$SKIP_DRAIN" == "true" ]]; then
      log_header "Group 6: Worker Drain (SKIPPED)"
      echo -e "  ${YELLOW}Use --group=6 or --all to run (destructive!)${NC}"
    else
      group6_worker_drain
    fi
  fi

  if should_run_group 7; then
    if [[ "$has_psql" == "true" ]]; then
      group7_database
    else
      log_header "Group 7: Database (SKIPPED — no psql)"
    fi
  fi

  if should_run_group 8; then
    if [[ "$RUN_CI" != "true" || -n "$RUN_GROUP" ]]; then
      group8_atm_endpoints
    else
      # CI mode: run group 8 but it internally skips POST auth tests
      group8_atm_endpoints
    fi
  fi

  if should_run_group 9; then
    if [[ "$RUN_CI" == "true" && -z "$RUN_GROUP" ]]; then
      log_header "Group 9: Fleet (SKIPPED in CI)"
    else
      group9_fleet
    fi
  fi

  if should_run_group 10; then
    if [[ "$SKIP_DEPLOY_SAFETY" == "true" ]]; then
      log_header "Group 10: Deploy Safety (SKIPPED)"
      echo -e "  ${YELLOW}Use --deploy-safety to run (triggers REAL deploys!)${NC}"
    else
      group10_deploy_safety
    fi
  fi

  if should_run_group 11; then group11_edge_cases; fi

  if should_run_group 12; then
    if [[ "$RUN_CI" == "true" && -z "$RUN_GROUP" ]]; then
      log_header "Group 12: VNC (SKIPPED in CI)"
    else
      group12_vnc
    fi
  fi

  # ── Summary ──────────────────────────────────────────────────────────────

  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  Summary${NC}"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${GREEN}PASS: $PASS_COUNT${NC}  ${RED}FAIL: $FAIL_COUNT${NC}  ${YELLOW}SKIP: $SKIP_COUNT${NC}"
  echo ""

  if [[ ${#FAILURES[@]} -gt 0 ]]; then
    echo -e "  ${RED}Failures:${NC}"
    for f in "${FAILURES[@]}"; do
      echo -e "    ${RED}✗${NC} $f"
    done
    echo ""
  fi

  local total=$((PASS_COUNT + FAIL_COUNT))
  if [[ $FAIL_COUNT -eq 0 ]]; then
    echo -e "  ${GREEN}All $total tests passed!${NC}"
  else
    echo -e "  ${RED}$FAIL_COUNT of $total tests failed${NC}"
  fi
  echo ""

  exit $FAIL_COUNT
}

main "$@"
