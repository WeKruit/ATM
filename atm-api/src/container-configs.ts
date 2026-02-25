/**
 * Hardcoded Container Configuration Definitions
 *
 * Defines the 3 GhostHands service containers (API, Worker, Deploy Server)
 * with their Docker create configs, health checks, drain endpoints,
 * and startup/shutdown ordering.
 *
 * These definitions replace docker-compose for deploy-server managed deploys.
 * The deploy-server uses these configs to create containers via Docker API.
 *
 * Environment variables are sourced from process.env (populated by docker-compose
 * env_file and/or AWS Secrets Manager), NOT from reading .env files on disk.
 *
 * @module atm-api/src/container-configs
 */

import type { ContainerCreateConfig } from './docker-client';

/** ECR registry base URL — reads from env, falls back to account default */
const ECR_REGISTRY = process.env.ECR_REGISTRY ?? '168495702277.dkr.ecr.us-east-1.amazonaws.com';
const ECR_REPOSITORY = process.env.ECR_REPOSITORY ?? 'ghosthands';

/**
 * Defines a deployable service container with health check,
 * drain, and ordering metadata.
 */
export interface ServiceDefinition {
  /** Container name (e.g., "ghosthands-api") */
  name: string;
  /** Docker Engine API container create config */
  config: ContainerCreateConfig;
  /** HTTP health check URL (e.g., "http://localhost:3100/health") */
  healthEndpoint?: string;
  /** Max milliseconds to wait for the container to become healthy */
  healthTimeout: number;
  /** Optional HTTP endpoint to POST for graceful drain before stop */
  drainEndpoint?: string;
  /** Max milliseconds to wait for drain to complete */
  drainTimeout: number;
  /** If true, skip this container during self-update (deploy-server) */
  skipOnSelfUpdate: boolean;
  /** Startup ordering — lower numbers start first */
  startOrder: number;
  /** Shutdown ordering — lower numbers stop first */
  stopOrder: number;
}

/**
 * Prefixes of environment variable names that should be passed through
 * to spawned containers.
 */
const PASSTHROUGH_PREFIXES = [
  'DATABASE_', 'SUPABASE_', 'REDIS_', 'GH_', 'ANTHROPIC_', 'DEEPSEEK_',
  'SILICONFLOW_', 'OPENAI_', 'AWS_', 'ECR_', 'CORS_', 'NODE_ENV',
  'MAX_CONCURRENT_', 'JOB_DISPATCH_', 'GHOSTHANDS_', 'KASM_',
];

/**
 * Build env vars array from process.env for passing to new containers.
 */
export function getEnvVarsFromProcess(): string[] {
  const envVars: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value && PASSTHROUGH_PREFIXES.some(p => key.startsWith(p))) {
      envVars.push(`${key}=${value}`);
    }
  }
  return envVars;
}

/**
 * Builds the full ECR image URI from a tag.
 */
function buildEcrImage(imageTag: string): string {
  return `${ECR_REGISTRY}/${ECR_REPOSITORY}:${imageTag}`;
}

/**
 * Builds the API service definition.
 */
function buildApiService(ecrImage: string, envVars: string[]): ServiceDefinition {
  return {
    name: 'ghosthands-api',
    config: {
      Image: ecrImage,
      Cmd: ['bun', 'packages/ghosthands/src/api/server.ts'],
      Env: [...envVars, 'GH_API_PORT=3100'],
      HostConfig: {
        NetworkMode: 'host',
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
      Labels: {
        'gh.service': 'api',
        'gh.managed': 'true',
      },
    },
    healthEndpoint: 'http://localhost:3100/health',
    healthTimeout: 90_000,
    drainEndpoint: undefined,
    drainTimeout: 0,
    skipOnSelfUpdate: false,
    startOrder: 1,
    stopOrder: 3,
  };
}

/**
 * Builds a Worker service definition.
 *
 * @param index - Worker index (0-based) for naming and port assignment
 * @param port - Port for this worker (3101 + index)
 */
function buildWorkerService(ecrImage: string, envVars: string[], index: number, port: number): ServiceDefinition {
  const name = index === 0 ? 'ghosthands-worker' : `ghosthands-worker-${index}`;
  return {
    name,
    config: {
      Image: ecrImage,
      Cmd: ['bun', 'packages/ghosthands/src/workers/main.ts'],
      Env: [...envVars, `GH_WORKER_PORT=${port}`, 'MAX_CONCURRENT_JOBS=1'],
      HostConfig: {
        NetworkMode: 'host',
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
      Labels: {
        'gh.service': 'worker',
        'gh.managed': 'true',
        'gh.worker.index': String(index),
      },
    },
    healthEndpoint: `http://localhost:${port}/worker/health`,
    healthTimeout: 60_000,
    drainEndpoint: `http://localhost:${port}/worker/drain`,
    drainTimeout: 60_000,
    skipOnSelfUpdate: false,
    startOrder: 2 + index,
    stopOrder: 1,
  };
}

/**
 * Returns GhostHands service definitions (API + Workers), sorted by startOrder.
 *
 * NOTE: The deploy-server (ghosthands-deploy-server) has been replaced by the
 * standalone ATM API, which runs via docker-compose (not managed by itself).
 * Workers scale based on GH_WORKER_COUNT env var (default 1).
 */
export function getServiceConfigs(
  imageTag: string,
  _environment: 'staging' | 'production',
): ServiceDefinition[] {
  const ecrImage = buildEcrImage(imageTag);
  const envVars = getEnvVarsFromProcess();
  const workerCount = parseInt(process.env.GH_WORKER_COUNT || '1', 10);

  const services: ServiceDefinition[] = [
    buildApiService(ecrImage, envVars),
  ];

  for (let i = 0; i < workerCount; i++) {
    const port = 3101 + i;
    services.push(buildWorkerService(ecrImage, envVars, i, port));
  }

  return services.sort((a, b) => a.startOrder - b.startOrder);
}
