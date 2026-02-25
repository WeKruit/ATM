import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getServiceConfigs, getEnvVarsFromProcess } from '../container-configs';

describe('container-configs', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['ECR_REGISTRY', 'ECR_REPOSITORY', 'GH_WORKER_COUNT', 'NODE_ENV'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('getServiceConfigs', () => {
    test('returns configs sorted by startOrder', () => {
      const configs = getServiceConfigs('latest', 'staging');
      for (let i = 1; i < configs.length; i++) {
        expect(configs[i].startOrder).toBeGreaterThanOrEqual(configs[i - 1].startOrder);
      }
    });

    test('includes API service', () => {
      const configs = getServiceConfigs('v1.0', 'staging');
      const api = configs.find((c) => c.name === 'ghosthands-api');
      expect(api).toBeDefined();
      expect(api!.startOrder).toBe(1);
      expect(api!.healthEndpoint).toContain('3100');
    });

    test('includes Worker service', () => {
      delete process.env.GH_WORKER_COUNT;
      const configs = getServiceConfigs('v1.0', 'staging');
      const worker = configs.find((c) => c.name === 'ghosthands-worker');
      expect(worker).toBeDefined();
      expect(worker!.drainEndpoint).toContain('3101');
    });

    test('does NOT include deploy-server (removed)', () => {
      const configs = getServiceConfigs('latest', 'staging');
      const ds = configs.find((c) => c.name === 'ghosthands-deploy-server');
      expect(ds).toBeUndefined();
    });

    test('all services have gh.managed label', () => {
      const configs = getServiceConfigs('latest', 'staging');
      for (const service of configs) {
        expect(service.config.Labels?.['gh.managed']).toBe('true');
      }
    });

    test('builds ECR image from registry/repo:tag', () => {
      const configs = getServiceConfigs('v2.0', 'staging');
      for (const service of configs) {
        expect(service.config.Image).toContain(':v2.0');
        expect(service.config.Image).toContain('ghosthands');
      }
    });

    test('defaults to 1 worker when GH_WORKER_COUNT not set', () => {
      delete process.env.GH_WORKER_COUNT;
      const configs = getServiceConfigs('latest', 'staging');
      const workers = configs.filter((c) => c.config.Labels?.['gh.service'] === 'worker');
      expect(workers.length).toBe(1);
    });

    test('creates multiple workers when GH_WORKER_COUNT > 1', () => {
      process.env.GH_WORKER_COUNT = '3';
      const configs = getServiceConfigs('latest', 'staging');
      const workers = configs.filter((c) => c.config.Labels?.['gh.service'] === 'worker');
      expect(workers.length).toBe(3);
      // Check port assignment
      expect(workers[0].healthEndpoint).toContain('3101');
      expect(workers[1].healthEndpoint).toContain('3102');
      expect(workers[2].healthEndpoint).toContain('3103');
      // Check worker index label
      expect(workers[0].config.Labels?.['gh.worker.index']).toBe('0');
      expect(workers[1].config.Labels?.['gh.worker.index']).toBe('1');
      expect(workers[2].config.Labels?.['gh.worker.index']).toBe('2');
    });

    test('worker names follow naming convention', () => {
      process.env.GH_WORKER_COUNT = '2';
      const configs = getServiceConfigs('latest', 'staging');
      const workers = configs.filter((c) => c.config.Labels?.['gh.service'] === 'worker');
      expect(workers[0].name).toBe('ghosthands-worker');
      expect(workers[1].name).toBe('ghosthands-worker-1');
    });
  });

  describe('getEnvVarsFromProcess', () => {
    test('filters by prefix whitelist', () => {
      process.env.DATABASE_URL = 'postgres://test';
      process.env.RANDOM_VAR = 'should-not-appear';
      const vars = getEnvVarsFromProcess();
      expect(vars.some((v) => v.startsWith('DATABASE_URL='))).toBe(true);
      expect(vars.some((v) => v.startsWith('RANDOM_VAR='))).toBe(false);
      delete process.env.DATABASE_URL;
      delete process.env.RANDOM_VAR;
    });

    test('includes NODE_ENV', () => {
      process.env.NODE_ENV = 'test';
      const vars = getEnvVarsFromProcess();
      expect(vars.some((v) => v.startsWith('NODE_ENV='))).toBe(true);
    });

    test('includes GH_ prefixed vars', () => {
      process.env.GH_API_PORT = '3100';
      const vars = getEnvVarsFromProcess();
      expect(vars.some((v) => v.startsWith('GH_API_PORT='))).toBe(true);
      delete process.env.GH_API_PORT;
    });
  });
});
