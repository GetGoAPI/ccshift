import { afterEach, describe, expect, it, vi } from "vitest";

// setupTests.ts 把发行版开关切成了完整版；这里测 ccshift 真实的配置
vi.unmock("@/config/edition");

const { DEFAULT_VISIBLE_APPS, orderAppIds } = await import(
  "@/config/appConfig"
);
const edition = await import("@/config/edition");

describe("ccshift 发行版配置", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("只默认显示 Claude Code、Claude Desktop 和 Codex", () => {
    const visible = Object.entries(DEFAULT_VISIBLE_APPS)
      .filter(([, on]) => on)
      .map(([app]) => app);
    expect(visible).toEqual(["claude", "claude-desktop", "codex"]);
  });

  it("应用顺序里过滤掉其他应用，保留用户拖出来的顺序", () => {
    expect(orderAppIds(undefined)).toEqual([
      "claude",
      "claude-desktop",
      "codex",
    ]);
    // 没拖过的 Claude Desktop 插回默认位置：紧跟在 Claude Code 后面
    expect(orderAppIds(["gemini", "codex", "claude"])).toEqual([
      "codex",
      "claude",
      "claude-desktop",
    ]);
  });

  it("新手模式只留快速配置和应用页", () => {
    expect(edition.isPageInSimpleMode("setup")).toBe(true);
    expect(edition.isPageInSimpleMode("apps")).toBe(true);
    for (const page of ["mcp", "skills", "prompts", "sessions", "usage"]) {
      expect(edition.isPageInSimpleMode(page)).toBe(false);
    }
  });

  it("高级模式和向导完成标记存在本机", () => {
    expect(edition.isAdvancedMode()).toBe(false);
    edition.setAdvancedMode(true);
    expect(edition.isAdvancedMode()).toBe(true);
    edition.setAdvancedMode(false);
    expect(edition.isAdvancedMode()).toBe(false);

    expect(edition.isSetupDone()).toBe(false);
    edition.markSetupDone();
    expect(edition.isSetupDone()).toBe(true);
  });

  it("没配自己的更新源前不查更新", () => {
    expect(edition.UPDATE_CHECK_ENABLED).toBe(false);
  });
});
