# Cross-System CI/CD Monitor Runbook

This runbook covers operational monitoring for `ATM`, `VALET`, `GH-Desktop-App`, `GHOST-HANDS`, and the shared EC2 control plane.

## Source of Truth

- GitHub Actions is the primary release signal.
- Infisical `/atm/ATM_DEPLOY_SECRET` is the canonical deploy-secret source.
- AWS `ghosthands/<environment>` is the legacy mirror that still feeds some consumers.
- ATM EC2 runtime is the last-mile runtime source that desktop and deploy callers must match.

## Primary Monitor

Run the ATM GitHub Actions workflow:

- Workflow: `CI/CD Monitor`
- Schedule: every 30 minutes
- Manual run:

```bash
gh workflow run "CI/CD Monitor" --repo WeKruit/ATM -f environment=all
```

The workflow produces:

- A markdown summary in `GITHUB_STEP_SUMMARY`
- JSON artifacts for `staging` and `production`
- A failed workflow if any blocker is detected

## Canonical Secrets API

Use ATM as the only write surface for app/environment keys.

- Metadata:

```bash
curl -sS http://atm-direct.wekruit.com:8080/admin/secrets/apps \
  -H "X-Deploy-Secret: $ATM_DEPLOY_SECRET"
```

- List one app/environment:

```bash
curl -sS "http://atm-direct.wekruit.com:8080/admin/secrets/vars?app=ghosthands&environment=staging" \
  -H "X-Deploy-Secret: $ATM_DEPLOY_SECRET"
```

- Add or update one key:

```bash
curl -sS -X PUT http://atm-direct.wekruit.com:8080/admin/secrets/vars \
  -H "Content-Type: application/json" \
  -H "X-Deploy-Secret: $ATM_DEPLOY_SECRET" \
  -d '{
    "app": "ghosthands",
    "environment": "staging",
    "vars": [{ "key": "MY_NEW_KEY", "value": "value" }]
  }'
```

- Delete one key:

```bash
curl -sS -X DELETE http://atm-direct.wekruit.com:8080/admin/secrets/vars \
  -H "Content-Type: application/json" \
  -H "X-Deploy-Secret: $ATM_DEPLOY_SECRET" \
  -d '{
    "app": "ghosthands",
    "environment": "staging",
    "keys": ["MY_NEW_KEY"]
  }'
```

ATM writes Infisical first, then fans out to the app’s configured GitHub/AWS/runtime targets.

## Stack Verify

Manual cross-repo verification is driven by the ATM workflow:

- Workflow: `Stack Verify`
- Inputs:
  - `environment=staging|production|all`
  - `mode=ci|deploy|full`
  - `wait=true|false`

Example:

```bash
gh workflow run "Stack Verify" --repo WeKruit/ATM -f environment=production -f mode=ci -f wait=true
```

## How the Monitor Interprets Health

### Expected Healthy Idle State

ATM `/health` may return:

```json
{
  "status": "idle",
  "apiHealthy": false,
  "workerStatus": "all-stopped"
}
```

This is healthy when no GhostHands worker is running. Do not treat this as an ATM outage.

### Blocker Conditions

- ATM EC2 instance is missing or not `running`
- ATM `/health` is unreachable
- A monitored workflow fails on the environment branch
- A monitored workflow stays queued or in progress beyond the stale threshold
- Deploy-secret fingerprints differ between Infisical, AWS, and ATM runtime
- A required GitHub environment secret is missing
- A repo is using repo-level fallback instead of environment-scoped deploy secrets

### Informational Noise

These should not gate releases:

- `.github/workflows/claude.yml`
- `.github/workflows/claude-code-review.yml`
- `Engine Update`
- Other bot-only or review-helper workflows

## Daily Review Flow

1. Open the latest `CI/CD Monitor` run in the ATM repo.
2. Read blockers first.
3. If there are no blockers, scan warnings.
4. Verify deploy-secret parity lines for the target environment.
5. Verify ATM infra lines:
   - ATM EC2 running
   - ATM `/health` reachable
6. If `VALET Integration Tests` are red, confirm whether the failure is the known staging fixture issue:
   - `Resume ... not found`
   - If yes, treat it as a product/test-data blocker, not ATM infra drift

## Pre-Deploy Procedure

1. Verify the branch CI for the repo being deployed.
2. Verify `CI/CD Monitor` is green for the target environment.
3. Check deploy-secret parity before deploying.
4. Confirm the target repo is not relying on repo-level fallback secrets.
5. If GhostHands workers are active, inspect worker drain safety before restarting anything.

## Post-Deploy Procedure

1. Confirm the deploy workflow itself is green.
2. Manually re-run `CI/CD Monitor` for the target environment.
3. Run `Stack Verify` for the target environment in `ci` mode.
4. Check ATM health.
5. Check the downstream workflow that consumes ATM:
   - `GH-Desktop-App CI/CD`
   - `VALET CD → Staging` or `CD → Production`
   - `GHOST-HANDS CI/CD` or `Publish Engine`
6. Confirm deploy-secret parity is still synced.

## Incident Playbooks

### Desktop Build Fails at Prepare Build Env

Symptoms:

- `GH-Desktop-App CI/CD` fails in `Prepare build env`
- Error includes `X-Deploy-Secret` unauthorized or missing

Actions:

1. Check `CI/CD Monitor` secret scope for `GH-Desktop-App`.
2. Check deploy-secret parity for the target environment.
3. Confirm `GH-Desktop-App` environment has:
   - `ATM_HOST`
   - `ATM_DEPLOY_SECRET`
   - `GH_DEPLOY_SECRET`
4. If the environment is missing deploy secrets but repo-level secrets exist, treat that as drift and repair the environment scope.

### VALET Staging Integration Tests Fail

Current known non-infra failure:

- `Resume ... not found`

Actions:

1. Check whether `CI/CD Monitor` shows ATM and deploy-secret parity as healthy.
2. If yes, treat the failure as staging data/test fixture drift.
3. Only escalate to ATM infra if:
   - ATM `/health` is unreachable
   - EC2 is down
   - deploy-secret parity drift exists
   - sandbox lifecycle calls fail outside the known data path

### GhostHands Release Appears Broken

Actions:

1. Ignore `claude*` workflow failures unless they are specifically part of the operator workflow.
2. Check `GHOST-HANDS CI/CD`, `Publish Engine`, and `Rollback`.
3. If `Publish Engine` is green and only bot workflows are failing, release path is still healthy.

### ATM Health / EC2 Incident

Actions:

1. Check EC2 state:

```bash
aws ec2 describe-instances \
  --filters Name=tag:Name,Values=wekruit-atm-server \
  --query 'Reservations[].Instances[].{State:State.Name,PublicIp:PublicIpAddress,InstanceId:InstanceId}'
```

2. Check ATM health:

```bash
curl -sS http://atm-direct.wekruit.com:8080/health
```

3. If direct host access is needed:

```bash
cd /opt/atm
docker compose ps
docker compose logs --tail=100 atm-api
```

## Manual Recovery Commands

### ATM

```bash
cd /Users/adam/Desktop/WeKruit/VALET\ \&\ GH/ATM
./scripts/deploy-manual.sh status
./scripts/deploy-manual.sh health
./scripts/deploy-manual.sh worker-status
./scripts/deploy-manual.sh list-workers
```

### GhostHands EC2

```bash
cd /Users/adam/Desktop/WeKruit/VALET\ \&\ GH/GHOST-HANDS
./scripts/deploy-ec2.sh --status
./scripts/deploy-ec2.sh --verify
```

### GitHub Actions

```bash
gh run list --repo WeKruit/ATM --limit 5
gh run list --repo WeKruit/VALET --limit 5
gh run list --repo WeKruit/GH-Desktop-App --limit 5
gh run list --repo WeKruit/GHOST-HANDS --limit 5
```

### Canonical Fanout Replay

```bash
curl -sS -X POST http://atm-direct.wekruit.com:8080/admin/secrets/fanout \
  -H "Content-Type: application/json" \
  -H "X-Deploy-Secret: $ATM_DEPLOY_SECRET" \
  -d '{"app":"ghosthands","environment":"staging"}'
```

## Environment Secret Requirements

### ATM

- `INFISICAL_CLIENT_ID`
- `INFISICAL_CLIENT_SECRET`
- `INFISICAL_PROJECT_ID`

### VALET

- `ATM_BASE_URL`
- `ATM_DEPLOY_SECRET`

### GH-Desktop-App

- `ATM_HOST`
- `ATM_DEPLOY_SECRET`
- `GH_DEPLOY_SECRET`

### GHOST-HANDS

- `ATM_DEPLOY_SECRET`
- `GH_DEPLOY_SECRET`

## Current Known Gaps To Track Until Resolved

- `VALET Integration Tests` on staging are still failing on missing staging resume data (`Resume ... not found`).
- Cross-repo manual dispatch via the ATM `Stack Verify` workflow depends on a GitHub token with access to all WeKruit repos.
