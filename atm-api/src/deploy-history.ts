/**
 * Deploy History — JSON file-backed deploy record storage
 *
 * Persists deploy records to /opt/ghosthands/deploy-history.json.
 * Last 50 records, append-only with rotation.
 *
 * TODO (WEK-205): Implement full deploy history + rollback logic
 *
 * @module atm-api/src/deploy-history
 */

export interface DeployRecord {
  id: string;
  imageTag: string;
  previousImageTag: string | null;
  commitSha: string | null;
  status: 'deploying' | 'completed' | 'failed' | 'rolled_back';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  triggeredBy: 'ci' | 'manual' | 'kamal' | 'rollback';
}

// Placeholder — implementation in WEK-205
