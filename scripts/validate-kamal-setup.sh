#!/bin/bash
set -e

echo "=== 1. Kamal CLI ==="
kamal version

echo "=== 2. AWS CLI ==="
aws --version
aws ecr get-login-password --region us-east-1 | head -c 20
echo "... (ECR token OK)"

echo "=== 3. SSH connectivity ==="
ssh -i /root/.ssh/gh-deploy-key -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
  ubuntu@44.223.180.11 "docker ps --format '{{.Names}}' | head -5"

echo "=== 4. Kamal config ==="
kamal config -d staging

echo "=== 5. Kamal lock status ==="
kamal lock status -d staging

echo "=== 6. Infisical API ==="
curl -sf https://infisical-wekruit.fly.dev/api/status | jq .message

echo "=== All checks passed ==="
