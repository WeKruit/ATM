import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import {
  spawnKamal,
  kamalDeploy,
  kamalRollback,
  kamalLockStatus,
  kamalAudit,
  isKamalAvailable,
  setSpawnImpl,
  setSecretsFetcherImpl,
  type SpawnFn,
} from '../kamal-runner';

/**
 * Creates a mock SpawnFn that returns the given stdout, stderr, and exitCode.
 */
function mockSpawn(
  stdout: string,
  stderr: string = '',
  exitCode: number = 0,
): { spawn: SpawnFn; calls: { cmd: string[]; opts: any }[] } {
  const calls: { cmd: string[]; opts: any }[] = [];

  const spawn: SpawnFn = (cmd, opts) => {
    calls.push({ cmd, opts });

    const encoder = new TextEncoder();

    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (stdout.length > 0) {
          controller.enqueue(encoder.encode(stdout));
        }
        controller.close();
      },
    });

    const stderrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (stderr.length > 0) {
          controller.enqueue(encoder.encode(stderr));
        }
        controller.close();
      },
    });

    return {
      exitCode: Promise.resolve(exitCode),
      stdout: stdoutStream,
      stderr: stderrStream,
    };
  };

  return { spawn, calls };
}

describe('kamal-runner', () => {
  afterEach(() => {
    setSpawnImpl(null);
    setSecretsFetcherImpl(null);
  });

  describe('spawnKamal', () => {
    it('returns stdout, stderr, exitCode, and durationMs on success', async () => {
      const { spawn } = mockSpawn('deploy complete\n', '', 0);
      setSpawnImpl(spawn);

      const result = await spawnKamal(['deploy', '-d', 'staging']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('deploy complete\n');
      expect(result.stderr).toBe('');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns non-zero exit code on failure', async () => {
      const { spawn } = mockSpawn('', 'error: something went wrong\n', 1);
      setSpawnImpl(spawn);

      const result = await spawnKamal(['deploy', '-d', 'staging']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('error: something went wrong\n');
    });

    it('collects stderr output', async () => {
      const { spawn } = mockSpawn('', 'WARNING: deprecated flag\nERROR: fatal\n', 2);
      setSpawnImpl(spawn);

      const result = await spawnKamal(['version']);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('WARNING: deprecated flag');
      expect(result.stderr).toContain('ERROR: fatal');
    });

    it('passes TERM=dumb in environment', async () => {
      const { spawn, calls } = mockSpawn('ok\n');
      setSpawnImpl(spawn);

      await spawnKamal(['version']);

      expect(calls.length).toBe(1);
      expect(calls[0].opts.env.TERM).toBe('dumb');
    });

    it('prepends "kamal" to the command args', async () => {
      const { spawn, calls } = mockSpawn('ok\n');
      setSpawnImpl(spawn);

      await spawnKamal(['deploy', '-d', 'staging', '-P']);

      expect(calls[0].cmd).toEqual(['kamal', 'deploy', '-d', 'staging', '-P']);
    });

    it('calls onLine callback for each line of output', async () => {
      const { spawn } = mockSpawn('line1\nline2\nline3\n');
      setSpawnImpl(spawn);

      const lines: string[] = [];
      await spawnKamal(['deploy'], (line) => lines.push(line));

      expect(lines).toEqual(['line1', 'line2', 'line3']);
    });

    it('calls onLine for stderr lines too', async () => {
      const { spawn } = mockSpawn('', 'err-line1\nerr-line2\n');
      setSpawnImpl(spawn);

      const lines: string[] = [];
      await spawnKamal(['deploy'], (line) => lines.push(line));

      expect(lines).toContain('err-line1');
      expect(lines).toContain('err-line2');
    });
  });

  describe('kamalDeploy', () => {
    const mockSecrets = async () => ({ KAMAL_REGISTRY_PASSWORD: 'fake-token', GH_ENVIRONMENT: 'staging' });

    it('builds correct args without version', async () => {
      const { spawn, calls } = mockSpawn('deployed\n');
      setSpawnImpl(spawn);
      setSecretsFetcherImpl(mockSecrets);

      await kamalDeploy('staging');

      // First call is 'kamal app stop', second is 'kamal deploy'
      const deployCall = calls.find(c => c.cmd.includes('deploy'));
      expect(deployCall?.cmd).toEqual(['kamal', 'deploy', '-d', 'staging', '-P']);
    });

    it('builds correct args with version', async () => {
      const { spawn, calls } = mockSpawn('deployed\n');
      setSpawnImpl(spawn);
      setSecretsFetcherImpl(mockSecrets);

      await kamalDeploy('production', 'v1.2.3');

      const deployCall = calls.find(c => c.cmd.includes('deploy'));
      expect(deployCall?.cmd).toEqual([
        'kamal', 'deploy', '-d', 'production', '--version', 'v1.2.3', '-P',
      ]);
    });
  });

  describe('kamalRollback', () => {
    it('builds correct args', async () => {
      const { spawn, calls } = mockSpawn('rolled back\n');
      setSpawnImpl(spawn);
      setSecretsFetcherImpl(async () => ({ KAMAL_REGISTRY_PASSWORD: 'fake-token' }));

      await kamalRollback('staging', 'v1.0.0');

      expect(calls[0].cmd).toEqual(['kamal', 'rollback', 'v1.0.0', '-d', 'staging']);
    });
  });

  describe('kamalLockStatus', () => {
    it('returns locked=true with holder when locked', async () => {
      const { spawn } = mockSpawn('Locked by: deploy-user\nReason: Deploying v2.0\n');
      setSpawnImpl(spawn);

      const status = await kamalLockStatus('staging');

      expect(status.locked).toBe(true);
      expect(status.holder).toBe('deploy-user');
      expect(status.reason).toBe('Deploying v2.0');
    });

    it('returns locked=false when no lock', async () => {
      const { spawn } = mockSpawn('No lock\n');
      setSpawnImpl(spawn);

      const status = await kamalLockStatus('staging');

      expect(status.locked).toBe(false);
      expect(status.holder).toBeUndefined();
    });

    it('returns locked=false on non-zero exit', async () => {
      const { spawn } = mockSpawn('', 'error\n', 1);
      setSpawnImpl(spawn);

      const status = await kamalLockStatus('staging');

      expect(status.locked).toBe(false);
    });

    it('returns locked=false on empty output', async () => {
      const { spawn } = mockSpawn('');
      setSpawnImpl(spawn);

      const status = await kamalLockStatus('staging');

      expect(status.locked).toBe(false);
    });
  });

  describe('kamalAudit', () => {
    it('parses structured audit lines', async () => {
      const output = [
        '2026-02-20 10:30:00 deploy by admin — Deployed v1.2.3',
        '2026-02-19 09:00:00 rollback by ci-bot — Rolled back to v1.2.2',
      ].join('\n') + '\n';

      const { spawn } = mockSpawn(output);
      setSpawnImpl(spawn);

      const entries = await kamalAudit('staging');

      expect(entries.length).toBe(2);
      expect(entries[0].timestamp).toBe('2026-02-20 10:30:00');
      expect(entries[0].action).toBe('deploy');
      expect(entries[0].performer).toBe('admin');
      expect(entries[0].details).toBe('Deployed v1.2.3');
      expect(entries[1].action).toBe('rollback');
      expect(entries[1].performer).toBe('ci-bot');
    });

    it('returns empty array on non-zero exit', async () => {
      const { spawn } = mockSpawn('', 'error\n', 1);
      setSpawnImpl(spawn);

      const entries = await kamalAudit('staging');

      expect(entries).toEqual([]);
    });

    it('falls back to raw line for unparseable entries', async () => {
      const { spawn } = mockSpawn('some unstructured log line\n');
      setSpawnImpl(spawn);

      const entries = await kamalAudit('staging');

      expect(entries.length).toBe(1);
      expect(entries[0].details).toBe('some unstructured log line');
      expect(entries[0].timestamp).toBe('');
    });
  });

  describe('isKamalAvailable', () => {
    it('returns true when kamal version succeeds', async () => {
      const { spawn } = mockSpawn('Kamal 2.0.0\n');
      setSpawnImpl(spawn);

      const available = await isKamalAvailable();

      expect(available).toBe(true);
    });

    it('returns false when kamal version fails', async () => {
      const { spawn } = mockSpawn('', 'command not found\n', 127);
      setSpawnImpl(spawn);

      const available = await isKamalAvailable();

      expect(available).toBe(false);
    });
  });
});
