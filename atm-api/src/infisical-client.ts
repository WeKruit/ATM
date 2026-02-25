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

    const secrets = await client.listSecrets({
      projectId: config.projectId,
      environment: config.environment,
      secretPath: '/',
    });

    let loaded = 0;
    if (Array.isArray(secrets)) {
      for (const secret of secrets) {
        const key = secret.secretKey || secret.key;
        const value = secret.secretValue || secret.value;
        if (key && typeof value === 'string' && !process.env[key]) {
          process.env[key] = value;
          loaded++;
        }
      }
    }

    console.log(
      `[atm-api] Loaded ${loaded} secrets from Infisical (${config.environment})`,
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

    const secrets = await client.listSecrets({
      projectId: config.projectId,
      environment: config.environment,
      secretPath,
    });

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
    environment: config.environment,
    secretPath,
  });

  const value = secret?.secretValue ?? secret?.value;
  if (value === undefined) {
    throw new Error(`Secret "${key}" not found`);
  }

  return { key, value };
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
        const secrets = await client.listSecrets({
          projectId: config.projectId,
          environment: config.environment,
          secretPath: sp,
        });
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
      environment: config.environment,
      secretCount: totalCount,
      paths: pathCounts,
    };
  } catch (err: any) {
    return {
      connected: false,
      projectId: config.projectId,
      environment: config.environment,
      error: err.message,
    };
  }
}
