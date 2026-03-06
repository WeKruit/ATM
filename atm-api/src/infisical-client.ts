/**
 * Infisical Client — Wraps Infisical Node SDK for secrets pull/refresh
 *
 * Replaces AWS Secrets Manager integration. Connects to self-hosted
 * Infisical instance on Fly.io for centralized secrets management.
 *
 * Uses Universal Auth (client ID + secret) for Machine Identity authentication.
 * Infisical is optional — if env vars are not configured, functions degrade gracefully.
 *
 * Supports both SDK v2 (InfisicalClient) and v3+ (InfisicalSDK) APIs.
 *
 * @module atm-api/src/infisical-client
 */

interface InfisicalConfig {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
}

type SecretMap = Record<string, string>;

interface InfisicalAuthSession {
  accessToken: string;
  createdAt: number;
}

let cachedAuthSession: InfisicalAuthSession | null = null;

/**
 * Reads Infisical configuration from environment variables.
 * Returns null if required env vars are not set (Infisical is optional).
 */
export function getInfisicalConfig(): InfisicalConfig | null {
  const siteUrl = process.env.INFISICAL_SITE_URL;
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const environment = process.env.INFISICAL_ENVIRONMENT || 'staging';

  if (!siteUrl || !clientId || !clientSecret || !projectId) {
    return null;
  }

  return { siteUrl, clientId, clientSecret, projectId, environment };
}

export function normalizeInfisicalEnvironment(environment?: string): string {
  const value = (environment || '').trim().toLowerCase();

  switch (value) {
    case '':
      return 'staging';
    case 'production':
    case 'prod':
      return 'prod';
    case 'development':
    case 'develop':
    case 'dev':
    case 'local':
      return 'dev';
    default:
      return value;
  }
}

// ── SDK abstraction ─────────────────────────────────────────────────
// @infisical/sdk v2 exports InfisicalClient (constructor auth, flat methods)
// @infisical/sdk v3+ exports InfisicalSDK (separate auth(), secrets() chains)

interface InfisicalWrapper {
  listSecrets(opts: { projectId: string; environment: string; secretPath: string }): Promise<any[]>;
  getSecret(opts: { secretName: string; projectId: string; environment: string; secretPath: string }): Promise<any>;
}

async function createClient(config: InfisicalConfig): Promise<InfisicalWrapper> {
  const sdk: any = await import('@infisical/sdk');

  // v2: InfisicalClient with constructor-based auth
  const InfisicalClient = sdk.InfisicalClient || sdk.default?.InfisicalClient;
  if (InfisicalClient) {
    const client = new InfisicalClient({
      siteUrl: config.siteUrl,
      auth: {
        universalAuth: {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        },
      },
    });
    return {
      async listSecrets(opts) {
        // v2 uses 'path' not 'secretPath'
        return client.listSecrets({
          projectId: opts.projectId,
          environment: opts.environment,
          path: opts.secretPath,
        });
      },
      async getSecret(opts) {
        return client.getSecret({
          secretName: opts.secretName,
          projectId: opts.projectId,
          environment: opts.environment,
          path: opts.secretPath,
        });
      },
    };
  }

  // v3+: InfisicalSDK with separate auth/secrets chains
  const InfisicalSDK = sdk.InfisicalSDK || sdk.default?.InfisicalSDK;
  if (InfisicalSDK) {
    const client = new InfisicalSDK({ siteUrl: config.siteUrl });
    await client.auth().universalAuth.login({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    return {
      async listSecrets(opts) {
        const result = await client.secrets().listSecrets(opts);
        return result?.secrets || result || [];
      },
      async getSecret(opts) {
        return client.secrets().getSecret(opts);
      },
    };
  }

  throw new Error('@infisical/sdk loaded but neither InfisicalClient nor InfisicalSDK found');
}

function toSecretMap(secrets: any[]): SecretMap {
  const result: SecretMap = {};

  for (const secret of secrets) {
    const key = secret?.secretKey || secret?.key;
    const value = secret?.secretValue ?? secret?.value;
    if (key && typeof value === 'string') {
      result[key] = value;
    }
  }

  return result;
}

async function listSecretsForPath(
  client: InfisicalWrapper,
  config: InfisicalConfig,
  secretPath: string,
  environment: string,
): Promise<any[]> {
  const secrets = await client.listSecrets({
    projectId: config.projectId,
    environment: normalizeInfisicalEnvironment(environment),
    secretPath,
  });

  return Array.isArray(secrets) ? secrets : [];
}

async function getAccessToken(config: InfisicalConfig): Promise<string> {
  if (cachedAuthSession && Date.now() - cachedAuthSession.createdAt < 5 * 60_000) {
    return cachedAuthSession.accessToken;
  }

  const response = await fetch(`${config.siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Infisical auth failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as { accessToken?: string };
  if (!payload.accessToken) {
    throw new Error('Infisical auth succeeded without accessToken');
  }

  cachedAuthSession = {
    accessToken: payload.accessToken,
    createdAt: Date.now(),
  };

  return payload.accessToken;
}

async function upsertSecretValueRest(
  config: InfisicalConfig,
  params: {
    key: string;
    value: string;
    environment: string;
    secretPath: string;
  },
): Promise<'created' | 'updated'> {
  const accessToken = await getAccessToken(config);
  const url = `${config.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(params.key)}`;
  const body = JSON.stringify({
    workspaceId: config.projectId,
    environment: normalizeInfisicalEnvironment(params.environment),
    secretPath: params.secretPath,
    secretValue: params.value,
    type: 'shared',
  });

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const createResponse = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (createResponse.ok) {
    return 'created';
  }

  if (createResponse.status === 400 || createResponse.status === 409) {
    const updateResponse = await fetch(url, {
      method: 'PATCH',
      headers,
      body,
    });

    if (updateResponse.ok) {
      return 'updated';
    }

    const updateBody = await updateResponse.text().catch(() => '');
    throw new Error(
      `Infisical update failed for ${params.key} (${updateResponse.status}): ${updateBody}`,
    );
  }

  const createBody = await createResponse.text().catch(() => '');
  throw new Error(`Infisical create failed for ${params.key} (${createResponse.status}): ${createBody}`);
}

async function deleteSecretValueRest(
  config: InfisicalConfig,
  params: {
    key: string;
    environment: string;
    secretPath: string;
  },
): Promise<boolean> {
  const accessToken = await getAccessToken(config);
  const body = JSON.stringify({
    workspaceId: config.projectId,
    environment: normalizeInfisicalEnvironment(params.environment),
    secretPath: params.secretPath,
    type: 'shared',
  });
  const response = await fetch(
    `${config.siteUrl}/api/v3/secrets/raw/${encodeURIComponent(params.key)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    },
  );

  if (response.ok) {
    return true;
  }

  if (response.status === 404) {
    return false;
  }

  const errorBody = await response.text().catch(() => '');
  throw new Error(`Infisical delete failed for ${params.key} (${response.status}): ${errorBody}`);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Loads secrets from Infisical and merges them into process.env.
 * Existing env vars take precedence (same pattern as AWS SM loader).
 *
 * Non-fatal: logs a warning if Infisical is unavailable or not configured.
 */
export async function loadSecretsFromInfisical(): Promise<void> {
  const config = getInfisicalConfig();
  if (!config) {
    console.log(
      '[atm-api] Infisical not configured (missing env vars). Skipping.',
    );
    return;
  }

  try {
    const client = await createClient(config);
    const originalEnvKeys = new Set(Object.keys(process.env));
    const mergedSecrets: SecretMap = {};
    const paths = ['/', '/atm'];

    for (const secretPath of paths) {
      const secrets = await listSecretsForPath(
        client,
        config,
        secretPath,
        config.environment,
      );

      Object.assign(mergedSecrets, toSecretMap(secrets));
    }

    let loaded = 0;
    for (const [key, value] of Object.entries(mergedSecrets)) {
      if (!originalEnvKeys.has(key)) {
        process.env[key] = value;
        loaded++;
      }
    }

    console.log(
      `[atm-api] Loaded ${loaded} secrets from Infisical (${normalizeInfisicalEnvironment(config.environment)}, paths=/,/atm)`,
    );
  } catch (err: any) {
    console.warn(
      `[atm-api] Infisical unavailable (${err.message}). Skipping secrets load.`,
    );
  }
}

/**
 * Lists all secret keys with metadata (no values) from Infisical.
 * Returns empty array if Infisical is not configured or unavailable.
 *
 * @param secretPath - Folder path to list secrets from (default: '/')
 */
export async function listSecretKeys(
  secretPath = '/',
): Promise<{ key: string; createdAt: string; updatedAt: string }[]> {
  const config = getInfisicalConfig();
  if (!config) return [];

  try {
    const client = await createClient(config);
    const secrets = await listSecretsForPath(
      client,
      config,
      secretPath,
      config.environment,
    );

    if (!Array.isArray(secrets)) return [];

    return secrets.map((s: any) => ({
      key: s.secretKey || s.key || '',
      createdAt: s.createdAt || s.created_at || '',
      updatedAt: s.updatedAt || s.updated_at || '',
    }));
  } catch (err: any) {
    console.warn(`[atm-api] listSecretKeys failed: ${err.message}`);
    return [];
  }
}

/**
 * Gets a single secret value by key from Infisical.
 * Throws if Infisical is not configured or the secret is not found.
 *
 * @param key - Secret key name
 * @param secretPath - Folder path to look in (default: '/')
 */
export async function getSecretValue(
  key: string,
  secretPath = '/',
): Promise<{ key: string; value: string }> {
  const config = getInfisicalConfig();
  if (!config) {
    throw new Error('Infisical not configured');
  }

  const client = await createClient(config);

  const secret = await client.getSecret({
    secretName: key,
    projectId: config.projectId,
    environment: normalizeInfisicalEnvironment(config.environment),
    secretPath,
  });

  const value = secret?.secretValue ?? secret?.value;
  if (value === undefined) {
    throw new Error(`Secret "${key}" not found`);
  }

  return { key, value };
}

/**
 * Fetches a whole secret path from Infisical as a key/value object.
 * Supports ATM/public environment names like "production" and maps them
 * to Infisical's "prod" environment automatically.
 */
export async function fetchSecretsForPath(
  secretPath = '/',
  environment?: string,
): Promise<SecretMap> {
  const config = getInfisicalConfig();
  if (!config) {
    throw new Error('Infisical not configured');
  }

  const client = await createClient(config);
  const effectiveEnvironment = environment || config.environment;
  const secrets = await listSecretsForPath(
    client,
    config,
    secretPath,
    effectiveEnvironment,
  );

  return toSecretMap(secrets);
}

export async function upsertSecretValue(
  key: string,
  value: string,
  secretPath = '/',
  environment?: string,
): Promise<'created' | 'updated'> {
  const config = getInfisicalConfig();
  if (!config) {
    throw new Error('Infisical not configured');
  }

  return upsertSecretValueRest(config, {
    key,
    value,
    secretPath,
    environment: environment || config.environment,
  });
}

export async function deleteSecretValue(
  key: string,
  secretPath = '/',
  environment?: string,
): Promise<boolean> {
  const config = getInfisicalConfig();
  if (!config) {
    throw new Error('Infisical not configured');
  }

  return deleteSecretValueRest(config, {
    key,
    secretPath,
    environment: environment || config.environment,
  });
}

/** Service paths organized in Infisical */
export const SECRET_PATHS = ['/valet', '/ghosthands', '/atm'] as const;

/**
 * Returns Infisical connection status for the /secrets/status endpoint.
 * Counts secrets across all service paths.
 */
export async function getInfisicalStatus(): Promise<{
  connected: boolean;
  projectId?: string;
  environment?: string;
  secretCount?: number;
  paths?: Record<string, number>;
  error?: string;
}> {
  const config = getInfisicalConfig();
  if (!config) {
    return {
      connected: false,
      error: 'Infisical not configured (missing env vars)',
    };
  }

  try {
    const client = await createClient(config);

    // Count secrets across root + all service paths
    const pathCounts: Record<string, number> = {};
    let totalCount = 0;

    for (const sp of ['/', ...SECRET_PATHS]) {
      try {
        const secrets = await listSecretsForPath(
          client,
          config,
          sp,
          config.environment,
        );
        const count = Array.isArray(secrets) ? secrets.length : 0;
        pathCounts[sp] = count;
        totalCount += count;
      } catch {
        // Path may not exist yet — that's OK
        pathCounts[sp] = 0;
      }
    }

    return {
      connected: true,
      projectId: config.projectId,
      environment: normalizeInfisicalEnvironment(config.environment),
      secretCount: totalCount,
      paths: pathCounts,
    };
  } catch (err: any) {
    return {
      connected: false,
      projectId: config.projectId,
      environment: normalizeInfisicalEnvironment(config.environment),
      error: err.message,
    };
  }
}
