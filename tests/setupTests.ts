import "@testing-library/jest-dom";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { server } from "./msw/server";
import { resetProviderState } from "./msw/state";
import "./msw/tauriMocks";

// ccshift 只露出 Claude Code / Codex 和新手界面（src/config/edition.ts）。上游 CC Switch 的
// 用例按完整版写：这里把发行版开关切回完整版，让它们继续守着底下共用的代码；
// 精简版自己的行为由 tests/edition/*.test.tsx 用 vi.unmock 测真实配置。
vi.mock("@/config/edition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/edition")>();
  return {
    ...actual,
    // 与 components/apps/useToolManagement.ts 的 TOOL_NAMES 一致（那边依赖本模块，不能反过来导入）
    EDITION_TOOL_NAMES: [
      "claude",
      "codex",
      "gemini",
      "grok",
      "opencode",
      "openclaw",
      "hermes",
      "pi",
      "mcode",
      "kimi",
      "dsh",
      "agy",
      "omp",
    ],
    isEditionApp: () => true,
    isPageInSimpleMode: () => true,
    isAdvancedMode: () => true,
    useAdvancedMode: () => [true, () => undefined],
    isSetupDone: () => true,
  };
});

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "warn" });
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: { translation: {} },
      en: { translation: {} },
    },
    interpolation: {
      escapeValue: false,
    },
  });
});

afterEach(() => {
  cleanup();
  // 页面数据的本地缓存（src/lib/localCache.ts）和用量页记住的选择不能从一个用例带到下一个
  for (const key of Object.keys(localStorage)) {
    if (
      key.startsWith("cc-switch-cache:") ||
      key.startsWith("cc-switch.usage.")
    )
      localStorage.removeItem(key);
  }
  resetProviderState();
  server.resetHandlers();
  vi.clearAllMocks();
});

afterAll(() => {
  server.close();
});
