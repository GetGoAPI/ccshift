import { beforeAll, describe, expect, it } from "vitest";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { applySlimPresets, stripTrackingParams } from "@/config/slimPresets";

const TRACKING =
  /[?&](aff|ref|track_id|invite|inviteCode|utm_[a-z]+|channel)=/i;

describe("精简版预设", () => {
  beforeAll(() => {
    applySlimPresets();
  });

  it("聚合站和第三方中转站都隐藏了", () => {
    for (const preset of [...providerPresets, ...codexProviderPresets]) {
      if (
        preset.category === "aggregator" ||
        preset.category === "third_party"
      ) {
        expect(preset.hidden, preset.name).toBe(true);
      }
    }
  });

  it("没有合作伙伴标记和推广语", () => {
    for (const preset of [...providerPresets, ...codexProviderPresets]) {
      expect(preset.isPartner, preset.name).toBeUndefined();
      expect(preset.partnerPromotionKey, preset.name).toBeUndefined();
    }
  });

  it("可见预设的链接里没有返利参数", () => {
    for (const preset of [...providerPresets, ...codexProviderPresets]) {
      if (preset.hidden) continue;
      for (const url of [preset.websiteUrl, preset.apiKeyUrl]) {
        if (url) expect(url, preset.name).not.toMatch(TRACKING);
      }
    }
  });

  it("仍保留官方和模型厂商自家预设", () => {
    const visible = providerPresets.filter((p) => !p.hidden);
    expect(visible.some((p) => p.category === "official")).toBe(true);
    expect(visible.some((p) => p.category === "cn_official")).toBe(true);
  });
});

describe("去掉追踪参数", () => {
  it("删返利参数、保留其他参数", () => {
    expect(
      stripTrackingParams(
        "https://platform.kimi.com?track_id=abc&aff=cc-switch",
      ),
    ).toBe("https://platform.kimi.com");
    expect(stripTrackingParams("https://a.com/keys?tab=1&ref=x")).toBe(
      "https://a.com/keys?tab=1",
    );
    expect(stripTrackingParams("https://a.com/register?aff=xyz")).toBe(
      "https://a.com/register",
    );
    expect(stripTrackingParams("https://a.com/docs")).toBe(
      "https://a.com/docs",
    );
    expect(stripTrackingParams("not a url")).toBe("not a url");
  });
});
