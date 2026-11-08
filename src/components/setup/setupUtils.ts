import type { Provider } from "@/types";
import { generateThirdPartyConfig } from "@/config/codexProviderPresets";

/**
 * 快速配置向导的纯函数：地址规整、按应用生成供应商配置。
 * 和「添加供应商」里自定义供应商写出来的结构一致，之后在供应商页照常编辑。
 */

export type SetupApp = "claude" | "claude-desktop" | "codex";

export interface SetupInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  claudeModel?: string;
  codexModel?: string;
}

function stripUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Claude Code 自己拼 `/v1/messages`：地址末尾带了 `/v1` 要去掉，
 * 否则会请求成 `/v1/v1/messages`。中转商给的地址很多都带 `/v1`。
 */
export function claudeBaseUrl(raw: string): string {
  return stripUrl(raw).replace(/\/v1$/i, "");
}

/**
 * Codex 直接在 base_url 后面拼 `/responses`：只填了域名时补上 `/v1`；
 * 已经带了路径（`/v1`、`/openai/v1` 等）就原样用。
 */
export function codexBaseUrl(raw: string): string {
  const trimmed = stripUrl(raw);
  try {
    const url = new URL(trimmed);
    if (url.pathname === "" || url.pathname === "/") {
      return `${trimmed}/v1`;
    }
  } catch {
    // 地址不合法时原样返回，由表单校验提示
  }
  return trimmed;
}

/** 没填名称时用域名当名称：api.example.com → example */
export function defaultProviderName(raw: string): string {
  try {
    const host = new URL(raw.trim()).hostname;
    const parts = host
      .split(".")
      .filter((p) => p && p !== "www" && p !== "api");
    return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || host;
  } catch {
    return "";
  }
}

export function buildSetupProvider(
  app: SetupApp,
  input: SetupInput,
): Omit<Provider, "id"> {
  const apiKey = input.apiKey.trim();
  if (app === "claude") {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: claudeBaseUrl(input.baseUrl),
      ANTHROPIC_AUTH_TOKEN: apiKey,
    };
    const model = input.claudeModel?.trim();
    if (model) env.ANTHROPIC_MODEL = model;
    return {
      name: input.name,
      settingsConfig: { env },
      category: "custom",
      createdAt: Date.now(),
    };
  }

  if (app === "claude-desktop") {
    // 直连，只支持 Anthropic 格式接口（和 Claude Code 同一个地址）。
    // 不写模型菜单：没有菜单时 Desktop 每次启动向上游 /v1/models 查，菜单就是上游
    // 列出的 Claude 模型。上游上了新模型客户直接能选，不用等 ccshift 更新。
    return {
      name: input.name,
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: claudeBaseUrl(input.baseUrl),
          ANTHROPIC_AUTH_TOKEN: apiKey,
        },
      },
      category: "custom",
      createdAt: Date.now(),
      meta: {
        claudeDesktopMode: "direct",
        apiFormat: "anthropic",
      },
    };
  }

  const model = input.codexModel?.trim();
  return {
    name: input.name,
    settingsConfig: {
      auth: { OPENAI_API_KEY: apiKey },
      config: model
        ? generateThirdPartyConfig(
            input.name,
            codexBaseUrl(input.baseUrl),
            model,
          )
        : generateThirdPartyConfig(input.name, codexBaseUrl(input.baseUrl)),
    },
    category: "custom",
    createdAt: Date.now(),
  };
}

/** 模型列表里挑适合各应用的：Claude 用 claude-*，Codex 用 gpt-* / codex / o 系列 */
export function filterModelsFor(app: SetupApp, ids: string[]): string[] {
  const lower = (id: string) => id.toLowerCase();
  const matched =
    app !== "codex"
      ? ids.filter((id) => lower(id).includes("claude"))
      : ids.filter((id) => /gpt|codex|^o\d/.test(lower(id)));
  return matched.length > 0 ? matched : ids;
}
