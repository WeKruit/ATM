import { describe, expect, test } from 'bun:test';

import {
  describeSecretFingerprint,
  resolveDeploySecret,
} from '../deploy-secret';

describe('deploy-secret', () => {
  test('prefers ATM_DEPLOY_SECRET when both secrets match', () => {
    const result = resolveDeploySecret(
      {
        ATM_DEPLOY_SECRET: 'shared-secret',
        GH_DEPLOY_SECRET: 'shared-secret',
      },
      'staging',
    );

    expect(result.secret).toBe('shared-secret');
    expect(result.source).toBe('ATM_DEPLOY_SECRET');
    expect(result.error).toBeUndefined();
  });

  test('falls back to GH_DEPLOY_SECRET with warning', () => {
    const result = resolveDeploySecret(
      {
        GH_DEPLOY_SECRET: 'legacy-secret',
      },
      'production',
    );

    expect(result.secret).toBe('legacy-secret');
    expect(result.source).toBe('GH_DEPLOY_SECRET');
    expect(result.warning).toContain('legacy');
  });

  test('fails fast on staging mismatch', () => {
    const result = resolveDeploySecret(
      {
        ATM_DEPLOY_SECRET: 'atm-secret',
        GH_DEPLOY_SECRET: 'gh-secret',
      },
      'staging',
    );

    expect(result.secret).toBeNull();
    expect(result.error).toContain('differ in staging');
  });

  test('parity mismatch in production keeps ATM secret but reports warning', () => {
    const result = resolveDeploySecret(
      {
        ATM_DEPLOY_SECRET: 'atm-secret',
        GH_DEPLOY_SECRET: 'gh-secret',
      },
      'production',
    );

    expect(result.secret).toBe('atm-secret');
    expect(result.source).toBe('ATM_DEPLOY_SECRET');
    expect(result.warning).toContain('differ');
  });

  test('fingerprints secrets without returning raw values', () => {
    const fingerprint = describeSecretFingerprint('super-secret-value');

    expect(fingerprint.present).toBe(true);
    expect(fingerprint.fingerprint).toHaveLength(12);
    expect(fingerprint.fingerprint).not.toContain('super-secret-value');
  });
});
