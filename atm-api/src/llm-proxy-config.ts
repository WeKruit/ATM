import crypto from "node:crypto";

export interface AnthropicProxyConfig {
  provider: "anthropic";
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  allowedModels: string[];
}

export interface ManagedLlmRuntimeProfile extends AnthropicProxyConfig {
  profileKey: string;
  transport: "anthropic-messages";
}

const DEFAULT_ALLOWED_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
];

export function getLlmProxyServiceToken(): string | null {
  return getLlmProxyServiceTokens()[0] ?? null;
}

export function getLlmProxyServiceTokens(): string[] {
  const rotated = process.env.VALET_ATM_TOKENS
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean) ?? [];
  const single = [process.env.VALET_ATM_TOKEN, process.env.ATM_SERVICE_TOKEN]
    .filter((token): token is string => typeof token === "string" && token.trim().length > 0)
    .map((token) => token.trim());
  return [...new Set([...rotated, ...single])];
}

export function verifyLlmProxyServiceToken(req: Request): boolean {
  const expectedTokens = getLlmProxyServiceTokens();
  if (expectedTokens.length === 0) return false;

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const actual = header.slice("Bearer ".length);
  for (const expected of expectedTokens) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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

export function getManagedLlmRuntimeProfile(profileKey: string): ManagedLlmRuntimeProfile {
  switch (profileKey) {
    case "desktop-default": {
      return {
        profileKey,
        transport: "anthropic-messages",
        ...getAnthropicProxyConfig(),
      };
    }
    default:
      throw new Error(`Unsupported runtime profile "${profileKey}"`);
  }
}
