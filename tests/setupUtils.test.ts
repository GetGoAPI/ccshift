import { describe, expect, it } from "vitest";
import {
  buildSetupProvider,
  claudeBaseUrl,
  codexBaseUrl,
  defaultProviderName,
  filterModelsFor,
  isValidHttpUrl,
} from "@/components/setup/setupUtils";

describe("快速配置：地址规整", () => {
  it("Claude Code 去掉结尾的 /v1 和斜杠", () => {
    expect(claudeBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com",
    );
    expect(claudeBaseUrl(" https://api.example.com ")).toBe(
      "https://api.example.com",
    );
    expect(claudeBaseUrl("https://x.com/anthropic")).toBe(
      "https://x.com/anthropic",
    );
  });

  it("Codex 只填域名时补 /v1，带路径时原样", () => {
    expect(codexBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1",
    );
    expect(codexBaseUrl("https://api.example.com/")).toBe(
      "https://api.example.com/v1",
    );
    expect(codexBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
    expect(codexBaseUrl("https://x.com/openai/v1")).toBe(
      "https://x.com/openai/v1",
    );
  });

  it("校验地址协议", () => {
    expect(isValidHttpUrl("https://a.com")).toBe(true);
    expect(isValidHttpUrl("a.com")).toBe(false);
    expect(isValidHttpUrl("ftp://a.com")).toBe(false);
  });

  it("用域名生成默认名称", () => {
    expect(defaultProviderName("https://api.example.com/v1")).toBe("example");
    expect(defaultProviderName("https://www.foo.cn")).toBe("foo");
    expect(defaultProviderName("not a url")).toBe("");
  });
});

describe("快速配置：生成供应商", () => {
  const input = {
    name: "Demo",
    baseUrl: "https://api.demo.com/v1",
    apiKey: " sk-test ",
  };

  it("Claude Code 写 env，Key 去掉空白", () => {
    const provider = buildSetupProvider("claude", {
      ...input,
      claudeModel: "claude-sonnet-4-5",
    });
    expect(provider.settingsConfig).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://api.demo.com",
        ANTHROPIC_AUTH_TOKEN: "sk-test",
        ANTHROPIC_MODEL: "claude-sonnet-4-5",
      },
    });
    expect(provider.category).toBe("custom");
  });

  it("Claude Code 没填模型时不写 ANTHROPIC_MODEL", () => {
    const provider = buildSetupProvider("claude", input);
    expect(provider.settingsConfig.env).not.toHaveProperty("ANTHROPIC_MODEL");
  });

  it("Codex 写 auth.json 和 config.toml", () => {
    const provider = buildSetupProvider("codex", {
      ...input,
      codexModel: "gpt-5-codex",
    });
    expect(provider.settingsConfig.auth).toEqual({ OPENAI_API_KEY: "sk-test" });
    const config = provider.settingsConfig.config as string;
    expect(config).toContain('base_url = "https://api.demo.com/v1"');
    expect(config).toContain('model = "gpt-5-codex"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain("requires_openai_auth = true");
  });
});

describe("快速配置：模型过滤", () => {
  const ids = ["claude-opus-4", "gpt-5-codex", "o3", "deepseek-chat"];

  it("按应用挑模型", () => {
    expect(filterModelsFor("claude", ids)).toEqual(["claude-opus-4"]);
    expect(filterModelsFor("codex", ids)).toEqual(["gpt-5-codex", "o3"]);
  });

  it("都对不上时返回全部", () => {
    expect(filterModelsFor("claude", ["deepseek-chat"])).toEqual([
      "deepseek-chat",
    ]);
  });
});
