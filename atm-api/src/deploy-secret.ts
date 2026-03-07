import crypto from 'node:crypto';

export type DeployEnvironment = 'staging' | 'production';
export type DeploySecretSource = 'ATM_DEPLOY_SECRET' | 'GH_DEPLOY_SECRET';

export interface DeploySecretResolution {
  secret: string | null;
  source: DeploySecretSource | null;
  warning?: string;
  error?: string;
}

export interface SecretFingerprint {
  present: boolean;
  fingerprint: string | null;
}

export function resolveDeploySecret(
  env: NodeJS.ProcessEnv,
  environment: DeployEnvironment,
): DeploySecretResolution {
  const atmSecret = env.ATM_DEPLOY_SECRET?.trim();
  const ghSecret = env.GH_DEPLOY_SECRET?.trim();

  if (atmSecret && ghSecret && atmSecret !== ghSecret) {
    if (environment === 'staging') {
      return {
        secret: null,
        source: null,
        error: 'ATM_DEPLOY_SECRET and GH_DEPLOY_SECRET differ in staging.',
      };
    }

    return {
      secret: atmSecret,
      source: 'ATM_DEPLOY_SECRET',
      warning:
        'ATM_DEPLOY_SECRET and GH_DEPLOY_SECRET differ. Using ATM_DEPLOY_SECRET and reporting parity drift.',
    };
  }

  if (atmSecret) {
    return {
      secret: atmSecret,
      source: 'ATM_DEPLOY_SECRET',
    };
  }

  if (ghSecret) {
    return {
      secret: ghSecret,
      source: 'GH_DEPLOY_SECRET',
      warning: 'Using legacy GH_DEPLOY_SECRET fallback for deploy auth.',
    };
  }

  return {
    secret: null,
    source: null,
    error: 'No deploy secret configured (ATM_DEPLOY_SECRET or GH_DEPLOY_SECRET).',
  };
}

export function fingerprintSecretValue(value?: string | null): string | null {
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function describeSecretFingerprint(value?: string | null): SecretFingerprint {
  return {
    present: Boolean(value),
    fingerprint: fingerprintSecretValue(value),
  };
}
