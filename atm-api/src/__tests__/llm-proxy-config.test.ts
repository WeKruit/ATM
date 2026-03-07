import { afterEach, describe, expect, it } from "bun:test";
import {
  getAnthropicProxyConfig,
  getLlmProxyServiceTokens,
  getManagedLlmRuntimeProfile,
  getLlmProxyServiceToken,
  verifyLlmProxyServiceToken,
} from "../llm-proxy-config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("llm proxy config", () => {
  it("reads anthropic proxy config from env", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";
    process.env.ANTHROPIC_BASE_URL = "https://anthropic-proxy.example.com";
    process.env.ANTHROPIC_DEFAULT_MODEL = "claude-custom";
    process.env.ANTHROPIC_ALLOWED_MODELS = "claude-custom, claude-haiku";

    expect(getAnthropicProxyConfig()).toEqual({
      provider: "anthropic",
      baseUrl: "https://anthropic-proxy.example.com",
      apiKey: "anthropic-secret",
      defaultModel: "claude-custom",
      allowedModels: ["claude-custom", "claude-haiku"],
    });
  });

  it("throws when anthropic key is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getAnthropicProxyConfig()).toThrow("ANTHROPIC_API_KEY is not configured");
  });

  it("prefers VALET_ATM_TOKEN over ATM_SERVICE_TOKEN", () => {
    process.env.ATM_SERVICE_TOKEN = "fallback-token";
    process.env.VALET_ATM_TOKEN = "preferred-token";
    expect(getLlmProxyServiceToken()).toBe("preferred-token");
  });

  it("supports token rotation via VALET_ATM_TOKENS", () => {
    process.env.VALET_ATM_TOKENS = "next-token, current-token";

    expect(getLlmProxyServiceTokens()).toEqual(["next-token", "current-token"]);
  });

  it("verifies the dedicated bearer token", () => {
    process.env.VALET_ATM_TOKEN = "atm-runtime-token";
    const req = new Request("https://atm.example.com/internal/llm-proxy-config", {
      headers: { Authorization: "Bearer atm-runtime-token" },
    });
    expect(verifyLlmProxyServiceToken(req)).toBe(true);
  });

  it("rejects invalid bearer tokens", () => {
    process.env.VALET_ATM_TOKEN = "atm-runtime-token";
    const req = new Request("https://atm.example.com/internal/llm-proxy-config", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(verifyLlmProxyServiceToken(req)).toBe(false);
  });

  it("returns the desktop managed runtime profile", () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";

    expect(getManagedLlmRuntimeProfile("desktop-default")).toEqual({
      profileKey: "desktop-default",
      transport: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "anthropic-secret",
      defaultModel: "claude-sonnet-4-20250514",
      allowedModels: [
        "claude-sonnet-4-20250514",
        "claude-haiku-4-5-20251001",
      ],
    });
  });
});
