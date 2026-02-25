/**
 * Infisical Client — Wraps Infisical Node SDK for secrets pull/refresh
 *
 * Replaces AWS Secrets Manager integration. Connects to self-hosted
 * Infisical instance on Fly.io for centralized secrets management.
 *
 * Uses Universal Auth (client ID + secret) for Machine Identity authentication.
 * Infisical is optional — if env vars are not configured, functions degrade gracefully.
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
    // Dynamic import to avoid type issues with @infisical/sdk
    const sdk: any = await import('@infisical/sdk');
    const InfisicalSDK = sdk.InfisicalSDK || sdk.default?.InfisicalSDK;

    if (!InfisicalSDK) {
      console.warn(
        '[atm-api] @infisical/sdk loaded but InfisicalSDK class not found. Skipping.',
      );
      return;
    }

    const client = new InfisicalSDK({
      siteUrl: config.siteUrl,
    });

    await client.auth().universalAuth.login({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    const secrets = await client.secrets().listSecrets({
      projectId: config.projectId,
      environment: config.environment,
      secretPath: '/',
    });

    let loaded = 0;
    const secretList = secrets?.secrets || secrets || [];

    if (Array.isArray(secretList)) {
      for (const secret of secretList) {
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
 */
export async function listSecretKeys(): Promise<
  { key: string; createdAt: string; updatedAt: string }[]
> {
  const config = getInfisicalConfig();
  if (!config) return [];

  try {
    const sdk: any = await import('@infisical/sdk');
    const InfisicalSDK = sdk.InfisicalSDK || sdk.default?.InfisicalSDK;
    if (!InfisicalSDK) return [];

    const client = new InfisicalSDK({ siteUrl: config.siteUrl });
    await client.auth().universalAuth.login({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    const secrets = await client.secrets().listSecrets({
      projectId: config.projectId,
      environment: config.environment,
      secretPath: '/',
    });

    const secretList = secrets?.secrets || secrets || [];
    if (!Array.isArray(secretList)) return [];

    return secretList.map((s: any) => ({
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
 */
export async function getSecretValue(
  key: string,
): Promise<{ key: string; value: string }> {
  const config = getInfisicalConfig();
  if (!config) {
    throw new Error('Infisical not configured');
  }

  const sdk: any = await import('@infisical/sdk');
  const InfisicalSDK = sdk.InfisicalSDK || sdk.default?.InfisicalSDK;
  if (!InfisicalSDK) {
    throw new Error('InfisicalSDK class not found');
  }

  const client = new InfisicalSDK({ siteUrl: config.siteUrl });
  await client.auth().universalAuth.login({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  const secret = await client.secrets().getSecret({
    secretName: key,
    projectId: config.projectId,
    environment: config.environment,
    secretPath: '/',
  });

  const value = secret?.secretValue ?? secret?.value;
  if (value === undefined) {
    throw new Error(`Secret "${key}" not found`);
  }

  return { key, value };
}

/**
 * Returns Infisical connection status for the /secrets/status endpoint.
 */
export async function getInfisicalStatus(): Promise<{
  connected: boolean;
  projectId?: string;
  environment?: string;
  secretCount?: number;
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
    const sdk: any = await import('@infisical/sdk');
    const InfisicalSDK = sdk.InfisicalSDK || sdk.default?.InfisicalSDK;

    if (!InfisicalSDK) {
      return {
        connected: false,
        projectId: config.projectId,
        environment: config.environment,
        error: '@infisical/sdk loaded but InfisicalSDK class not found',
      };
    }

    const client = new InfisicalSDK({
      siteUrl: config.siteUrl,
    });

    await client.auth().universalAuth.login({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    const secrets = await client.secrets().listSecrets({
      projectId: config.projectId,
      environment: config.environment,
      secretPath: '/',
    });

    const secretList = secrets?.secrets || secrets || [];
    const count = Array.isArray(secretList) ? secretList.length : 0;

    return {
      connected: true,
      projectId: config.projectId,
      environment: config.environment,
      secretCount: count,
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
