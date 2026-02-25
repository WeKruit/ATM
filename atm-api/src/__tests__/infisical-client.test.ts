import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getInfisicalConfig, getInfisicalStatus, loadSecretsFromInfisical } from '../infisical-client';

describe('infisical-client', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const infisicalKeys = [
    'INFISICAL_SITE_URL',
    'INFISICAL_CLIENT_ID',
    'INFISICAL_CLIENT_SECRET',
    'INFISICAL_PROJECT_ID',
    'INFISICAL_ENVIRONMENT',
  ];

  beforeEach(() => {
    for (const key of infisicalKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of infisicalKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('getInfisicalConfig', () => {
    test('returns null when env vars missing', () => {
      expect(getInfisicalConfig()).toBeNull();
    });

    test('returns config when all env vars set', () => {
      process.env.INFISICAL_SITE_URL = 'https://infisical.example.com';
      process.env.INFISICAL_CLIENT_ID = 'test-id';
      process.env.INFISICAL_CLIENT_SECRET = 'test-secret';
      process.env.INFISICAL_PROJECT_ID = 'proj-123';

      const config = getInfisicalConfig();
      expect(config).not.toBeNull();
      expect(config!.siteUrl).toBe('https://infisical.example.com');
      expect(config!.clientId).toBe('test-id');
      expect(config!.clientSecret).toBe('test-secret');
      expect(config!.projectId).toBe('proj-123');
    });

    test('defaults environment to staging', () => {
      process.env.INFISICAL_SITE_URL = 'https://infisical.example.com';
      process.env.INFISICAL_CLIENT_ID = 'test-id';
      process.env.INFISICAL_CLIENT_SECRET = 'test-secret';
      process.env.INFISICAL_PROJECT_ID = 'proj-123';

      const config = getInfisicalConfig();
      expect(config!.environment).toBe('staging');
    });

    test('uses custom environment', () => {
      process.env.INFISICAL_SITE_URL = 'https://infisical.example.com';
      process.env.INFISICAL_CLIENT_ID = 'test-id';
      process.env.INFISICAL_CLIENT_SECRET = 'test-secret';
      process.env.INFISICAL_PROJECT_ID = 'proj-123';
      process.env.INFISICAL_ENVIRONMENT = 'production';

      const config = getInfisicalConfig();
      expect(config!.environment).toBe('production');
    });

    test('returns null when only some vars set', () => {
      process.env.INFISICAL_SITE_URL = 'https://infisical.example.com';
      // Missing client_id, client_secret, project_id
      expect(getInfisicalConfig()).toBeNull();
    });
  });

  describe('getInfisicalStatus', () => {
    test('returns not-configured when env vars missing', async () => {
      const status = await getInfisicalStatus();
      expect(status.connected).toBe(false);
      expect(status.error).toContain('not configured');
    });
  });

  describe('loadSecretsFromInfisical', () => {
    test('skips when not configured', async () => {
      // Should not throw
      await loadSecretsFromInfisical();
    });
  });
});
