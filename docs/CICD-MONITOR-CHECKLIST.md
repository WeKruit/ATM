# CI/CD Operator Checklist

Use this checklist before and after any release-touching change across `ATM`, `VALET`, `GH-Desktop-App`, or `GHOST-HANDS`.

## Daily Health Review

- [ ] Open the latest `CI/CD Monitor` run in GitHub Actions for the ATM repo.
- [ ] Confirm `staging` and `production` reports were generated.
- [ ] Confirm there are no blockers for:
  - [ ] `ATM` workflows
  - [ ] `VALET` workflows
  - [ ] `GH-Desktop-App` workflow
  - [ ] `GHOST-HANDS` release workflows
- [ ] Confirm ATM EC2 is `running`.
- [ ] Confirm ATM `/health` is reachable.
- [ ] If ATM reports `status:"idle"` and `workerStatus:"all-stopped"`, treat that as healthy idle, not an incident.
- [ ] Review deploy-secret parity for:
  - [ ] Infisical `/atm/ATM_DEPLOY_SECRET`
  - [ ] AWS `ghosthands/<env>`
  - [ ] ATM EC2 runtime `ATM_DEPLOY_SECRET`
- [ ] Review GitHub environment scope drift for:
  - [ ] `ATM`
  - [ ] `VALET`
  - [ ] `GH-Desktop-App`
  - [ ] `GHOST-HANDS`

## Pre-Deploy Checks

- [ ] Any new app/environment key was added through ATM canonical secrets, not directly in AWS/GitHub.
- [ ] `ATM` relevant CI is green for the branch being deployed.
- [ ] `VALET` branch CI is green.
- [ ] `GH-Desktop-App` latest branch build is green or intentionally not part of the deploy.
- [ ] `GHOST-HANDS` image/build pipeline is green if the release touches engine/runtime code.
- [ ] No deploy-secret parity blockers exist for the target environment.
- [ ] No repo is relying on repo-level secret fallback for the target environment.
- [ ] ATM `/health` is reachable before starting a deploy.
- [ ] If workers are active, confirm deploy safety before restart/drain actions.

## Post-Deploy Verification

- [ ] Check the target GitHub Actions deploy run completed successfully.
- [ ] Re-run `CI/CD Monitor` manually for the target environment.
- [ ] Run `Stack Verify` for the target environment in `ci` mode.
- [ ] Confirm ATM `/health` is still reachable after the deploy.
- [ ] Confirm the relevant product workflow is green:
  - [ ] `VALET CD → Staging` or `CD → Production`
  - [ ] `GH-Desktop-App CI/CD`
  - [ ] `GHOST-HANDS CI/CD` or `Publish Engine`
- [ ] Confirm no new secret parity drift appeared after the deploy.

## Immediate Escalation Triggers

- [ ] ATM `/health` is unreachable.
- [ ] ATM EC2 is not `running`.
- [ ] Deploy-secret fingerprints drift across Infisical, AWS, and ATM runtime.
- [ ] A required GitHub environment is missing.
- [ ] A production workflow is falling back to repo-level deploy secrets.
- [ ] `VALET` staging E2E starts failing for infrastructure reasons instead of known test-data issues.

## One-Key Change Flow

- [ ] Call ATM `PUT /admin/secrets/vars` once with `{ app, environment, vars }`.
- [ ] Confirm the fanout result shows the expected GitHub/AWS/runtime targets.
- [ ] Reload the ATM dashboard or `GET /admin/secrets/vars` to confirm the canonical value exists.
