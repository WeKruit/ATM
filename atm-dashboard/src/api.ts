const BASE = '';

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function post<T>(path: string, body: unknown, secret: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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

// Types for API responses

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

export interface VersionResponse {
  deployServer: string;
  version: string;
  ghosthands: string;
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
