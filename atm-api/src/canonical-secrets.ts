import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import {
  deleteSecretValue,
  fetchSecretsForPath,
  normalizeInfisicalEnvironment,
  upsertSecretValue,
} from './infisical-client';

export type CanonicalSecretApp = 'atm' | 'valet' | 'ghosthands';
export type CanonicalSecretEnvironment = 'dev' | 'staging' | 'production';
export type CanonicalFanoutTarget =
  | 'github:WeKruit/ATM'
  | 'github:WeKruit/VALET'
  | 'github:WeKruit/GHOST-HANDS'
  | 'github:WeKruit/GH-Desktop-App'
  | 'aws:ghosthands'
  | 'runtime:atm';

export interface CanonicalSecretVar {
  key: string;
  value: string;
  isRuntime: boolean;
}

export interface CanonicalSecretAppMetadata {
  app: CanonicalSecretApp;
  description: string;
  path: string;
  environments: CanonicalSecretEnvironment[];
  defaultTargets: CanonicalFanoutTarget[];
  supportedTargets: CanonicalFanoutTarget[];
}

export interface CanonicalFanoutResult {
  target: CanonicalFanoutTarget;
  success: boolean;
  upserted: number;
  deleted: number;
  skipped: number;
  errors: string[];
}

const DEFAULT_ENVIRONMENTS: CanonicalSecretEnvironment[] = ['dev', 'staging', 'production'];

const RUNTIME_VARS = new Set([
  'GH_WORKER_ID',
  'COMMIT_SHA',
  'BUILD_TIME',
  'EC2_INSTANCE_ID',
  'EC2_IP',
  'IMAGE_TAG',
]);

const DESKTOP_MANAGED_KEYS = new Set(['ATM_DEPLOY_SECRET', 'GH_DEPLOY_SECRET', 'ATM_HOST']);
let sodiumModulePromise: Promise<any> | null = null;

const APP_CONFIGS: Record<CanonicalSecretApp, CanonicalSecretAppMetadata> = {
  atm: {
    app: 'atm',
    description: 'ATM runtime and control-plane secrets.',
    path: '/atm',
    environments: DEFAULT_ENVIRONMENTS,
    defaultTargets: ['github:WeKruit/ATM', 'runtime:atm'],
    supportedTargets: ['github:WeKruit/ATM', 'runtime:atm'],
  },
  valet: {
    app: 'valet',
    description: 'VALET application and deploy/runtime secrets.',
    path: '/valet',
    environments: DEFAULT_ENVIRONMENTS,
    defaultTargets: ['github:WeKruit/VALET'],
    supportedTargets: ['github:WeKruit/VALET'],
  },
  ghosthands: {
    app: 'ghosthands',
    description: 'GhostHands runtime/build secrets shared with Desktop and AWS mirrors.',
    path: '/ghosthands',
    environments: DEFAULT_ENVIRONMENTS,
    defaultTargets: [
      'github:WeKruit/GHOST-HANDS',
      'github:WeKruit/GH-Desktop-App',
      'aws:ghosthands',
    ],
    supportedTargets: [
      'github:WeKruit/GHOST-HANDS',
      'github:WeKruit/GH-Desktop-App',
      'aws:ghosthands',
    ],
  },
};

function githubToken(): string {
  const token = process.env.WORKSPACE_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('Missing GitHub token (WORKSPACE_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN)');
  }
  return token;
}

function awsClient(): SecretsManagerClient {
  return new SecretsManagerClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  });
}

function assertEnvironment(value: string): CanonicalSecretEnvironment {
  const normalized = normalizePublicEnvironment(value);
  if (!DEFAULT_ENVIRONMENTS.includes(normalized)) {
    throw new Error(`Unsupported environment "${value}"`);
  }
  return normalized;
}

function assertApp(value: string): CanonicalSecretApp {
  if (value !== 'atm' && value !== 'valet' && value !== 'ghosthands') {
    throw new Error(`Unsupported app "${value}"`);
  }
  return value;
}

function validateSecretKey(key: string): void {
  if (RUNTIME_VARS.has(key)) {
    throw new Error(`Cannot manage runtime-injected secret "${key}" through the canonical API.`);
  }

  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid key format "${key}". Use [A-Z_][A-Z0-9_]*.`);
  }
}

export function ensureDeploySecretParity(vars: Record<string, string>): Record<string, string> {
  const mirrored = { ...vars };
  if (mirrored.ATM_DEPLOY_SECRET && !mirrored.GH_DEPLOY_SECRET) {
    mirrored.GH_DEPLOY_SECRET = mirrored.ATM_DEPLOY_SECRET;
  }
  if (mirrored.GH_DEPLOY_SECRET && !mirrored.ATM_DEPLOY_SECRET) {
    mirrored.ATM_DEPLOY_SECRET = mirrored.GH_DEPLOY_SECRET;
  }
  return mirrored;
}

export function filterSecretsForTarget(
  app: CanonicalSecretApp,
  target: CanonicalFanoutTarget,
  vars: Record<string, string>,
): Record<string, string> {
  const mirrored = ensureDeploySecretParity(vars);

  if (target === 'runtime:atm') {
    return mirrored;
  }

  if (target === 'github:WeKruit/GH-Desktop-App') {
    return Object.fromEntries(
      Object.entries(mirrored).filter(([key]) => DESKTOP_MANAGED_KEYS.has(key)),
    );
  }

  if (target === 'aws:ghosthands') {
    return mirrored;
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(mirrored)) {
    if (!RUNTIME_VARS.has(key)) {
      filtered[key] = value;
    }
  }

  if (app === 'atm' && filtered.ATM_DEPLOY_SECRET && !filtered.GH_DEPLOY_SECRET) {
    filtered.GH_DEPLOY_SECRET = filtered.ATM_DEPLOY_SECRET;
  }

  return filtered;
}

async function githubApi<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${errorBody}`);
  }

  if (response.status === 204) {
    return null;
  }

  return (await response.json()) as T;
}

async function ensureGithubEnvironment(
  repo: string,
  environment: CanonicalSecretEnvironment,
): Promise<void> {
  await githubApi(
    'PUT',
    `repos/${repo}/environments/${environment}`,
    {},
  );
}

async function getGithubEnvironmentPublicKey(
  repo: string,
  environment: CanonicalSecretEnvironment,
): Promise<{ key: string; key_id: string }> {
  await ensureGithubEnvironment(repo, environment);
  const key = await githubApi<{ key: string; key_id: string }>(
    'GET',
    `repos/${repo}/environments/${environment}/secrets/public-key`,
  );

  if (!key?.key || !key.key_id) {
    throw new Error(`GitHub environment public key missing for ${repo}/${environment}`);
  }

  return key;
}

async function putGithubEnvironmentSecret(
  repo: string,
  environment: CanonicalSecretEnvironment,
  key: string,
  value: string,
): Promise<void> {
  const sodium = await loadSodium();
  const publicKey = await getGithubEnvironmentPublicKey(repo, environment);
  const keyBytes = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
  const encryptedBytes = sodium.crypto_box_seal(sodium.from_string(value), keyBytes);
  const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

  await githubApi(
    'PUT',
    `repos/${repo}/environments/${environment}/secrets/${key}`,
    {
      encrypted_value: encryptedValue,
      key_id: publicKey.key_id,
    },
  );
}

async function deleteGithubEnvironmentSecret(
  repo: string,
  environment: CanonicalSecretEnvironment,
  key: string,
): Promise<boolean> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/environments/${environment}/secrets/${key}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${githubToken()}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `GitHub delete ${repo}/${environment}/${key} failed (${response.status}): ${errorBody}`,
    );
  }

  return true;
}

async function readAwsMirror(secretId: string): Promise<Record<string, string>> {
  try {
    const result = await awsClient().send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!result.SecretString) {
      return {};
    }
    return JSON.parse(result.SecretString) as Record<string, string>;
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') {
      return {};
    }
    throw error;
  }
}

async function writeAwsMirror(secretId: string, payload: Record<string, string>): Promise<void> {
  const client = awsClient();
  const secretString = JSON.stringify(payload, null, 2);

  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: secretString,
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') {
      await client.send(
        new CreateSecretCommand({
          Name: secretId,
          SecretString: secretString,
        }),
      );
      return;
    }
    throw error;
  }
}

function awsMirrorSecretId(environment: CanonicalSecretEnvironment): string {
  return `ghosthands/${environment}`;
}

async function applyGithubFanout(
  repo: string,
  environment: CanonicalSecretEnvironment,
  vars: Record<string, string>,
  removedKeys: string[],
): Promise<CanonicalFanoutResult> {
  if (Object.keys(vars).length === 0 && removedKeys.length === 0) {
    return {
      target: `github:${repo}` as CanonicalFanoutTarget,
      success: true,
      upserted: 0,
      deleted: 0,
      skipped: 0,
      errors: [],
    };
  }

  let upserted = 0;
  let deleted = 0;
  const errors: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    try {
      await putGithubEnvironmentSecret(repo, environment, key, value);
      upserted += 1;
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const key of removedKeys) {
    try {
      const didDelete = await deleteGithubEnvironmentSecret(repo, environment, key);
      if (didDelete) {
        deleted += 1;
      }
    } catch (error) {
      errors.push(`${key} delete: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    target: `github:${repo}` as CanonicalFanoutTarget,
    success: errors.length === 0,
    upserted,
    deleted,
    skipped: 0,
    errors,
  };
}

async function applyAwsMirrorFanout(
  environment: CanonicalSecretEnvironment,
  vars: Record<string, string>,
  removedKeys: string[],
): Promise<CanonicalFanoutResult> {
  const secretId = awsMirrorSecretId(environment);
  const current = await readAwsMirror(secretId);
  const next = { ...current };
  let upserted = 0;
  let deleted = 0;

  for (const key of removedKeys) {
    if (key in next) {
      delete next[key];
      deleted += 1;
    }
  }

  for (const [key, value] of Object.entries(vars)) {
    if (next[key] !== value) {
      next[key] = value;
      upserted += 1;
    }
  }

  if (upserted === 0 && deleted === 0) {
    return {
      target: 'aws:ghosthands',
      success: true,
      upserted: 0,
      deleted: 0,
      skipped: Object.keys(vars).length,
      errors: [],
    };
  }

  await writeAwsMirror(secretId, next);
  return {
    target: 'aws:ghosthands',
    success: true,
    upserted,
    deleted,
    skipped: 0,
    errors: [],
  };
}

function applyRuntimeFanout(
  vars: Record<string, string>,
  removedKeys: string[],
): CanonicalFanoutResult {
  let upserted = 0;
  let deleted = 0;

  for (const key of removedKeys) {
    if (process.env[key] !== undefined) {
      delete process.env[key];
      deleted += 1;
    }
  }

  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] !== value) {
      process.env[key] = value;
      upserted += 1;
    }
  }

  return {
    target: 'runtime:atm',
    success: true,
    upserted,
    deleted,
    skipped: 0,
    errors: [],
  };
}

export function resolveFanoutTargets(
  app: CanonicalSecretApp,
  targets?: CanonicalFanoutTarget[],
): CanonicalFanoutTarget[] {
  const supported = new Set(APP_CONFIGS[app].supportedTargets);
  const requested = targets && targets.length > 0 ? targets : APP_CONFIGS[app].defaultTargets;
  for (const target of requested) {
    if (!supported.has(target)) {
      throw new Error(`Unsupported fanout target "${target}" for app "${app}"`);
    }
  }
  return requested;
}

export function normalizePublicEnvironment(value?: string): CanonicalSecretEnvironment {
  const normalized = (value || 'staging').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'production') return 'production';
  if (normalized === 'development' || normalized === 'develop' || normalized === 'local' || normalized === 'dev') {
    return 'dev';
  }
  return normalized as CanonicalSecretEnvironment;
}

export function getCanonicalSecretApps(): CanonicalSecretAppMetadata[] {
  return Object.values(APP_CONFIGS);
}

export function getCanonicalSecretAppConfig(app: CanonicalSecretApp): CanonicalSecretAppMetadata {
  return APP_CONFIGS[app];
}

export function getCanonicalGitHubManagedKeys(target: CanonicalFanoutTarget): string[] | null {
  if (target === 'github:WeKruit/GH-Desktop-App') {
    return [...DESKTOP_MANAGED_KEYS];
  }
  return null;
}

async function loadSodium(): Promise<any> {
  if (!sodiumModulePromise) {
    sodiumModulePromise = import('libsodium-wrappers').then(async (module) => {
      await module.default.ready;
      return module.default;
    });
  }
  return sodiumModulePromise;
}

export async function listCanonicalSecretVars(
  appInput: string,
  environmentInput: string,
): Promise<{
  app: CanonicalSecretApp;
  environment: CanonicalSecretEnvironment;
  infisicalEnvironment: string;
  path: string;
  defaultTargets: CanonicalFanoutTarget[];
  vars: CanonicalSecretVar[];
  totalKeys: number;
}> {
  const app = assertApp(appInput);
  const environment = assertEnvironment(environmentInput);
  const path = APP_CONFIGS[app].path;
  const secrets = await fetchSecretsForPath(path, environment);
  const vars = Object.entries(secrets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      key,
      value,
      isRuntime: RUNTIME_VARS.has(key),
    }));

  return {
    app,
    environment,
    infisicalEnvironment: normalizeInfisicalEnvironment(environment),
    path,
    defaultTargets: APP_CONFIGS[app].defaultTargets,
    vars,
    totalKeys: vars.length,
  };
}

export async function fanoutCanonicalSecretVars(
  appInput: string,
  environmentInput: string,
  targets?: CanonicalFanoutTarget[],
  removedKeys: string[] = [],
): Promise<{
  app: CanonicalSecretApp;
  environment: CanonicalSecretEnvironment;
  requestedTargets: CanonicalFanoutTarget[];
  success: boolean;
  results: CanonicalFanoutResult[];
}> {
  const app = assertApp(appInput);
  const environment = assertEnvironment(environmentInput);
  const requestedTargets = resolveFanoutTargets(app, targets);
  const currentSecrets = await fetchSecretsForPath(APP_CONFIGS[app].path, environment);
  const results: CanonicalFanoutResult[] = [];

  for (const target of requestedTargets) {
    const filteredVars = filterSecretsForTarget(app, target, currentSecrets);
    const filteredRemovedKeys = removedKeys.filter((key) => {
      if (target === 'github:WeKruit/GH-Desktop-App') {
        return DESKTOP_MANAGED_KEYS.has(key);
      }
      return true;
    });

    try {
      if (target.startsWith('github:')) {
        results.push(
          await applyGithubFanout(
            target.replace('github:', ''),
            environment,
            filteredVars,
            filteredRemovedKeys,
          ),
        );
        continue;
      }

      if (target === 'aws:ghosthands') {
        results.push(await applyAwsMirrorFanout(environment, filteredVars, filteredRemovedKeys));
        continue;
      }

      if (target === 'runtime:atm') {
        results.push(applyRuntimeFanout(filteredVars, filteredRemovedKeys));
        continue;
      }
    } catch (error) {
      results.push({
        target,
        success: false,
        upserted: 0,
        deleted: 0,
        skipped: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return {
    app,
    environment,
    requestedTargets,
    success: results.every((result) => result.success),
    results,
  };
}

export async function upsertCanonicalSecretVars(
  appInput: string,
  environmentInput: string,
  vars: Array<{ key: string; value: string }>,
  targets?: CanonicalFanoutTarget[],
): Promise<{
  app: CanonicalSecretApp;
  environment: CanonicalSecretEnvironment;
  path: string;
  upserted: number;
  keys: string[];
  fanout: Awaited<ReturnType<typeof fanoutCanonicalSecretVars>>;
}> {
  const app = assertApp(appInput);
  const environment = assertEnvironment(environmentInput);

  if (!Array.isArray(vars) || vars.length === 0) {
    throw new Error('vars must be a non-empty array of { key, value }');
  }

  const keys: string[] = [];
  for (const entry of vars) {
    validateSecretKey(entry.key);
    if (typeof entry.value !== 'string') {
      throw new Error(`Invalid value for key "${entry.key}"`);
    }
    await upsertSecretValue(entry.key, entry.value, APP_CONFIGS[app].path, environment);
    keys.push(entry.key);
  }

  const fanout = await fanoutCanonicalSecretVars(app, environment, targets);
  return {
    app,
    environment,
    path: APP_CONFIGS[app].path,
    upserted: keys.length,
    keys,
    fanout,
  };
}

export async function deleteCanonicalSecretVars(
  appInput: string,
  environmentInput: string,
  keys: string[],
  targets?: CanonicalFanoutTarget[],
): Promise<{
  app: CanonicalSecretApp;
  environment: CanonicalSecretEnvironment;
  path: string;
  deleted: number;
  keys: string[];
  fanout: Awaited<ReturnType<typeof fanoutCanonicalSecretVars>>;
}> {
  const app = assertApp(appInput);
  const environment = assertEnvironment(environmentInput);

  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('keys must be a non-empty array');
  }

  const deleted: string[] = [];
  for (const key of keys) {
    validateSecretKey(key);
    const removed = await deleteSecretValue(key, APP_CONFIGS[app].path, environment);
    if (removed) {
      deleted.push(key);
    }
  }

  const fanout = await fanoutCanonicalSecretVars(app, environment, targets, deleted);
  return {
    app,
    environment,
    path: APP_CONFIGS[app].path,
    deleted: deleted.length,
    keys: deleted,
    fanout,
  };
}
