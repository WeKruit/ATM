/**
 * Rollback — Rollback logic using previous image tag from deploy history
 *
 * 1. Find last successful deploy in history
 * 2. Use its imageTag as rollback target
 * 3. Execute same rolling deploy flow with old image
 * 4. Record rollback in deploy history
 *
 * @module atm-api/src/rollback
 */

import {
  getLastSuccessful,
  createDeployRecord,
  updateRecord,
  type DeployRecord,
} from './deploy-history';

/**
 * Executor function type — matches the signature of executeDeploy() in server.ts.
 * Passed as a parameter to avoid circular imports.
 */
export type DeployExecutor = (
  imageTag: string,
) => Promise<
  | { success: true; duration: number; imageTag: string; spaceReclaimed: number }
  | { success: false; error: string; failedStep?: string; failedService?: string }
>;

export interface RollbackResult {
  success: boolean;
  message: string;
  rollbackImageTag?: string;
  deployRecord?: DeployRecord;
}

/**
 * Executes a rollback by redeploying the last successful image tag.
 *
 * @param executor — The deploy function from server.ts (avoids circular import)
 * @returns Result object indicating success/failure and the rolled-back image tag
 */
export async function executeRollback(
  executor: DeployExecutor,
): Promise<RollbackResult> {
  // 1. Find last successful deploy
  const lastGood = getLastSuccessful();
  if (!lastGood) {
    return {
      success: false,
      message: 'No previous successful deploy found in history',
    };
  }

  // 2. Create rollback deploy record
  const record = createDeployRecord(lastGood.imageTag, 'rollback');

  // 3. Execute deploy with the old image tag
  const result = await executor(lastGood.imageTag);

  // 4. Update record based on result
  if (result.success) {
    updateRecord(record.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      durationMs: result.duration,
    });
    return {
      success: true,
      message: `Rolled back to ${lastGood.imageTag}`,
      rollbackImageTag: lastGood.imageTag,
      deployRecord: { ...record, status: 'completed', durationMs: result.duration },
    };
  } else {
    updateRecord(record.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: result.error,
    });
    return {
      success: false,
      message: `Rollback failed: ${result.error}`,
    };
  }
}
