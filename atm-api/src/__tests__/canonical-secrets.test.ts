import { describe, expect, test } from 'bun:test';

import {
  ensureDeploySecretParity,
  filterSecretsForTarget,
  getCanonicalSecretAppConfig,
  normalizePublicEnvironment,
  resolveFanoutTargets,
} from '../canonical-secrets';

describe('canonical-secrets', () => {
  test('maps public environments to canonical values', () => {
    expect(normalizePublicEnvironment('dev')).toBe('dev');
    expect(normalizePublicEnvironment('production')).toBe('production');
    expect(normalizePublicEnvironment('prod')).toBe('production');
    expect(normalizePublicEnvironment('local')).toBe('dev');
  });

  test('returns app-to-path mapping metadata', () => {
    expect(getCanonicalSecretAppConfig('atm').path).toBe('/atm');
    expect(getCanonicalSecretAppConfig('valet').path).toBe('/valet');
    expect(getCanonicalSecretAppConfig('ghosthands').path).toBe('/ghosthands');
  });

  test('mirrors deploy-secret aliases when one side is missing', () => {
    expect(
      ensureDeploySecretParity({
        ATM_DEPLOY_SECRET: 'atm-secret',
      }),
    ).toEqual({
      ATM_DEPLOY_SECRET: 'atm-secret',
      GH_DEPLOY_SECRET: 'atm-secret',
    });

    expect(
      ensureDeploySecretParity({
        GH_DEPLOY_SECRET: 'legacy-secret',
      }),
    ).toEqual({
      ATM_DEPLOY_SECRET: 'legacy-secret',
      GH_DEPLOY_SECRET: 'legacy-secret',
    });
  });

  test('filters desktop target to control-plane secrets only', () => {
    const filtered = filterSecretsForTarget('ghosthands', 'github:WeKruit/GH-Desktop-App', {
      ATM_DEPLOY_SECRET: 'deploy-secret',
      DATABASE_URL: 'postgres://hidden',
      GH_SERVICE_SECRET: 'service-secret',
    });

    expect(filtered).toEqual({
      ATM_DEPLOY_SECRET: 'deploy-secret',
      GH_DEPLOY_SECRET: 'deploy-secret',
    });
  });

  test('uses app default fanout targets when no explicit list is provided', () => {
    expect(resolveFanoutTargets('atm')).toEqual(['github:WeKruit/ATM', 'runtime:atm']);
    expect(resolveFanoutTargets('ghosthands')).toEqual([
      'github:WeKruit/GHOST-HANDS',
      'github:WeKruit/GH-Desktop-App',
      'aws:ghosthands',
    ]);
  });
});
