import crypto from "node:crypto";

export interface AnthropicProxyConfig {
  provider: "anthropic";
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  allowedModels: string[];
}

const DEFAULT_ALLOWED_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
];

export function getLlmProxyServiceToken(): string | null {
  return process.env.VALET_ATM_TOKEN ?? process.env.ATM_SERVICE_TOKEN ?? null;
}

export function verifyLlmProxyServiceToken(req: Request): boolean {
  const expected = getLlmProxyServiceToken();
  if (!expected) return false;

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const actual = header.slice("Bearer ".length);
  try {
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

function parseAllowedModels(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_ALLOWED_MODELS;
  const models = raw
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return models.length > 0 ? models : DEFAULT_ALLOWED_MODELS;
}

export function getAnthropicProxyConfig(): AnthropicProxyConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  return {
    provider: "anthropic",
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    apiKey,
    defaultModel: process.env.ANTHROPIC_DEFAULT_MODEL || DEFAULT_ALLOWED_MODELS[0],
    allowedModels: parseAllowedModels(process.env.ANTHROPIC_ALLOWED_MODELS),
  };
}
