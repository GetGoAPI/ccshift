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
  setNpmRegistry(registry: string): Promise<void> {
    return invoke("set_npm_registry", { registry });
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
