import { providersApi, settingsApi, type AppId } from "@/lib/api";
import { devEnvironmentApi } from "@/lib/api/devEnvironment";
import { clearOnboardingSkipped, wasOnboardingSkipped } from "@/config/edition";

/**
 * 一键还原：给不再使用的客户撤销 ccshift 做过的事。
 * - 还原配置：Claude Code / Claude Desktop / Codex 切回客户原来的配置（ccshift 首次启动时
 *   备份成 "default" 的那份），没有就切回官方。
 * - 彻底清理：再卸载 Claude Code / Codex，并撤销运行环境改动（后端 cleanup_dev_environment）。
 * 供应商记录本身不删：客户以后想再用，切回来就行。
 */

const RESTORE_APPS: AppId[] = ["claude", "claude-desktop", "codex"];
const UNINSTALL_TOOLS = ["claude", "codex"] as const;

const OFFICIAL_ID: Partial<Record<AppId, string>> = {
  claude: "claude-official",
  "claude-desktop": "claude-desktop-official",
  codex: "codex-official",
};

/** 还原时切到哪一个：优先客户原来的配置，其次官方；没有可切的返回 null */
async function restoreTarget(app: AppId): Promise<string | null> {
  const providers = await providersApi.getAll(app);
  if (providers["default"]) return "default";
  const officialId = OFFICIAL_ID[app];
  if (!officialId) return null;
  if (!providers[officialId]) {
    if (app === "codex") await providersApi.ensureCodexOfficialProvider();
    else if (app === "claude-desktop")
      await providersApi.ensureClaudeDesktopOfficialProvider();
    else
      await providersApi.add(
        {
          id: officialId,
          name: "Claude Official",
          settingsConfig: { env: {} },
          category: "official",
        },
        app,
      );
  }
  return officialId;
}

export interface RestoreResult {
  /** 切换失败的应用和原因；其余应用照常还原 */
  failures: { step: string; message: string }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function restoreConfigs(): Promise<RestoreResult> {
  const failures: RestoreResult["failures"] = [];
  const desktop = await providersApi.getClaudeDesktopStatus().catch(() => null);
  for (const app of RESTORE_APPS) {
    // 没装、也没接入过 Claude Desktop 时不碰它
    if (app === "claude-desktop" && !desktop?.installed && !desktop?.configured)
      continue;
    try {
      const target = await restoreTarget(app);
      const current = await providersApi.getCurrent(app);
      if (target && target !== current) await providersApi.switch(target, app);
    } catch (error) {
      failures.push({ step: app, message: messageOf(error) });
    }
  }
  if (wasOnboardingSkipped()) {
    try {
      await settingsApi.clearClaudeOnboardingSkip();
      clearOnboardingSkipped();
    } catch (error) {
      failures.push({ step: "onboarding", message: messageOf(error) });
    }
  }
  await providersApi.updateTrayMenu().catch(() => undefined);
  return { failures };
}

/** 卸载 Claude Code / Codex 的每一处可自动卸载的安装，然后撤销运行环境改动 */
export async function cleanupEverything(): Promise<RestoreResult> {
  const { failures } = await restoreConfigs();
  // 先卸 CLI 再删 Node：npm 装的 CLI 要靠 npm 卸载
  for (const tool of UNINSTALL_TOOLS) {
    try {
      const candidates = await settingsApi.prepareToolUninstall(tool);
      for (const candidate of candidates) {
        if (!candidate.plan) continue;
        await settingsApi.runToolLifecycleAction(
          [tool],
          "uninstall",
          undefined,
          candidate.plan,
        );
      }
    } catch (error) {
      failures.push({ step: tool, message: messageOf(error) });
    }
  }
  try {
    await devEnvironmentApi.cleanup();
  } catch (error) {
    failures.push({ step: "environment", message: messageOf(error) });
  }
  return { failures };
}
