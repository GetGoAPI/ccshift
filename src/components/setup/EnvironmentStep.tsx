import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { providersApi, settingsApi } from "@/lib/api";
import { checkEnvConflicts, deleteEnvVars } from "@/lib/api/env";
import type { EnvConflict } from "@/types/env";
import {
  devEnvironmentApi,
  isChinaMirror,
  isNodeOutdated,
  MIN_NODE_MAJOR,
  isLikelyChinaNetwork,
  isPowershellPolicyBlocking,
  NPM_CHINA_MIRROR,
  NPM_OFFICIAL_REGISTRY,
  type DevDependency,
  type DevEnvironmentStatus,
} from "@/lib/api/devEnvironment";
import { useToolManagement } from "@/components/apps/useToolManagement";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { Button } from "@/components/ui/button";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import { StepCard } from "./StepCard";

/** 要装的命令行工具（Claude Desktop 是客户自己装的桌面应用，不在这里装） */
const CLI_APPS = ["claude", "codex"] as const;
type CliApp = (typeof CLI_APPS)[number];

const NODE_DOWNLOAD_URL = "https://nodejs.org/zh-cn/download";
const CLAUDE_DESKTOP_DOWNLOAD_URL = "https://claude.ai/download";
const GIT_DOWNLOAD_URL = "https://git-scm.com/downloads";

const DEPENDENCY_LABEL: Record<DevDependency, string> = {
  node: "Node.js",
  git: "Git",
};

type EnvTask =
  | "powershell"
  | "node"
  | "git"
  | "registry"
  | "npmPrefix"
  | "conflicts"
  | "tools"
  | "desktop";

function StatusIcon({ ok, busy }: { ok: boolean | null; busy?: boolean }) {
  if (busy) return <Loader2 className="h-4 w-4 animate-spin text-fg-3" />;
  if (ok === null) return <Circle className="h-4 w-4 text-fg-3" />;
  return ok ? (
    <CheckCircle2 className="h-4 w-4 text-success" />
  ) : (
    <XCircle className="h-4 w-4 text-danger" />
  );
}

function EnvRow({
  icon,
  name,
  hint,
  value,
  ok,
  busy,
  action,
}: {
  icon?: ReactNode;
  name: string;
  hint?: string;
  value?: string | null;
  ok: boolean | null;
  busy?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <StatusIcon ok={ok} busy={busy} />
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-strong text-fg-1">{name}</div>
        {hint && <div className="text-caption text-fg-3">{hint}</div>}
      </div>
      {value && (
        <span className="max-w-[220px] truncate font-mono text-caption text-fg-2">
          {value}
        </span>
      )}
      {action}
    </div>
  );
}

/**
 * 快速配置第一步：检查并安装运行环境。
 * Node.js、Git 从国内镜像下载到用户目录（后端 commands/ccshift_env.rs），不需要管理员；
 * 「一键全部安装」按依赖顺序把缺的全部装好，客户只点一次。
 */
export function EnvironmentStep() {
  const { t } = useTranslation();
  const tools = useToolManagement();
  const [env, setEnv] = useState<DevEnvironmentStatus | null>(null);
  const [checking, setChecking] = useState(false);
  // 同一时间只跑一件事：npm 设置、PATH、执行策略互相有依赖，并发容易互相踩
  const [task, setTask] = useState<EnvTask | null>(null);
  const [installingAll, setInstallingAll] = useState(false);
  // 自动安装失败过的依赖，按钮改成「去官网下载」
  const [failed, setFailed] = useState<Partial<Record<DevDependency, true>>>(
    {},
  );
  // 系统环境变量 / shell 启动文件里的 ANTHROPIC_* / OPENAI_*：会盖掉或干扰写入的 Key
  const [conflicts, setConflicts] = useState<EnvConflict[]>([]);
  // Claude Desktop 是可选项：不进「一键全部安装」（安装包几百 MB，不是每个客户都用）
  const queryClient = useQueryClient();
  // 看程序本身在不在：getClaudeDesktopStatus().installed 把「接入过」也算作已装，
  // 卸载后配置还在时会一直显示已安装
  const { data: desktopApp, refetch: refetchDesktop } = useQuery({
    queryKey: ["claudeDesktopAppStatus"],
    queryFn: () => devEnvironmentApi.claudeDesktopAppStatus(),
  });
  const desktopInstalled = desktopApp === "installed";
  const [desktopFailed, setDesktopFailed] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const [next, found] = await Promise.all([
        devEnvironmentApi.check(),
        Promise.all(CLI_APPS.map((app) => checkEnvConflicts(app)))
          .then((lists) => lists.flat())
          .catch(() => [] as EnvConflict[]),
      ]);
      setEnv(next);
      setConflicts(found);
      return next;
    } catch (error) {
      console.error("[QuickSetup] environment check failed", error);
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recheckAll = async () => {
    await Promise.all([refresh(), tools.checkForUpdates(), refetchDesktop()]);
  };

  /** 跑一个环境操作：失败时弹提示并返回 false，不往外抛 */
  const runTask = async (
    current: EnvTask,
    action: () => Promise<void>,
    errorTitle: string,
    successTitle?: string,
  ): Promise<boolean> => {
    setTask(current);
    try {
      await action();
      if (successTitle) toast.success(successTitle);
      return true;
    } catch (error) {
      toast.error(errorTitle, {
        description: extractErrorMessage(error) || undefined,
        closeButton: true,
      });
      return false;
    } finally {
      setTask(null);
    }
  };

  const installDependency = async (name: DevDependency) => {
    if (failed[name]) {
      await settingsApi.openExternal(
        name === "node" ? NODE_DOWNLOAD_URL : GIT_DOWNLOAD_URL,
      );
      return false;
    }
    const label = DEPENDENCY_LABEL[name];
    const ok = await runTask(
      name,
      () => devEnvironmentApi.install(name),
      t("setup.env.installFailed", { name: label }),
      t("setup.env.installed", { name: label }),
    );
    if (!ok) setFailed((prev) => ({ ...prev, [name]: true }));
    return ok;
  };

  /**
   * 装 Claude Desktop：失败一次后按钮改成「去官网下载」。装完它会被打开，
   * 数据目录要等它启动后才建，所以轮询几次状态，第 3 步的勾选也跟着更新。
   */
  const installDesktop = async () => {
    if (desktopFailed) {
      await settingsApi.openExternal(CLAUDE_DESKTOP_DOWNLOAD_URL);
      return;
    }
    const ok = await runTask(
      "desktop",
      () => devEnvironmentApi.installClaudeDesktop(),
      t("setup.env.desktopFailed"),
      t("setup.env.desktopDone"),
    );
    if (!ok) {
      setDesktopFailed(true);
      return;
    }
    await refetchDesktop();
    // 第 3 步的「Claude 桌面版」勾选看 claudeDesktopStatus：数据目录等它启动后才建
    for (let i = 0; i < 10; i++) {
      const status = await queryClient.fetchQuery({
        queryKey: ["claudeDesktopStatus"],
        queryFn: () => providersApi.getClaudeDesktopStatus(),
        staleTime: 0,
      });
      if (status.installed) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };

  const fixPowershell = () =>
    runTask(
      "powershell",
      () => devEnvironmentApi.fix("powershellPolicy"),
      t("setup.env.fixFailed"),
    );

  const clearConflicts = async () => {
    await runTask(
      "conflicts",
      async () => {
        const backup = await deleteEnvVars(conflicts);
        toast.success(t("setup.env.conflictsCleared"), {
          description: t("setup.env.conflictsBackup", {
            path: backup.backupPath,
          }),
          closeButton: true,
        });
      },
      t("setup.env.conflictsFailed"),
    );
    await refresh();
  };

  const fixNpmPrefix = () =>
    runTask(
      "npmPrefix",
      () => devEnvironmentApi.fix("npmPrefix"),
      t("setup.env.fixFailed"),
    );

  const setRegistry = (target: string, successTitle: string) =>
    runTask(
      "registry",
      () => devEnvironmentApi.setNpmRegistry(target),
      t("setup.env.registryFailed"),
      successTitle,
    );

  const toggleRegistry = async () => {
    await setRegistry(
      isChinaMirror(env?.npmRegistry)
        ? NPM_OFFICIAL_REGISTRY
        : NPM_CHINA_MIRROR,
      t("setup.env.registrySwitched"),
    );
    await refresh();
  };

  /**
   * 装 CLI 之前把 npm 准备好：国内网络自动切镜像；npm 全局目录不可写（macOS 用官网 pkg
   * 装的 Node）时改到用户目录。客户不用知道这些步骤的先后。
   */
  const prepareNpm = async (current: DevEnvironmentStatus | null) => {
    if (!current?.npmVersion) return;
    if (isLikelyChinaNetwork() && !isChinaMirror(current.npmRegistry)) {
      await setRegistry(NPM_CHINA_MIRROR, t("setup.env.mirrorAuto"));
    }
    if (current.npmGlobalWritable === false) {
      await fixNpmPrefix();
    }
  };

  const runToolInstall = async (apps: CliApp[]) => {
    if (apps.length === 0) return;
    setTask("tools");
    try {
      await tools.handleRunToolAction(apps, "install");
    } finally {
      setTask(null);
    }
  };

  const installTools = async (apps: CliApp[]) => {
    await prepareNpm(env);
    await runToolInstall(apps);
    await refresh();
  };

  /**
   * 一键全部安装：执行策略 → Node.js（没装或低于 22 时装 / 升级）→ Git → npm 镜像 / 权限
   * → Claude Code、Codex。环境变量冲突要删客户自己设的东西，不自动做，单独一行让客户点。
   */
  const installAll = async () => {
    setInstallingAll(true);
    try {
      let current = await refresh();
      if (!current) return;
      if (
        current.platform === "windows" &&
        isPowershellPolicyBlocking(current.powershellPolicy)
      ) {
        await fixPowershell();
      }
      if (
        !current.nodeVersion ||
        !current.npmVersion ||
        isNodeOutdated(current.nodeVersion)
      ) {
        await installDependency("node");
        current = (await refresh()) ?? current;
        if (!current.nodeVersion || isNodeOutdated(current.nodeVersion)) {
          toast.error(t("setup.env.installAllStopped"), { closeButton: true });
          return;
        }
      }
      if (current.platform === "windows" && !current.gitVersion) {
        await installDependency("git");
      }
      await prepareNpm(current);
      // 读最新的安装状态：hook 里的版本信息在这次异步流程里是旧的
      const versions = await settingsApi.getToolVersions([...CLI_APPS]);
      await runToolInstall(
        CLI_APPS.filter(
          (app) => !versions.find((v) => v.name === app)?.version,
        ),
      );
      await recheckAll();
      toast.success(t("setup.env.installAllDone"));
    } finally {
      setInstallingAll(false);
      setTask(null);
    }
  };

  const isWindows = env?.platform === "windows";
  const hasNode = env ? Boolean(env.nodeVersion && env.npmVersion) : null;
  const nodeOutdated = hasNode === true && isNodeOutdated(env?.nodeVersion);
  const nodeOk = hasNode === null ? null : hasNode && !nodeOutdated;
  const hasGit = env ? Boolean(env.gitVersion) : null;
  const policyBlocking = isPowershellPolicyBlocking(env?.powershellPolicy);
  const busy = installingAll || task !== null;
  const allReady =
    nodeOk === true &&
    (!isWindows || (hasGit === true && !policyBlocking)) &&
    env?.npmGlobalWritable !== false &&
    CLI_APPS.every((app) => Boolean(tools.toolVersionByName.get(app)?.version));

  const spinner = (active: boolean) =>
    active && <Loader2 className="h-3.5 w-3.5 animate-spin" />;

  const dependencyButton = (name: DevDependency) => (
    <Button
      size="compact"
      variant="neutral"
      disabled={busy}
      onClick={() => void installDependency(name).then(() => refresh())}
    >
      {spinner(task === name)}
      {task === name
        ? t("setup.env.installing")
        : failed[name]
          ? t("setup.env.download")
          : name === "node" && nodeOutdated
            ? t("setup.env.upgrade")
            : t("setup.env.install")}
    </Button>
  );

  const fixButton = (current: EnvTask, onClick: () => Promise<boolean>) => (
    <Button
      size="compact"
      variant="neutral"
      disabled={busy}
      onClick={() => void onClick().then(() => refresh())}
    >
      {spinner(task === current)}
      {t("setup.env.fix")}
    </Button>
  );

  return (
    <StepCard
      index={1}
      title={t("setup.env.title")}
      description={t("setup.env.description")}
      actions={
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="compact"
            variant="quiet"
            disabled={checking || busy}
            onClick={() => void recheckAll()}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", checking && "animate-spin")}
            />
            {t("setup.env.recheck")}
          </Button>
          {env && !allReady && (
            <Button
              size="compact"
              variant="solid"
              disabled={busy}
              onClick={() => void installAll()}
            >
              {spinner(installingAll)}
              {installingAll && task
                ? t(`setup.env.task.${task}`)
                : t("setup.env.installAll")}
            </Button>
          )}
        </div>
      }
    >
      {isWindows && (
        <EnvRow
          name={t("setup.env.powershell")}
          hint={t("setup.env.powershellHint")}
          value={env?.powershellPolicy}
          ok={env?.powershellPolicy ? !policyBlocking : null}
          busy={task === "powershell"}
          action={policyBlocking && fixButton("powershell", fixPowershell)}
        />
      )}
      <EnvRow
        name="Node.js"
        hint={
          nodeOutdated
            ? t("setup.env.nodeOutdated", { min: MIN_NODE_MAJOR })
            : t("setup.env.nodeHint")
        }
        value={env?.nodeVersion}
        ok={nodeOk}
        busy={(checking && !env) || task === "node"}
        action={nodeOk === false && dependencyButton("node")}
      />
      {isWindows && (
        <EnvRow
          name="Git"
          hint={t("setup.env.gitHint")}
          value={env?.gitVersion?.replace(/^git version /, "")}
          ok={hasGit}
          busy={task === "git"}
          action={hasGit === false && dependencyButton("git")}
        />
      )}
      {hasNode && (
        <EnvRow
          name={t("setup.env.registry")}
          hint={t("setup.env.registryHint")}
          value={env?.npmRegistry}
          ok={true}
          busy={task === "registry"}
          action={
            <Button
              size="compact"
              variant="neutral"
              disabled={busy}
              onClick={() => void toggleRegistry()}
            >
              {isChinaMirror(env?.npmRegistry)
                ? t("setup.env.useOfficial")
                : t("setup.env.useMirror")}
            </Button>
          }
        />
      )}
      {hasNode && env?.npmGlobalWritable != null && (
        <EnvRow
          name={t("setup.env.npmPrefix")}
          hint={t("setup.env.npmPrefixHint")}
          ok={env.npmGlobalWritable}
          busy={task === "npmPrefix"}
          action={
            !env.npmGlobalWritable && fixButton("npmPrefix", fixNpmPrefix)
          }
        />
      )}
      {conflicts.length > 0 && (
        <EnvRow
          name={t("setup.env.conflicts")}
          hint={t("setup.env.conflictsHint", {
            names: [...new Set(conflicts.map((c) => c.varName))].join("、"),
          })}
          ok={false}
          busy={task === "conflicts"}
          action={
            <Button
              size="compact"
              variant="neutral"
              disabled={busy}
              onClick={() => void clearConflicts()}
            >
              {t("setup.env.conflictsClear")}
            </Button>
          }
        />
      )}
      {CLI_APPS.map((app) => {
        const info = tools.toolVersionByName.get(app);
        const toolBusy = tools.busyTools.has(app);
        const loading =
          Boolean(tools.loadingTools[app]) || (!info && tools.isLoadingTools);
        const installed = info ? Boolean(info.version) : null;
        // Codex 一律靠 npm 安装，Claude Code 在 Windows 上也是；没有 Node 时先装 Node
        const blocked = (app === "codex" || isWindows) && hasNode === false;
        return (
          <EnvRow
            key={app}
            icon={<AppGlyph app={app} size={18} />}
            name={APP_DISPLAY_NAME[app]}
            hint={
              blocked && !installed ? t("setup.env.needNodeFirst") : undefined
            }
            value={info?.version}
            ok={loading ? null : installed}
            busy={toolBusy || loading}
            action={
              !loading &&
              !installed && (
                <Button
                  size="compact"
                  variant="neutral"
                  disabled={toolBusy || blocked || busy}
                  onClick={() => void installTools([app])}
                >
                  {spinner(toolBusy)}
                  {toolBusy
                    ? t("setup.env.installing")
                    : t("setup.env.install")}
                </Button>
              )
            }
          />
        );
      })}
      {(isWindows || env?.platform === "macos") && desktopApp !== undefined && (
        <EnvRow
          icon={<AppGlyph app="claude-desktop" size={18} />}
          name={t("setup.env.desktop")}
          hint={
            task === "desktop"
              ? t("setup.env.desktopInstallingHint")
              : desktopInstalled
                ? undefined
                : desktopFailed
                  ? t("setup.env.desktopFailedHint")
                  : desktopApp === "legacy"
                    ? t("setup.env.desktopLegacyHint")
                    : t("setup.env.desktopHint")
          }
          value={desktopInstalled ? t("setup.env.desktopInstalled") : null}
          // 可选项：没装 / 旧版都只显示空心圈，不标红叉——旧版照样能用，只是提示更新
          ok={desktopInstalled ? true : null}
          busy={task === "desktop"}
          action={
            !desktopInstalled && (
              <Button
                size="compact"
                variant="neutral"
                disabled={busy}
                onClick={() => void installDesktop()}
              >
                {spinner(task === "desktop")}
                {task === "desktop"
                  ? t("setup.env.installing")
                  : desktopFailed
                    ? t("setup.env.download")
                    : desktopApp === "legacy"
                      ? t("setup.env.reinstall")
                      : t("setup.env.install")}
              </Button>
            )
          }
        />
      )}
    </StepCard>
  );
}
