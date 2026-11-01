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
import { settingsApi } from "@/lib/api";
import {
  devEnvironmentApi,
  isChinaMirror,
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
import type { SetupApp } from "./setupUtils";

const SETUP_APPS: SetupApp[] = ["claude", "codex"];

const NODE_DOWNLOAD_URL = "https://nodejs.org/zh-cn/download";
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
  | "tools";

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

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await devEnvironmentApi.check();
      setEnv(next);
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
    await Promise.all([refresh(), tools.checkForUpdates()]);
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

  const fixPowershell = () =>
    runTask(
      "powershell",
      () => devEnvironmentApi.fix("powershellPolicy"),
      t("setup.env.fixFailed"),
    );

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

  const runToolInstall = async (apps: SetupApp[]) => {
    if (apps.length === 0) return;
    setTask("tools");
    try {
      await tools.handleRunToolAction(apps, "install");
    } finally {
      setTask(null);
    }
  };

  const installTools = async (apps: SetupApp[]) => {
    await prepareNpm(env);
    await runToolInstall(apps);
    await refresh();
  };

  /** 一键全部安装：执行策略 → Node.js → Git → npm 镜像 / 权限 → Claude Code、Codex */
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
      if (!current.nodeVersion || !current.npmVersion) {
        await installDependency("node");
        current = (await refresh()) ?? current;
        if (!current.nodeVersion) {
          toast.error(t("setup.env.installAllStopped"), { closeButton: true });
          return;
        }
      }
      if (current.platform === "windows" && !current.gitVersion) {
        await installDependency("git");
      }
      await prepareNpm(current);
      // 读最新的安装状态：hook 里的版本信息在这次异步流程里是旧的
      const versions = await settingsApi.getToolVersions([...SETUP_APPS]);
      await runToolInstall(
        SETUP_APPS.filter(
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
  const hasGit = env ? Boolean(env.gitVersion) : null;
  const policyBlocking = isPowershellPolicyBlocking(env?.powershellPolicy);
  const busy = installingAll || task !== null;
  const allReady =
    hasNode === true &&
    (!isWindows || (hasGit === true && !policyBlocking)) &&
    env?.npmGlobalWritable !== false &&
    SETUP_APPS.every((app) =>
      Boolean(tools.toolVersionByName.get(app)?.version),
    );

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
        hint={t("setup.env.nodeHint")}
        value={env?.nodeVersion}
        ok={hasNode}
        busy={(checking && !env) || task === "node"}
        action={hasNode === false && dependencyButton("node")}
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
      {SETUP_APPS.map((app) => {
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
    </StepCard>
  );
}
