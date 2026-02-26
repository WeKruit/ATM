// ── Generic fetch helpers ────────────────────────────────────────

export async function get<T>(path: string, base = ''): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function getWithAuth<T>(path: string, secret: string, base = ''): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'X-Deploy-Secret': secret },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function post<T>(path: string, body: unknown, secret: string, base = ''): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Deploy-Secret': secret,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── Fleet types ─────────────────────────────────────────────────

export interface Server {
  id: string;
  name: string;
  host: string;
  environment: string;
  region: string;
  ip?: string;
  type?: string;
  role?: string;
}

export interface FleetConfig {
  servers: Server[];
}

// ── Secrets types ───────────────────────────────────────────────

export interface SecretKey {
  key: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretEntry {
  key: string;
  value: string;
}

// ── API response types ──────────────────────────────────────────

export interface HealthResponse {
  status: string;
  activeWorkers: number;
  deploySafe: boolean;
  apiHealthy: boolean;
  workerStatus: string;
  currentDeploy: string | null;
  uptimeMs: number;
}

export interface MetricsResponse {
  cpu: { usagePercent: number; cores: number };
  memory: { usedMb: number; totalMb: number; usagePercent: number };
  disk: { usedGb: number; totalGb: number; usagePercent: number };
}

export interface GhVersionInfo {
  service: string;
  environment: string;
  commit_sha: string;
  image_tag: string;
  build_time: string;
  uptime_ms: number;
  node_env: string;
}

export interface VersionResponse {
  deployServer: string;
  version: string;
  ghosthands: GhVersionInfo | { status: string } | null;
  uptimeMs: number;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface Worker {
  workerId: string;
  containerId: string;
  containerName: string;
  status: string;
  activeJobs: number;
  statusPort: number;
  uptime: string;
  image: string;
}

export interface Deploy {
  id: string;
  imageTag: string;
  previousImageTag: string;
  commitSha: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  triggeredBy: string;
}

export interface SecretsStatus {
  connected: boolean;
  projectId?: string;
  environment?: string;
  secretCount?: number;
  paths?: Record<string, number>;
  error?: string;
}

export interface KamalStatus {
  available: boolean;
  locked?: boolean;
  holder?: string;
  reason?: string;
}

export interface KamalAuditEntry {
  timestamp: string;
  action: string;
  performer: string;
  details: string;
}
