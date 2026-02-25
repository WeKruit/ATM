/**
 * Deploy History — JSON file-backed deploy record storage
 *
 * Persists deploy records to /opt/ghosthands/deploy-history.json.
 * Last 50 records, append-only with rotation.
 *
 * @module atm-api/src/deploy-history
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

function getHistoryFile(): string {
  return process.env.DEPLOY_HISTORY_PATH || '/opt/ghosthands/deploy-history.json';
}
const MAX_RECORDS = 50;

/**
 * Reads deploy history from disk. Returns [] if the file is missing or corrupt.
 */
export function loadHistory(): DeployRecord[] {
  try {
    const raw = fs.readFileSync(getHistoryFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DeployRecord[];
  } catch {
    return [];
  }
}

/**
 * Writes the full deploy history array to disk.
 * Creates parent directories if they don't exist.
 */
export function saveHistory(records: DeployRecord[]): void {
  const filePath = getHistoryFile();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * Appends a record to the history, keeping at most MAX_RECORDS (50).
 * Trims oldest records when the limit is exceeded.
 */
export function addRecord(record: DeployRecord): void {
  const records = loadHistory();
  records.push(record);
  // Trim oldest if over limit
  while (records.length > MAX_RECORDS) {
    records.shift();
  }
  saveHistory(records);
}

/**
 * Returns deploy records, newest first.
 * @param limit Maximum number of records to return (default: all)
 */
export function getRecords(limit?: number): DeployRecord[] {
  const records = loadHistory();
  const sorted = records.slice().reverse(); // newest first
  if (limit !== undefined && limit > 0) {
    return sorted.slice(0, limit);
  }
  return sorted;
}

/**
 * Finds a single deploy record by ID.
 */
export function getRecord(id: string): DeployRecord | null {
  const records = loadHistory();
  return records.find((r) => r.id === id) ?? null;
}

/**
 * Returns the most recent record with status 'completed', or null if none.
 */
export function getLastSuccessful(): DeployRecord | null {
  const records = loadHistory();
  // Search from end (most recent) backward
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].status === 'completed') {
      return records[i];
    }
  }
  return null;
}

/**
 * Updates an existing record in-place by ID and persists.
 */
export function updateRecord(
  id: string,
  updates: Partial<DeployRecord>,
): void {
  const records = loadHistory();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return;
  records[idx] = { ...records[idx], ...updates };
  saveHistory(records);
}

/**
 * Creates a new deploy record with status 'deploying'.
 * Sets previousImageTag from the last successful deploy (if any).
 */
export function createDeployRecord(
  imageTag: string,
  triggeredBy: DeployRecord['triggeredBy'],
): DeployRecord {
  const lastGood = getLastSuccessful();
  const record: DeployRecord = {
    id: crypto.randomUUID(),
    imageTag,
    previousImageTag: lastGood?.imageTag ?? null,
    commitSha: null,
    status: 'deploying',
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    error: null,
    triggeredBy,
  };
  addRecord(record);
  return record;
}
