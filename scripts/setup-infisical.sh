#!/usr/bin/env bash
set -euo pipefail

# Infisical Setup Script
#
# One-time setup for Infisical on Fly.io.
# TODO (WEK-202): Implement Infisical deployment automation
#
# Steps:
#   1. fly apps create infisical-wekruit
#   2. fly postgres create --name infisical-db
#   3. Set up Upstash Redis
#   4. fly deploy --image infisical/infisical:latest
#   5. Set secrets (ENCRYPTION_KEY, AUTH_SECRET, SITE_URL, DB_CONNECTION_URI, REDIS_URL)

echo "Infisical setup not yet implemented. See ATM/infisical/README.md for manual steps."
exit 1
