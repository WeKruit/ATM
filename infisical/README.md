# Infisical Setup

Self-hosted Infisical instance for WeKruit secrets management.

## Local Development

```bash
cd infisical
export INFISICAL_ENCRYPTION_KEY=$(openssl rand -hex 16)
export INFISICAL_AUTH_SECRET=$(openssl rand -hex 32)
docker compose up -d
```

Access at http://localhost:8080

## Production (Fly.io)

See WEK-202 for full deployment steps.

1. `fly apps create infisical-wekruit`
2. `fly postgres create --name infisical-db`
3. Set up Upstash Redis
4. `fly deploy --image infisical/infisical:latest`
5. Set secrets via `fly secrets set`
6. Access at https://infisical-wekruit.fly.dev
