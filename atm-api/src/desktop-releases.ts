import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DesktopReleaseChannel = "stable" | "beta";
export type DesktopReleasePlatform = "darwin" | "win32";
export type DesktopReleaseArch = "arm64" | "x64";
export type DesktopRolloutStatus = "idle" | "active" | "paused";

export interface DesktopReleaseAssetInput {
  kind:
    | "dmg_arm64"
    | "dmg_x64"
    | "exe_x64"
    | "exe_blockmap_x64"
    | "zip_darwin_arm64"
    | "zip_darwin_x64";
  url: string;
}

export interface DesktopReleaseMetadataInput {
  kind: "latest_win32_x64" | "latest_darwin_x64" | "latest_darwin_arm64";
  content: string;
}

export interface DesktopReleaseInput {
  version: string;
  channel: DesktopReleaseChannel;
  releaseUrl: string;
  repository: string;
  commitSha: string | null;
  commitMessage: string | null;
  publishedAt: string;
  runId: string | null;
  runUrl: string | null;
  assets: DesktopReleaseAssetInput[];
  metadata: DesktopReleaseMetadataInput[];
}

export interface DesktopReleaseSummary {
  id: string;
  version: string;
  channel: DesktopReleaseChannel;
  releaseUrl: string;
  repository: string;
  commitSha: string | null;
  commitMessage: string | null;
  publishedAt: string;
  blocked: boolean;
  assets: Record<string, string>;
}

export interface DesktopRolloutSummary {
  channel: DesktopReleaseChannel;
  baselineReleaseId: string | null;
  candidateReleaseId: string | null;
  rolloutPercent: number;
  minimumSupportedVersion: string | null;
  status: DesktopRolloutStatus;
  updatedAt: string;
  baselineVersion: string | null;
  candidateVersion: string | null;
}

function dbPath(): string {
  return process.env.ATM_DB_PATH || "/opt/atm/atm.db";
}

let db: Database | null = null;

function getDb(): Database {
  if (!db) {
    const filePath = dbPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(filePath, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS desktop_releases (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta')),
      release_url TEXT NOT NULL,
      repository TEXT NOT NULL,
      commit_sha TEXT,
      commit_message TEXT,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(version, channel)
    );

    CREATE TABLE IF NOT EXISTS desktop_release_assets (
      release_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (release_id, kind),
      FOREIGN KEY (release_id) REFERENCES desktop_releases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS desktop_release_metadata (
      release_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (release_id, kind),
      FOREIGN KEY (release_id) REFERENCES desktop_releases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS desktop_rollouts (
      channel TEXT PRIMARY KEY CHECK (channel IN ('stable', 'beta')),
      baseline_release_id TEXT,
      candidate_release_id TEXT,
      rollout_percent INTEGER NOT NULL DEFAULT 0,
      minimum_supported_version TEXT,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'active', 'paused')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (baseline_release_id) REFERENCES desktop_releases(id),
      FOREIGN KEY (candidate_release_id) REFERENCES desktop_releases(id)
    );

    CREATE TABLE IF NOT EXISTS desktop_rollout_events (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta')),
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      release_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (release_id) REFERENCES desktop_releases(id)
    );
  `);
}

function now(): string {
  return new Date().toISOString();
}

function normalizePercent(value: number): number {
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function insertEvent(
  database: Database,
  input: {
    channel: DesktopReleaseChannel;
    action: string;
    actor: string;
    releaseId?: string | null;
    payload?: Record<string, unknown>;
  },
): void {
  database
    .prepare(
      `
      INSERT INTO desktop_rollout_events (
        id, channel, action, actor, release_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      crypto.randomUUID(),
      input.channel,
      input.action,
      input.actor,
      input.releaseId ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      now(),
    );
}

function getOrCreateRollout(database: Database, channel: DesktopReleaseChannel) {
  const row = database
    .query<{
      channel: DesktopReleaseChannel;
      baselineReleaseId: string | null;
      candidateReleaseId: string | null;
      rolloutPercent: number;
      minimumSupportedVersion: string | null;
      status: DesktopRolloutStatus;
      updatedAt: string;
    }, [DesktopReleaseChannel]>(
      `
      SELECT channel, baseline_release_id AS baselineReleaseId, candidate_release_id AS candidateReleaseId,
             rollout_percent AS rolloutPercent, minimum_supported_version AS minimumSupportedVersion,
             status, updated_at AS updatedAt
      FROM desktop_rollouts
      WHERE channel = ?
    `,
    )
    .get(channel);

  if (row) return row;

  const createdAt = now();
  database
    .prepare(
      `
      INSERT INTO desktop_rollouts (
        channel, baseline_release_id, candidate_release_id, rollout_percent,
        minimum_supported_version, status, updated_at
      ) VALUES (?, NULL, NULL, 0, NULL, 'idle', ?)
    `,
    )
    .run(channel, createdAt);

  return {
    channel,
    baselineReleaseId: null,
    candidateReleaseId: null,
    rolloutPercent: 0,
    minimumSupportedVersion: null,
    status: "idle" as const,
    updatedAt: createdAt,
  };
}

function hydrateReleaseSummary(database: Database, releaseId: string): DesktopReleaseSummary | null {
  const release = database
    .query<{
      id: string;
      version: string;
      channel: DesktopReleaseChannel;
      releaseUrl: string;
      repository: string;
      commitSha: string | null;
      commitMessage: string | null;
      publishedAt: string;
      blocked: number;
    }, [string]>(
      `
      SELECT id, version, channel, release_url AS releaseUrl, repository,
             commit_sha AS commitSha, commit_message AS commitMessage,
             published_at AS publishedAt, blocked
      FROM desktop_releases
      WHERE id = ?
    `,
    )
    .get(releaseId);

  if (!release) return null;

  const assets = database
    .query<{ kind: string; url: string }, [string]>(
      `SELECT kind, url FROM desktop_release_assets WHERE release_id = ?`,
    )
    .all(releaseId);

  return {
    ...release,
    blocked: Boolean(release.blocked),
    assets: Object.fromEntries(assets.map((asset) => [asset.kind, asset.url])),
  };
}

function getMetadataContent(
  database: Database,
  releaseId: string,
  kind: DesktopReleaseMetadataInput["kind"],
): string | null {
  const row = database
    .query<{ content: string }, [string, string]>(
      `SELECT content FROM desktop_release_metadata WHERE release_id = ? AND kind = ?`,
    )
    .get(releaseId, kind);
  return row?.content ?? null;
}

function semverCompare(left: string, right: string): number {
  const split = (value: string) => {
    const [core, prerelease = ""] = value.split("-", 2);
    return {
      parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease,
    };
  };

  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function resolveAssetKind(platform: DesktopReleasePlatform, arch: DesktopReleaseArch, filename: string): string | null {
  if (platform === "darwin") {
    if (filename.endsWith(".dmg")) return arch === "arm64" ? "dmg_arm64" : "dmg_x64";
    if (filename.endsWith(".zip")) return arch === "arm64" ? "zip_darwin_arm64" : "zip_darwin_x64";
  }
  if (platform === "win32") {
    if (filename.endsWith(".blockmap")) return "exe_blockmap_x64";
    if (filename.endsWith(".exe")) return "exe_x64";
  }
  return null;
}

export function initDesktopReleaseStore(): void {
  getDb();
}

export function upsertDesktopRelease(input: DesktopReleaseInput): DesktopReleaseSummary {
  const database = getDb();
  const existing = database
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM desktop_releases WHERE version = ? AND channel = ?`,
    )
    .get(input.version, input.channel);

  const releaseId = existing?.id ?? crypto.randomUUID();
  const tx = database.transaction(() => {
    database
      .prepare(
        `
        INSERT INTO desktop_releases (
          id, version, channel, release_url, repository, commit_sha, commit_message,
          published_at, created_at, blocked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(version, channel) DO UPDATE SET
          release_url = excluded.release_url,
          repository = excluded.repository,
          commit_sha = excluded.commit_sha,
          commit_message = excluded.commit_message,
          published_at = excluded.published_at
      `,
      )
      .run(
        releaseId,
        input.version,
        input.channel,
        input.releaseUrl,
        input.repository,
        input.commitSha,
        input.commitMessage,
        input.publishedAt,
        now(),
      );

    database.prepare(`DELETE FROM desktop_release_assets WHERE release_id = ?`).run(releaseId);
    for (const asset of input.assets) {
      database
        .prepare(`INSERT INTO desktop_release_assets (release_id, kind, url) VALUES (?, ?, ?)`)
        .run(releaseId, asset.kind, asset.url);
    }

    database.prepare(`DELETE FROM desktop_release_metadata WHERE release_id = ?`).run(releaseId);
    for (const metadata of input.metadata) {
      database
        .prepare(`INSERT INTO desktop_release_metadata (release_id, kind, content) VALUES (?, ?, ?)`)
        .run(releaseId, metadata.kind, metadata.content);
    }

    const rollout = getOrCreateRollout(database, input.channel);
    if (input.channel === "beta") {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET baseline_release_id = ?, candidate_release_id = NULL, rollout_percent = 100,
              status = 'active', updated_at = ?
          WHERE channel = 'beta'
        `,
        )
        .run(releaseId, now());
    } else if (!rollout.baselineReleaseId) {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET baseline_release_id = ?, candidate_release_id = NULL, rollout_percent = 100,
              status = 'active', updated_at = ?
          WHERE channel = 'stable'
        `,
        )
        .run(releaseId, now());
    }

    insertEvent(database, {
      channel: input.channel,
      action: existing ? "release.updated" : "release.created",
      actor: "ci",
      releaseId,
      payload: {
        version: input.version,
        releaseUrl: input.releaseUrl,
        runId: input.runId,
        runUrl: input.runUrl,
      },
    });
  });

  tx();

  const summary = hydrateReleaseSummary(database, releaseId);
  if (!summary) throw new Error("Failed to persist desktop release");
  return summary;
}

export function listDesktopReleases(channel?: DesktopReleaseChannel): DesktopReleaseSummary[] {
  const database = getDb();
  const ids = channel
    ? database
        .query<{ id: string }, [DesktopReleaseChannel]>(
          `SELECT id FROM desktop_releases WHERE channel = ? ORDER BY published_at DESC, created_at DESC`,
        )
        .all(channel)
    : database
        .query<{ id: string }, []>(
          `SELECT id FROM desktop_releases ORDER BY published_at DESC, created_at DESC`,
        )
        .all();

  return ids
    .map((row) => hydrateReleaseSummary(database, row.id))
    .filter((row): row is DesktopReleaseSummary => row !== null);
}

export function getDesktopRollouts(): DesktopRolloutSummary[] {
  const database = getDb();
  const rows = database
    .query<DesktopRolloutSummary, []>(
      `
      SELECT r.channel, r.baseline_release_id AS baselineReleaseId, r.candidate_release_id AS candidateReleaseId,
             r.rollout_percent AS rolloutPercent, r.minimum_supported_version AS minimumSupportedVersion,
             r.status, r.updated_at AS updatedAt,
             baseline.version AS baselineVersion, candidate.version AS candidateVersion
      FROM desktop_rollouts r
      LEFT JOIN desktop_releases baseline ON baseline.id = r.baseline_release_id
      LEFT JOIN desktop_releases candidate ON candidate.id = r.candidate_release_id
      ORDER BY CASE r.channel WHEN 'stable' THEN 0 ELSE 1 END
    `,
    )
    .all();

  if (rows.length > 0) return rows;

  return (["stable", "beta"] as DesktopReleaseChannel[]).map((channel) => ({
    ...getOrCreateRollout(database, channel),
    baselineVersion: null,
    candidateVersion: null,
  }));
}

export function activateDesktopRelease(releaseId: string, actor = "operator"): DesktopRolloutSummary {
  const database = getDb();
  const release = database
    .query<{ id: string; channel: DesktopReleaseChannel; version: string }, [string]>(
      `SELECT id, channel, version FROM desktop_releases WHERE id = ?`,
    )
    .get(releaseId);

  if (!release) throw new Error("Desktop release not found");

  const tx = database.transaction(() => {
    const rollout = getOrCreateRollout(database, release.channel);
    if (release.channel === "beta") {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET baseline_release_id = ?, candidate_release_id = NULL, rollout_percent = 100,
              status = 'active', updated_at = ?
          WHERE channel = 'beta'
        `,
        )
        .run(release.id, now());
    } else {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET baseline_release_id = COALESCE(baseline_release_id, ?),
              candidate_release_id = ?, rollout_percent = 0,
              status = 'paused', updated_at = ?
          WHERE channel = 'stable'
        `,
        )
        .run(rollout.baselineReleaseId ?? release.id, release.id, now());
    }

    insertEvent(database, {
      channel: release.channel,
      action: "rollout.activated",
      actor,
      releaseId: release.id,
      payload: { version: release.version },
    });
  });

  tx();

  const rollout = getDesktopRollouts().find((row) => row.channel === release.channel);
  if (!rollout) throw new Error("Desktop rollout not found after activation");
  return rollout;
}

export function setDesktopRolloutPercent(
  releaseId: string,
  rolloutPercent: number,
  actor = "operator",
): DesktopRolloutSummary {
  const database = getDb();
  const release = database
    .query<{ id: string; channel: DesktopReleaseChannel; version: string }, [string]>(
      `SELECT id, channel, version FROM desktop_releases WHERE id = ?`,
    )
    .get(releaseId);

  if (!release) throw new Error("Desktop release not found");

  const normalizedPercent = normalizePercent(rolloutPercent);
  const tx = database.transaction(() => {
    const rollout = getOrCreateRollout(database, release.channel);
    if (release.channel === "beta") {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET baseline_release_id = ?, candidate_release_id = NULL, rollout_percent = 100,
              status = 'active', updated_at = ?
          WHERE channel = 'beta'
        `,
        )
        .run(release.id, now());
      return;
    }

    if (normalizedPercent >= 100) {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET baseline_release_id = ?, candidate_release_id = NULL, rollout_percent = 100,
              status = 'active', updated_at = ?
          WHERE channel = 'stable'
        `,
        )
        .run(release.id, now());
    } else {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET baseline_release_id = COALESCE(baseline_release_id, ?),
              candidate_release_id = ?, rollout_percent = ?, status = 'active',
              updated_at = ?
          WHERE channel = 'stable'
        `,
        )
        .run(rollout.baselineReleaseId ?? release.id, release.id, normalizedPercent, now());
    }

    insertEvent(database, {
      channel: release.channel,
      action: "rollout.updated",
      actor,
      releaseId: release.id,
      payload: {
        version: release.version,
        rolloutPercent: normalizedPercent,
      },
    });
  });

  tx();

  const rollout = getDesktopRollouts().find((row) => row.channel === release.channel);
  if (!rollout) throw new Error("Desktop rollout not found after update");
  return rollout;
}

export function pauseDesktopRollout(releaseId: string, actor = "operator"): DesktopRolloutSummary {
  const database = getDb();
  const release = database
    .query<{ id: string; channel: DesktopReleaseChannel; version: string }, [string]>(
      `SELECT id, channel, version FROM desktop_releases WHERE id = ?`,
    )
    .get(releaseId);

  if (!release) throw new Error("Desktop release not found");

  database
    .prepare(
      `
      UPDATE desktop_rollouts
      SET candidate_release_id = CASE WHEN channel = 'stable' THEN ? ELSE candidate_release_id END,
          rollout_percent = CASE WHEN channel = 'stable' THEN 0 ELSE rollout_percent END,
          status = CASE WHEN channel = 'stable' THEN 'paused' ELSE status END,
          updated_at = ?
      WHERE channel = ?
    `,
    )
    .run(release.id, now(), release.channel);

  insertEvent(database, {
    channel: release.channel,
    action: "rollout.paused",
    actor,
    releaseId: release.id,
    payload: { version: release.version },
  });

  const rollout = getDesktopRollouts().find((row) => row.channel === release.channel);
  if (!rollout) throw new Error("Desktop rollout not found after pause");
  return rollout;
}

export function rollbackDesktopRollout(releaseId: string, actor = "operator"): DesktopRolloutSummary {
  const database = getDb();
  const release = database
    .query<{ id: string; channel: DesktopReleaseChannel; version: string }, [string]>(
      `SELECT id, channel, version FROM desktop_releases WHERE id = ?`,
    )
    .get(releaseId);

  if (!release) throw new Error("Desktop release not found");

  const tx = database.transaction(() => {
    database.prepare(`UPDATE desktop_releases SET blocked = 1 WHERE id = ?`).run(release.id);

    if (release.channel === "stable") {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET candidate_release_id = NULL, rollout_percent = 100, status = 'active', updated_at = ?
          WHERE channel = 'stable'
        `,
        )
        .run(now());
    } else {
      database
        .prepare(
          `
          UPDATE desktop_rollouts
          SET status = 'idle', updated_at = ?
          WHERE channel = 'beta'
        `,
        )
        .run(now());
    }

    insertEvent(database, {
      channel: release.channel,
      action: "rollout.rolled_back",
      actor,
      releaseId: release.id,
      payload: { version: release.version },
    });
  });

  tx();

  const rollout = getDesktopRollouts().find((row) => row.channel === release.channel);
  if (!rollout) throw new Error("Desktop rollout not found after rollback");
  return rollout;
}

export function setMinimumSupportedVersion(
  channel: DesktopReleaseChannel,
  minimumSupportedVersion: string | null,
  actor = "operator",
): DesktopRolloutSummary {
  const database = getDb();
  getOrCreateRollout(database, channel);
  database
    .prepare(
      `
      UPDATE desktop_rollouts
      SET minimum_supported_version = ?, updated_at = ?
      WHERE channel = ?
    `,
    )
    .run(minimumSupportedVersion, now(), channel);

  insertEvent(database, {
    channel,
    action: "rollout.minimum_supported.updated",
    actor,
    payload: { minimumSupportedVersion },
  });

  const rollout = getDesktopRollouts().find((row) => row.channel === channel);
  if (!rollout) throw new Error("Desktop rollout not found after minimum version update");
  return rollout;
}

export function getLatestPublicRelease(channel: DesktopReleaseChannel): DesktopReleaseSummary | null {
  const database = getDb();
  const rollout = getOrCreateRollout(database, channel);
  if (!rollout.baselineReleaseId) return null;
  return hydrateReleaseSummary(database, rollout.baselineReleaseId);
}

function resolveFeedRelease(channel: DesktopReleaseChannel, installationId: string): DesktopReleaseSummary | null {
  const database = getDb();
  const rollout = getOrCreateRollout(database, channel);
  const baseline = rollout.baselineReleaseId
    ? hydrateReleaseSummary(database, rollout.baselineReleaseId)
    : null;
  const candidate = rollout.candidateReleaseId
    ? hydrateReleaseSummary(database, rollout.candidateReleaseId)
    : null;

  if (channel === "beta") {
    return baseline && !baseline.blocked ? baseline : null;
  }

  if (
    candidate &&
    rollout.status === "active" &&
    !candidate.blocked &&
    rollout.rolloutPercent > 0
  ) {
    const bucket =
      crypto
        .createHash("sha256")
        .update(`${installationId}:${candidate.id}`)
        .digest()
        .readUInt32BE(0) % 100;

    if (bucket < rollout.rolloutPercent) {
      return candidate;
    }
  }

  return baseline && !baseline.blocked ? baseline : null;
}

export function getFeedMetadata(input: {
  channel: DesktopReleaseChannel;
  platform: DesktopReleasePlatform;
  arch: DesktopReleaseArch;
  installationId: string;
  currentVersion?: string | null;
}): { content: string; release: DesktopReleaseSummary; minimumSupportedVersion: string | null } | null {
  const database = getDb();
  const release = resolveFeedRelease(input.channel, input.installationId);
  if (!release) return null;

  if (input.currentVersion && semverCompare(release.version, input.currentVersion) < 0) {
    return null;
  }

  const kind =
    input.platform === "darwin"
      ? input.arch === "arm64"
        ? "latest_darwin_arm64"
        : "latest_darwin_x64"
      : "latest_win32_x64";
  const content = getMetadataContent(database, release.id, kind);
  if (!content) return null;

  const rollout = getOrCreateRollout(database, input.channel);
  return {
    content,
    release,
    minimumSupportedVersion: rollout.minimumSupportedVersion,
  };
}

export function resolveFeedAssetRedirect(input: {
  channel: DesktopReleaseChannel;
  platform: DesktopReleasePlatform;
  arch: DesktopReleaseArch;
  installationId: string;
  currentVersion?: string | null;
  filename: string;
}): { release: DesktopReleaseSummary; url: string } | null {
  const release = resolveFeedRelease(input.channel, input.installationId);
  if (!release) return null;

  if (input.currentVersion && semverCompare(release.version, input.currentVersion) < 0) {
    return null;
  }

  const kind = resolveAssetKind(input.platform, input.arch, input.filename);
  if (!kind) return null;
  const url = release.assets[kind];
  if (!url) return null;

  return { release, url };
}
