import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-desktop-releases-'));
const dbPath = path.join(tmpDir, 'atm.db');
process.env.ATM_DB_PATH = dbPath;

import {
  activateDesktopRelease,
  getDesktopRollouts,
  getFeedMetadata,
  getLatestPublicRelease,
  initDesktopReleaseStore,
  rollbackDesktopRollout,
  setDesktopRolloutPercent,
  upsertDesktopRelease,
  type DesktopReleaseChannel,
} from '../desktop-releases';

initDesktopReleaseStore();

function clearTables(): void {
  const db = new Database(dbPath, { create: true, strict: true });
  db.exec(`
    DELETE FROM desktop_rollout_events;
    DELETE FROM desktop_rollouts;
    DELETE FROM desktop_release_metadata;
    DELETE FROM desktop_release_assets;
    DELETE FROM desktop_releases;
  `);
  db.close();
}

function makeRelease(version: string, channel: DesktopReleaseChannel) {
  return upsertDesktopRelease({
    version,
    channel,
    releaseUrl: `https://example.com/releases/${channel}/${version}`,
    repository: 'WeKruit/test',
    commitSha: `${channel}-${version}`.replace(/[^a-z0-9]/gi, '').slice(0, 12),
    commitMessage: `release ${version}`,
    publishedAt: new Date('2026-03-07T12:00:00Z').toISOString(),
    runId: null,
    runUrl: null,
    assets: [
      {
        kind: channel === 'stable' ? 'dmg_arm64' : 'dmg_arm64',
        url: `https://example.com/assets/${channel}/${version}/app.dmg`,
      },
    ],
    metadata: [
      {
        kind: 'latest_darwin_arm64',
        content: `version: ${version}\npath: app.dmg\nsha512: test\n`,
      },
      {
        kind: 'latest_darwin_x64',
        content: `version: ${version}\npath: app-x64.dmg\nsha512: test\n`,
      },
      {
        kind: 'latest_win32_x64',
        content: `version: ${version}\npath: app.exe\nsha512: test\n`,
      },
    ],
  });
}

describe('desktop-releases', () => {
  beforeEach(() => {
    clearTables();
  });

  afterAll(() => {
    clearTables();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the previous stable baseline after rolling back a 100% promoted release', () => {
    const stableOne = makeRelease('1.0.0', 'stable');
    const stableTwo = makeRelease('2.0.0', 'stable');

    activateDesktopRelease(stableTwo.id, 'test');
    setDesktopRolloutPercent(stableTwo.id, 100, 'test');
    rollbackDesktopRollout(stableTwo.id, 'test');

    const latest = getLatestPublicRelease('stable');
    const stableRollout = getDesktopRollouts().find((rollout) => rollout.channel === 'stable');

    expect(latest?.version).toBe('1.0.0');
    expect(latest?.blocked).toBe(false);
    expect(stableRollout?.baselineReleaseId).toBe(stableOne.id);
    expect(stableRollout?.candidateReleaseId).toBeNull();
    expect(stableRollout?.baselineVersion).toBe('1.0.0');
  });

  it('still serves rollback metadata to clients already on the blocked version', () => {
    makeRelease('1.0.0', 'stable');
    const stableTwo = makeRelease('2.0.0', 'stable');

    activateDesktopRelease(stableTwo.id, 'test');
    setDesktopRolloutPercent(stableTwo.id, 100, 'test');
    rollbackDesktopRollout(stableTwo.id, 'test');

    const metadata = getFeedMetadata({
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      installationId: 'install-1',
      currentVersion: '2.0.0',
    });

    expect(metadata?.release.version).toBe('1.0.0');
    expect(metadata?.content).toContain('version: 1.0.0');
  });

  it('does not auto-promote a new beta release on webhook ingest', () => {
    makeRelease('1.0.0-beta.1', 'beta');
    makeRelease('1.0.0-beta.2', 'beta');

    const latest = getLatestPublicRelease('beta');
    const betaRollout = getDesktopRollouts().find((rollout) => rollout.channel === 'beta');

    expect(latest?.version).toBe('1.0.0-beta.1');
    expect(betaRollout?.baselineVersion).toBe('1.0.0-beta.1');
    expect(betaRollout?.candidateReleaseId).toBeNull();
  });
});
