# ATM (Automation & Tooling Manager)

Centralized operations platform for the WeKruit infrastructure. Owns secrets management, deployments, fleet health, and container lifecycle — decoupled from both VALET (product) and GHOST-HANDS (automation engine).

## Architecture

- **Infisical** (Fly.io) — Self-hosted secrets management with web UI, Fly.io auto-sync, EC2 agent pull
- **ATM API** (EC2, port 8080) — Bun.js HTTP server wrapping Docker Engine API for deploys, rollback, health, metrics
- **VALET admin UI** consumes both Infisical API (secrets) and ATM API (deploys/fleet)

## Sibling Projects

- `../VALET/` — User-facing app (Turborepo + pnpm, deployed on Fly.io)
- `../GHOST-HANDS/` — Browser automation engine (Bun, deployed on EC2 via Docker)

## Code Style

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **HTTP framework:** Bun.serve (native, no framework dependency — migrated from GH deploy-server)
- **Docker interaction:** Direct Docker Engine API via unix socket (Bun fetch with `unix:` option)
- **ECR auth:** Reads host Docker config.json (no @aws-sdk/client-ecr in runtime)
- **No ORM** — file-backed JSON for deploy history

## Directory Structure

```
ATM/
├── CLAUDE.md                      # This file
├── atm-api/
│   ├── src/
│   │   ├── server.ts              # Main HTTP server (migrated from GH deploy-server.ts)
│   │   ├── docker-client.ts       # Docker Engine API wrapper
│   │   ├── ecr-auth.ts            # ECR token management
│   │   ├── container-configs.ts   # GH service definitions
│   │   ├── deploy-history.ts      # Deploy record persistence (JSON file-backed)
│   │   ├── infisical-client.ts    # Infisical SDK wrapper (replaces AWS SM)
│   │   ├── kamal-runner.ts        # Kamal CLI wrapper for deploy/rollback
│   │   └── rollback.ts            # Rollback logic using deploy history
│   ├── package.json
│   └── tsconfig.json
├── scripts/
│   ├── deploy-manual.sh           # Manual deploy escape hatch (migrated from GH)
│   └── setup-infisical.sh         # One-time Infisical setup
├── infisical/
│   ├── fly.toml                   # Fly.io deployment config
│   ├── docker-compose.yml         # Local dev stack
│   └── README.md                  # Infisical setup guide
├── docker-compose.yml             # ATM API service for EC2
├── .env.example                   # Required environment variables
└── .gitignore
```

## Environment Variables

See `.env.example` for all required variables. Key ones:

| Variable | Description |
|----------|-------------|
| `GH_DEPLOY_SECRET` | Shared secret for deploy auth (X-Deploy-Secret header) |
| `GH_DEPLOY_PORT` | ATM API listen port (default: 8080) |
| `GH_API_HOST` | GH API hostname (default: localhost) |
| `GH_API_PORT` | GH API port (default: 3100) |
| `GH_WORKER_HOST` | GH Worker hostname (default: localhost) |
| `GH_WORKER_PORT` | GH Worker port (default: 3101) |
| `GH_ENVIRONMENT` | staging or production |
| `ECR_REGISTRY` | ECR registry URL |
| `ECR_REPOSITORY` | ECR repository name (default: ghosthands) |

## Running Locally

```bash
cd atm-api
bun install
bun run dev
```

## Running on EC2

```bash
docker compose up -d
```

## Security Rules

- All POST endpoints require `X-Deploy-Secret` header (timing-safe comparison)
- GET endpoints (health, metrics, containers, workers, version) are unauthenticated (monitoring)
- Never log secret values
- Docker socket access requires appropriate group membership
- ECR tokens expire every 12h — host cron refreshes every 6h

## Testing

```bash
cd atm-api
bun test
```

## Commit Format

```
feat|fix(atm): WEK-XXX description
```
