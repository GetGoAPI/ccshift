import { useSyncExternalStore } from "react";
import type { AppId } from "@/lib/api/types";

/**
 * ccshift 发行版配置：品牌、支持的应用、新手 / 高级模式。
 *
 * 基于 cc-switch 改造，面向小白用户：只管 Claude Code 和 Codex，
 * 默认只露出「快速配置」「供应商」「安装工具」「设置」，其余功能收进高级模式。
 * 改品牌、增减应用只改这一个文件，便于以后合并 cc-switch 上游。
 */

/** 产品名：侧栏、关于页、版本号等处显示 */
export const BRAND_NAME = "ccshift";

/** 本发行版管理的应用（侧栏、应用页、托盘只显示这些） */
export const EDITION_APPS: readonly AppId[] = [
  "claude",
  "claude-desktop",
  "codex",
];

/** 本发行版检测 / 安装的命令行工具 */
export const EDITION_TOOL_NAMES = ["claude", "codex"] as const;

export function isEditionApp(app: string): boolean {
  return (EDITION_APPS as readonly string[]).includes(app);
}

/**
 * 是否检查应用更新。更新源是本仓库 GitHub Releases 里的 latest.json
 * （tauri.conf.json 的 plugins.updater），由 release.yml 用 ccshift 自己的密钥签名生成。
 * 签名私钥丢了就再也发不了能自动安装的更新，务必备份。
 */
export const UPDATE_CHECK_ENABLED = true;

// ─── 高级模式 ───────────────────────────────────────────────────────────────
// 存在本机 localStorage：只影响界面露出哪些入口，不改任何配置文件。

const ADVANCED_MODE_KEY = "ccshift-advanced-mode";
const SETUP_DONE_KEY = "ccshift-setup-done";
const ONBOARDING_SKIPPED_KEY = "ccshift-onboarding-skipped";
const listeners = new Set<() => void>();

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // 存不了就只在本次会话生效
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isAdvancedMode(): boolean {
  return readFlag(ADVANCED_MODE_KEY);
}

export function setAdvancedMode(value: boolean) {
  writeFlag(ADVANCED_MODE_KEY, value);
}

/** 高级模式开关：打开后显示 MCP、Skills、提示词、会话、用量、路由等原版功能 */
export function useAdvancedMode(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, isAdvancedMode, () => false);
  return [value, setAdvancedMode];
}

/**
 * 新手模式下还能进的全局页。侧栏的「快速配置」「应用」「设置」单独放，
 * 这里列的是侧栏中段那一组（MCP、Skills、提示词、会话、授权、用量）里保留的。
 */
const SIMPLE_MODE_PAGES: readonly string[] = ["setup", "guide", "apps"];

export function isPageInSimpleMode(page: string): boolean {
  return SIMPLE_MODE_PAGES.includes(page);
}

/** 是否走完过快速配置向导；没走过的话启动时直接打开向导 */
export function isSetupDone(): boolean {
  return readFlag(SETUP_DONE_KEY);
}

export function markSetupDone() {
  writeFlag(SETUP_DONE_KEY, true);
}

/**
 * 快速配置替客户跳过了 Claude Code 的首次登录引导（~/.claude.json 的 hasCompletedOnboarding）。
 * 一键还原时只撤销 ccshift 自己写的，客户原本就走完引导的不动。
 */
export function markOnboardingSkipped() {
  writeFlag(ONBOARDING_SKIPPED_KEY, true);
}

export function wasOnboardingSkipped(): boolean {
  return readFlag(ONBOARDING_SKIPPED_KEY);
}

export function clearOnboardingSkipped() {
  writeFlag(ONBOARDING_SKIPPED_KEY, false);
}

/**
 * 关于页「官网」按钮打开的地址（你的店铺 / 官网 / 教程页）；留空则不显示。
 * 托盘菜单的同名按钮在 src-tauri/src/edition.rs 里，两处一起改。
 */
export const WEBSITE_URL = "";

/** 下载新版本的页面（数据库版本过高时引导客户去下载）；留空则不显示该按钮 */
export const DOWNLOAD_URL = "";
