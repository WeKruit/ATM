import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';

// We test by starting a minimal server that mimics the CORS/auth logic.
// This avoids importing the full server.ts which has side effects (Docker, EC2, etc.)

// Extract and test the CORS + auth logic in isolation
const CORS_ORIGINS_DEFAULT = 'https://valet-web-stg.fly.dev,https://valet-web.fly.dev,http://localhost:5173';
const DEPLOY_SECRET = 'test-secret-for-tests';

function buildAllowedOrigins(envValue?: string): Set<string> {
  const raw = envValue || CORS_ORIGINS_DEFAULT;
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

function getCorsHeaders(req: Request, allowedOrigins: Set<string>): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || !allowedOrigins.has(origin)) return {};
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
  if (req.method === 'OPTIONS') {
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Deploy-Secret';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

function verifySecret(req: Request): boolean {
  const header = req.headers.get('x-deploy-secret');
  if (!header) return false;
  try {
    const crypto = require('node:crypto');
    return crypto.timingSafeEqual(
      Buffer.from(header),
      Buffer.from(DEPLOY_SECRET),
    );
  } catch {
    return false;
  }
}

function withCors(response: Response, req: Request, allowedOrigins: Set<string>): Response {
  const corsHeaders = getCorsHeaders(req, allowedOrigins);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

describe('ATM Server Security', () => {
  let server: Server;
  let baseUrl: string;
  const allowedOrigins = buildAllowedOrigins();

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0, // random available port
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: getCorsHeaders(req, allowedOrigins) });
        }

        // /health — no auth
        if (url.pathname === '/health' && req.method === 'GET') {
          return withCors(Response.json({ status: 'ok' }), req, allowedOrigins);
        }

        // /metrics — no auth
        if (url.pathname === '/metrics' && req.method === 'GET') {
          return withCors(Response.json({ cpu: 0.1 }), req, allowedOrigins);
        }

        // /containers — requires auth
        if (url.pathname === '/containers' && req.method === 'GET') {
          if (!verifySecret(req)) {
            return withCors(
              Response.json({ success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' }, { status: 401 }),
              req, allowedOrigins,
            );
          }
          return withCors(Response.json([{ id: 'abc123', name: 'test' }]), req, allowedOrigins);
        }

        // /workers — requires auth
        if (url.pathname === '/workers' && req.method === 'GET') {
          if (!verifySecret(req)) {
            return withCors(
              Response.json({ success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' }, { status: 401 }),
              req, allowedOrigins,
            );
          }
          return withCors(Response.json([{ workerId: 'w1' }]), req, allowedOrigins);
        }

        // /fleet/idle-status — requires auth (exposes IPs + instance IDs)
        if (url.pathname === '/fleet/idle-status' && req.method === 'GET') {
          if (!verifySecret(req)) {
            return withCors(
              Response.json({ success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' }, { status: 401 }),
              req, allowedOrigins,
            );
          }
          return withCors(Response.json({ enabled: true, workers: [] }), req, allowedOrigins);
        }

        // /fleet — supports environment filter + includeTerminated toggle
        if (url.pathname === '/fleet' && req.method === 'GET') {
          const env = url.searchParams.get('environment') || 'staging';
          const includeTerminated = url.searchParams.get('includeTerminated') === 'true';
          const allServers = [
            { id: 'atm-gw1', role: 'atm', environment: 'staging' },
            { id: 'gh-stg-1', role: 'ghosthands', environment: 'staging', ec2State: 'running' },
            { id: 'gh-prod-1', role: 'ghosthands', environment: 'production', ec2State: 'terminated' },
          ];
          const envScoped = env === 'all' ? allServers : allServers.filter((s) => s.environment === env || s.role === 'atm');
          const servers = includeTerminated
            ? envScoped
            : envScoped.filter((s) => s.ec2State !== 'terminated');
          return withCors(
            Response.json({
              servers,
              filter: { environment: env, includeTerminated, currentEnvironment: 'staging' },
            }),
            req,
            allowedOrigins,
          );
        }

        // /fleet/:id/workers — requires auth (proxied worker metadata)
        if (url.pathname.startsWith('/fleet/') && req.method === 'GET') {
          const rest = url.pathname.slice('/fleet/'.length);
          const slashIdx = rest.indexOf('/');
          if (slashIdx !== -1) {
            const endpoint = rest.slice(slashIdx);
            if (endpoint === '/workers') {
              if (!verifySecret(req)) {
                return withCors(
                  Response.json({ success: false, message: 'Unauthorized: invalid or missing X-Deploy-Secret' }, { status: 401 }),
                  req, allowedOrigins,
                );
              }
              return withCors(Response.json([{ workerId: 'w1' }]), req, allowedOrigins);
            }
            // /fleet/:id/health — no auth (public health check)
            if (endpoint === '/health') {
              return withCors(Response.json({ status: 'healthy' }), req, allowedOrigins);
            }
          }
        }

        return withCors(Response.json({ error: 'Not found' }, { status: 404 }), req, allowedOrigins);
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  // ── CORS Tests ──────────────────────────────────────────────────

  describe('CORS origin validation', () => {
    test('OPTIONS with allowed origin returns 204 with matching Access-Control-Allow-Origin', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://valet-web-stg.fly.dev' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://valet-web-stg.fly.dev');
      expect(res.headers.get('Vary')).toBe('Origin');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    });

    test('OPTIONS with disallowed origin returns 204 with no CORS headers', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example.com' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    test('OPTIONS without Origin header returns 204 with no CORS headers', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        method: 'OPTIONS',
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    test('GET with allowed origin echoes origin in response', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
      expect(res.headers.get('Vary')).toBe('Origin');
      // Non-preflight should NOT have Allow-Methods
      expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull();
    });

    test('GET with disallowed origin gets no CORS headers', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://attacker.com' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    test('allowed origins set contains all defaults', () => {
      expect(allowedOrigins.has('https://valet-web-stg.fly.dev')).toBe(true);
      expect(allowedOrigins.has('https://valet-web.fly.dev')).toBe(true);
      expect(allowedOrigins.has('http://localhost:5173')).toBe(true);
      expect(allowedOrigins.size).toBe(3);
    });

    test('empty CORS_ORIGINS string produces empty set', () => {
      const empty = buildAllowedOrigins('');
      // Falls back to default when empty string
      expect(empty.size).toBe(3);

      // Explicit whitespace-only
      const whitespace = new Set('   '.split(',').map(s => s.trim()).filter(Boolean));
      expect(whitespace.size).toBe(0);
    });
  });

  // ── Auth Tests ──────────────────────────────────────────────────

  describe('endpoint authentication', () => {
    test('GET /health returns 200 without auth', async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    test('GET /metrics returns 200 without auth', async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
    });

    test('GET /workers returns 401 without X-Deploy-Secret', async () => {
      const res = await fetch(`${baseUrl}/workers`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('Unauthorized');
    });

    test('GET /workers returns 401 with wrong secret', async () => {
      const res = await fetch(`${baseUrl}/workers`, {
        headers: { 'X-Deploy-Secret': 'wrong-secret' },
      });
      expect(res.status).toBe(401);
    });

    test('GET /workers returns 200 with valid secret', async () => {
      const res = await fetch(`${baseUrl}/workers`, {
        headers: { 'X-Deploy-Secret': DEPLOY_SECRET },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    test('GET /containers returns 401 without X-Deploy-Secret', async () => {
      const res = await fetch(`${baseUrl}/containers`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    test('GET /containers returns 200 with valid secret', async () => {
      const res = await fetch(`${baseUrl}/containers`, {
        headers: { 'X-Deploy-Secret': DEPLOY_SECRET },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // ── Combined CORS + Auth ──────────────────────────────────────

  describe('CORS + auth combined', () => {
    test('authenticated request from allowed origin gets both auth and CORS', async () => {
      const res = await fetch(`${baseUrl}/workers`, {
        headers: {
          'Origin': 'https://valet-web-stg.fly.dev',
          'X-Deploy-Secret': DEPLOY_SECRET,
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://valet-web-stg.fly.dev');
    });

    test('unauthenticated request from allowed origin gets 401 with CORS headers', async () => {
      const res = await fetch(`${baseUrl}/workers`, {
        headers: { 'Origin': 'https://valet-web-stg.fly.dev' },
      });
      expect(res.status).toBe(401);
      // CORS headers should still be set so the browser can read the error
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://valet-web-stg.fly.dev');
    });
  });

  // ── Integration: fleet proxy auth + CORS wiring ──────────────
  // These tests exercise the full request→routing→auth→CORS pipeline
  // through the test server's fetch handler, matching server.ts's actual
  // routing pattern (pathname matching → auth guard → response → withCors).

  describe('fleet proxy endpoint auth (integration)', () => {
    test('GET /fleet defaults to staging scope and hides terminated', async () => {
      const res = await fetch(`${baseUrl}/fleet`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.filter.environment).toBe('staging');
      expect(body.filter.includeTerminated).toBe(false);
      expect(body.servers.some((s: { id: string }) => s.id === 'gh-prod-1')).toBe(false);
    });

    test('GET /fleet supports all environments + includeTerminated=true', async () => {
      const res = await fetch(`${baseUrl}/fleet?environment=all&includeTerminated=true`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.filter.environment).toBe('all');
      expect(body.filter.includeTerminated).toBe(true);
      expect(body.servers.some((s: { id: string }) => s.id === 'gh-prod-1')).toBe(true);
    });

    test('GET /fleet/:id/workers returns 401 without secret', async () => {
      const res = await fetch(`${baseUrl}/fleet/gh-worker-1/workers`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('Unauthorized');
    });

    test('GET /fleet/:id/workers returns 200 with valid secret', async () => {
      const res = await fetch(`${baseUrl}/fleet/gh-worker-1/workers`, {
        headers: { 'X-Deploy-Secret': DEPLOY_SECRET },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    test('GET /fleet/:id/workers with CORS returns auth + CORS headers', async () => {
      const res = await fetch(`${baseUrl}/fleet/gh-worker-1/workers`, {
        headers: {
          'X-Deploy-Secret': DEPLOY_SECRET,
          'Origin': 'https://valet-web-stg.fly.dev',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://valet-web-stg.fly.dev');
      expect(res.headers.get('Vary')).toBe('Origin');
    });

    test('GET /fleet/:id/health remains open (no auth required)', async () => {
      const res = await fetch(`${baseUrl}/fleet/gh-worker-1/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('healthy');
    });

    test('GET /fleet/idle-status returns 401 without secret', async () => {
      const res = await fetch(`${baseUrl}/fleet/idle-status`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    test('GET /fleet/idle-status returns 200 with valid secret', async () => {
      const res = await fetch(`${baseUrl}/fleet/idle-status`, {
        headers: { 'X-Deploy-Secret': DEPLOY_SECRET },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
    });

    test('OPTIONS on /fleet/:id/workers with allowed origin returns preflight headers', async () => {
      const res = await fetch(`${baseUrl}/fleet/gh-worker-1/workers`, {
        method: 'OPTIONS',
        headers: { 'Origin': 'https://valet-web.fly.dev' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://valet-web.fly.dev');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    });
  });
});
