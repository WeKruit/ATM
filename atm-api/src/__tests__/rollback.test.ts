import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set DEPLOY_HISTORY_PATH to a temp file BEFORE importing the module
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-rollback-test-'));
const historyFile = path.join(tmpDir, 'deploy-history.json');
process.env.DEPLOY_HISTORY_PATH = historyFile;

import {
  addRecord,
  loadHistory,
  getRecord,
  type DeployRecord,
} from '../deploy-history';
import { executeRollback, type DeployExecutor } from '../rollback';

function makeRecord(overrides: Partial<DeployRecord> = {}): DeployRecord {
  return {
    id: crypto.randomUUID(),
    imageTag: 'staging-abc123',
    previousImageTag: null,
    commitSha: null,
    status: 'completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 5000,
    error: null,
    triggeredBy: 'ci',
    ...overrides,
  };
}

describe('rollback', () => {
  beforeEach(() => {
    if (fs.existsSync(historyFile)) {
      fs.unlinkSync(historyFile);
    }
  });

  afterEach(() => {
    if (fs.existsSync(historyFile)) {
      fs.unlinkSync(historyFile);
    }
  });

  describe('executeRollback', () => {
    it('returns error when no deploy history exists', async () => {
      const executor: DeployExecutor = async () => ({
        success: true,
        duration: 1000,
        imageTag: 'v1',
        spaceReclaimed: 0,
      });

      const result = await executeRollback(executor);
      expect(result.success).toBe(false);
      expect(result.message).toBe('No previous successful deploy found in history');
    });

    it('returns error when no successful deploys exist', async () => {
      addRecord(makeRecord({ status: 'failed', imageTag: 'v1' }));
      addRecord(makeRecord({ status: 'deploying', imageTag: 'v2' }));

      const executor: DeployExecutor = async () => ({
        success: true,
        duration: 1000,
        imageTag: 'v1',
        spaceReclaimed: 0,
      });

      const result = await executeRollback(executor);
      expect(result.success).toBe(false);
      expect(result.message).toBe('No previous successful deploy found in history');
    });

    it('calls executor with the last successful image tag', async () => {
      addRecord(makeRecord({ status: 'completed', imageTag: 'v1-good' }));
      addRecord(makeRecord({ status: 'completed', imageTag: 'v2-good' }));
      addRecord(makeRecord({ status: 'failed', imageTag: 'v3-bad' }));

      let calledWith = '';
      const executor: DeployExecutor = async (imageTag) => {
        calledWith = imageTag;
        return {
          success: true as const,
          duration: 2000,
          imageTag,
          spaceReclaimed: 0,
        };
      };

      const result = await executeRollback(executor);
      expect(result.success).toBe(true);
      expect(calledWith).toBe('v2-good');
      expect(result.rollbackImageTag).toBe('v2-good');
      expect(result.message).toBe('Rolled back to v2-good');
    });

    it('records successful rollback in deploy history', async () => {
      addRecord(makeRecord({ status: 'completed', imageTag: 'v1-good' }));

      const executor: DeployExecutor = async (imageTag) => ({
        success: true as const,
        duration: 1500,
        imageTag,
        spaceReclaimed: 0,
      });

      const result = await executeRollback(executor);
      expect(result.success).toBe(true);

      // The rollback should have created a new record in history
      const history = loadHistory();
      // Original record + rollback record
      expect(history.length).toBe(2);

      const rollbackRecord = history[1];
      expect(rollbackRecord.triggeredBy).toBe('rollback');
      expect(rollbackRecord.imageTag).toBe('v1-good');
      // The record should be updated to completed by now
      const stored = getRecord(rollbackRecord.id);
      expect(stored!.status).toBe('completed');
      expect(stored!.durationMs).toBe(1500);
    });

    it('records failed rollback in deploy history', async () => {
      addRecord(makeRecord({ status: 'completed', imageTag: 'v1-good' }));

      const executor: DeployExecutor = async () => ({
        success: false as const,
        error: 'ECR auth failed',
        failedStep: 'ecr-auth',
      });

      const result = await executeRollback(executor);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Rollback failed: ECR auth failed');

      // The rollback record should be marked as failed
      const history = loadHistory();
      expect(history.length).toBe(2);
      const rollbackRecord = history[1];
      const stored = getRecord(rollbackRecord.id);
      expect(stored!.status).toBe('failed');
      expect(stored!.error).toBe('ECR auth failed');
    });

    it('returns deployRecord on success', async () => {
      addRecord(makeRecord({ status: 'completed', imageTag: 'target-tag' }));

      const executor: DeployExecutor = async (imageTag) => ({
        success: true as const,
        duration: 3000,
        imageTag,
        spaceReclaimed: 100,
      });

      const result = await executeRollback(executor);
      expect(result.success).toBe(true);
      expect(result.deployRecord).toBeDefined();
      expect(result.deployRecord!.imageTag).toBe('target-tag');
      expect(result.deployRecord!.triggeredBy).toBe('rollback');
      expect(result.deployRecord!.status).toBe('completed');
    });
  });
});
