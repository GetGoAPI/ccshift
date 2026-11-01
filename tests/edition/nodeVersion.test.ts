import { describe, expect, it } from "vitest";
import {
  isNodeOutdated,
  MIN_NODE_MAJOR,
  nodeMajor,
} from "@/lib/api/devEnvironment";
import { buildSetupProvider } from "@/components/setup/setupUtils";

describe("Node.js 版本判断", () => {
  it("读出主版本号", () => {
    expect(nodeMajor("v20.11.1")).toBe(20);
    expect(nodeMajor("22.0.0")).toBe(22);
    expect(nodeMajor(null)).toBeNull();
    expect(nodeMajor("garbage")).toBeNull();
  });

  it(`低于 ${MIN_NODE_MAJOR} 算过旧，读不出版本不算`, () => {
    expect(isNodeOutdated("v18.20.0")).toBe(true);
    expect(isNodeOutdated("v20.11.1")).toBe(true);
    expect(isNodeOutdated("v22.0.0")).toBe(false);
    expect(isNodeOutdated("v26.13.0")).toBe(false);
    expect(isNodeOutdated(null)).toBe(false);
  });
});

describe("Claude Desktop 供应商", () => {
  it("直连 Anthropic 格式，模型菜单原名透传", () => {
    const provider = buildSetupProvider("claude-desktop", {
      name: "Demo",
      baseUrl: "https://api.demo.com/v1/",
      apiKey: " sk-x ",
    });
    expect(provider.settingsConfig).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://api.demo.com",
        ANTHROPIC_AUTH_TOKEN: "sk-x",
      },
    });
    expect(provider.meta?.claudeDesktopMode).toBe("direct");
    expect(provider.meta?.apiFormat).toBe("anthropic");
    const routes = provider.meta?.claudeDesktopModelRoutes ?? {};
    expect(Object.keys(routes).length).toBe(3);
    for (const [route, value] of Object.entries(routes)) {
      expect(value.model).toBe(route);
    }
  });
});
