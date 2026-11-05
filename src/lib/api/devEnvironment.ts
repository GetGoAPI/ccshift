import { invoke } from "@tauri-apps/api/core";

/** 运行环境检测结果（后端 commands/ccshift_env.rs） */
export interface DevEnvironmentStatus {
  platform: "windows" | "macos" | "linux";
  nodeVersion: string | null;
  npmVersion: string | null;
  gitVersion: string | null;
  npmRegistry: string | null;
  /** Windows：PowerShell 当前生效的执行策略 */
  powershellPolicy: string | null;
  /** macOS / Linux：npm 全局目录能不能写；没装 npm 时为 null */
  npmGlobalWritable: boolean | null;
}

export type DevDependency = "node" | "git";

export type ClaudeDesktopAppStatus = "installed" | "legacy" | "missing";

/** 一键还原会撤销的环境改动（后端 preview_dev_cleanup） */
export interface DevCleanupPreview {
  /** ccshift 装的 Node.js 目录；没装过为 null */
  nodeDir: string | null;
  /** ccshift 装的 Git 目录（仅 Windows） */
  gitDir: string | null;
  npmRegistry: boolean;
  powershellPolicy: boolean;
  npmPrefix: boolean;
}

/** 最新版 Claude Code 的 package.json 要求 node >= 22 */
export const MIN_NODE_MAJOR = 22;

/** "v20.11.1" → 20；读不出来时为 null */
export function nodeMajor(version: string | null | undefined): number | null {
  const match = version?.trim().match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

export function isNodeOutdated(version: string | null | undefined): boolean {
  const major = nodeMajor(version);
  return major !== null && major < MIN_NODE_MAJOR;
}
export type DevEnvironmentIssue = "powershellPolicy" | "npmPrefix";

/** 国内 npm 镜像（npmmirror，原淘宝镜像） */
export const NPM_CHINA_MIRROR = "https://registry.npmmirror.com";
export const NPM_OFFICIAL_REGISTRY = "https://registry.npmjs.org";

export const devEnvironmentApi = {
  check(): Promise<DevEnvironmentStatus> {
    return invoke("check_dev_environment");
  },
  install(name: DevDependency): Promise<void> {
    return invoke("install_dev_dependency", { name });
  },
  fix(issue: DevEnvironmentIssue): Promise<void> {
    return invoke("fix_dev_environment", { issue });
  },
  /** 从官方渠道安装 Claude Desktop（Windows 装官方 MSIX，macOS 读官方更新源），装完会打开它 */
  /**
   * 桌面版程序本身的安装状态（不看配置 / 数据目录，卸载后能如实显示没装）。
   * legacy：Windows 旧安装器版，用不了 Cowork，需要重装成 MSIX。
   */
  claudeDesktopAppStatus(): Promise<ClaudeDesktopAppStatus> {
    return invoke("claude_desktop_app_status");
  },
  installClaudeDesktop(): Promise<void> {
    return invoke("install_claude_desktop");
  },
  setNpmRegistry(registry: string): Promise<void> {
    return invoke("set_npm_registry", { registry });
  },
  previewCleanup(): Promise<DevCleanupPreview> {
    return invoke("preview_dev_cleanup");
  },
  cleanup(): Promise<void> {
    return invoke("cleanup_dev_environment");
  },
};

export function isChinaMirror(registry: string | null | undefined): boolean {
  return Boolean(registry && registry.includes("npmmirror.com"));
}

/** 这两种策略下 npm 生成的 `claude.ps1` / `codex.ps1` 在 PowerShell 里跑不起来 */
export function isPowershellPolicyBlocking(
  policy: string | null | undefined,
): boolean {
  const value = policy?.trim().toLowerCase();
  return value === "restricted" || value === "allsigned";
}

const CHINA_TIME_ZONES = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Chungking",
  "Asia/Harbin",
  "Asia/Urumqi",
  "Asia/Kashgar",
  "PRC",
]);

/**
 * 粗略判断是不是在国内网络：系统时区是中国大陆时区。用来决定装 CLI 前要不要自动
 * 切 npm 国内镜像；判断错了也只是下载源不同，客户随时能在向导里切回官方源。
 */
export function isLikelyChinaNetwork(): boolean {
  try {
    return CHINA_TIME_ZONES.has(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  } catch {
    return false;
  }
}
