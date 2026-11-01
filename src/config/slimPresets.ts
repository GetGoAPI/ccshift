import type { ProviderCategory } from "@/types";
import { providerPresets } from "./claudeProviderPresets";
import { codexProviderPresets } from "./codexProviderPresets";

/**
 * ccshift 精简版的供应商预设：启动时就地改写上游的预设表，不动预设文件本身
 * （几千行数据，改了以后很难合并上游）。上游的单测不经过这里，照旧测完整数据。
 *
 * - 隐藏聚合站和第三方中转站：对卖 API 的商家来说这些都是竞品广告。
 *   客户接任何第三方仍然可以走「快速配置」或「自定义」。
 * - 去掉「合作伙伴」标记和推广语。
 * - 官网 / 获取 Key 链接里的返利、追踪参数（aff、ref、track_id、utm_*…）全部去掉。
 */

const HIDDEN_CATEGORIES: ReadonlySet<ProviderCategory | undefined> = new Set([
  "aggregator",
  "third_party",
]);

const TRACKING_PARAM =
  /^(aff|ref|refer|referral|referrer|invite|invitecode|invite_code|inviter|code|channel|source|from|track_id|trackid|utm_.*|aff_id|affid|promo|promocode|share)$/i;

/** 去掉链接里的返利 / 追踪参数；不是合法网址就原样返回 */
export function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
    }
    // 返利码有时直接写在路径里：/register?aff=x 处理过了，/aff/xxx、/r/xxx 这类收拢成首页
    if (/^\/(aff|ref|r|invite|i)\/[^/]+\/?$/i.test(parsed.pathname)) {
      parsed.pathname = "/";
    }
    const cleaned = parsed.toString();
    // URL 会给裸域名补一个结尾的 /，原地址没有就去掉，免得无意义的改动
    return !url.endsWith("/") &&
      cleaned.endsWith("/") &&
      parsed.pathname === "/" &&
      !parsed.search
      ? cleaned.slice(0, -1)
      : cleaned;
  } catch {
    return url;
  }
}

interface SlimmablePreset {
  category?: ProviderCategory;
  hidden?: boolean;
  isPartner?: boolean;
  primePartner?: boolean;
  partnerPromotionKey?: string;
  websiteUrl?: string;
  apiKeyUrl?: string;
}

export function slimPreset(preset: SlimmablePreset) {
  if (HIDDEN_CATEGORIES.has(preset.category)) preset.hidden = true;
  delete preset.isPartner;
  delete preset.primePartner;
  delete preset.partnerPromotionKey;
  if (preset.websiteUrl)
    preset.websiteUrl = stripTrackingParams(preset.websiteUrl);
  if (preset.apiKeyUrl)
    preset.apiKeyUrl = stripTrackingParams(preset.apiKeyUrl);
}

let applied = false;

/** 在 main.tsx 里、渲染之前调用一次 */
export function applySlimPresets() {
  if (applied) return;
  applied = true;
  for (const preset of [...providerPresets, ...codexProviderPresets]) {
    slimPreset(preset);
  }
}
