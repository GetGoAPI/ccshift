import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  PlugZap,
  Sparkles,
  Terminal,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { providersApi, settingsApi, type AppId } from "@/lib/api";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";
import { checkEnvConflicts, deleteEnvVars } from "@/lib/api/env";
import type { EnvConflict } from "@/types/env";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { AppGlyph, APP_DISPLAY_NAME } from "@/components/shell/AppGlyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  BRAND_NAME,
  markOnboardingSkipped,
  markSetupDone,
} from "@/config/edition";
import { generateUUID } from "@/utils/uuid";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import {
  buildSetupProvider,
  claudeBaseUrl,
  codexBaseUrl,
  defaultProviderName,
  filterModelsFor,
  isValidHttpUrl,
  type SetupApp,
} from "./setupUtils";
import { EnvironmentStep } from "./EnvironmentStep";
import { StepCard } from "./StepCard";

const SETUP_APPS: SetupApp[] = ["claude", "claude-desktop", "codex"];

/** 读 shell 环境变量的命令行工具；Claude Desktop 不受这些变量影响 */
const ENV_SENSITIVE_APPS = ["claude", "codex"] as const;

interface QuickSetupPageProps {
  /** 配置完成后去看某个应用的供应商列表 */
  onOpenApp: (app: AppId) => void;
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; models: string[] }
  | { status: "failed"; message: string };

type Configured = { app: SetupApp; providerId: string }[];

/**
 * ccshift 快速配置：三步把 Claude Code / Claude Desktop / Codex 接到任意第三方 API。
 * 1. 环境（EnvironmentStep）：执行策略、Node.js、Git、npm 源与权限、两个 CLI
 * 2. 填地址和 Key，测试连接并拉取模型
 * 3. 一键写入并切换
 */
export function QuickSetupPage({ onOpenApp }: QuickSetupPageProps) {
  const { t } = useTranslation();
  return (
    <>
      <AppPageHeader
        icon={<Sparkles className="h-5 w-5" strokeWidth={1.5} />}
        title={t("setup.title")}
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable"
      >
        <div className="mx-auto max-w-[760px] space-y-5 px-6 pb-10 pt-4">
          <p className="text-body text-fg-2">
            {t("setup.intro", { brand: BRAND_NAME })}
          </p>
          <EnvironmentStep />
          <ApiStep onOpenApp={onOpenApp} />
        </div>
      </div>
    </>
  );
}

// ─── 第二、三步：API 与写入 ────────────────────────────────────────────────

function ApiStep({ onOpenApp }: { onOpenApp: (app: AppId) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apps, setApps] = useState<Record<SetupApp, boolean>>({
    claude: true,
    "claude-desktop": false,
    codex: true,
  });
  // Claude Desktop 是客户自己装的桌面应用：装了才能配，检测到装了就默认勾上
  const { data: desktopStatus } = useQuery({
    queryKey: ["claudeDesktopStatus"],
    queryFn: () => providersApi.getClaudeDesktopStatus(),
  });
  const desktopInstalled = Boolean(desktopStatus?.installed);
  useEffect(() => {
    if (desktopInstalled) {
      setApps((prev) => ({ ...prev, "claude-desktop": true }));
    }
  }, [desktopInstalled]);
  // 写入前查到的环境变量冲突：先让客户选清除还是照写
  const [pendingConflicts, setPendingConflicts] = useState<
    EnvConflict[] | null
  >(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [claudeModel, setClaudeModel] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState<Configured | null>(null);

  const urlValid = isValidHttpUrl(baseUrl);
  const selectedApps = SETUP_APPS.filter(
    (app) => apps[app] && (app !== "claude-desktop" || desktopInstalled),
  );
  const canSubmit =
    urlValid && apiKey.trim().length > 0 && selectedApps.length > 0 && !saving;
  const providerName = name.trim() || defaultProviderName(baseUrl) || "API";

  // 地址或 Key 改了，上一次测试结果作废
  useEffect(() => {
    setTest({ status: "idle" });
  }, [baseUrl, apiKey]);

  const runTest = async () => {
    setTest({ status: "testing" });
    try {
      const models = await fetchModelsForConfig(
        claudeBaseUrl(baseUrl),
        apiKey.trim(),
      );
      const ids = models.map((m) => m.id);
      setTest({ status: "ok", models: ids });
      // 没填过模型时给 Codex 预选一个（Codex 必须指定模型）
      if (!codexModel) {
        const codexIds = filterModelsFor("codex", ids);
        if (codexIds.length > 0 && codexIds !== ids) setCodexModel(codexIds[0]);
      }
    } catch (error) {
      setTest({
        status: "failed",
        message: extractErrorMessage(error) || t("setup.api.testFailed"),
      });
    }
  };

  const submit = async (options?: { skipConflictCheck?: boolean }) => {
    if (!options?.skipConflictCheck) {
      const found = (
        await Promise.all(
          ENV_SENSITIVE_APPS.filter((app) => apps[app]).map((app) =>
            checkEnvConflicts(app).catch(() => [] as EnvConflict[]),
          ),
        )
      ).flat();
      if (found.length > 0) {
        setPendingConflicts(found);
        return;
      }
    }
    setPendingConflicts(null);
    setSaving(true);
    const done: Configured = [];
    const input = {
      name: providerName,
      baseUrl,
      apiKey,
      claudeModel,
      codexModel,
    };
    try {
      for (const app of selectedApps) {
        const id = generateUUID();
        await providersApi.add({ ...buildSetupProvider(app, input), id }, app);
        await providersApi.switch(id, app);
        if (app === "claude") {
          // 用第三方 Key 时跳过 Claude Code 首次启动的官方登录引导
          await settingsApi
            .applyClaudeOnboardingSkip()
            .then(() => markOnboardingSkipped())
            .catch((error) => {
              console.warn("[QuickSetup] onboarding skip failed", error);
            });
        }
        done.push({ app, providerId: id });
        await queryClient.invalidateQueries({ queryKey: ["providers", app] });
      }
      await providersApi.updateTrayMenu().catch(() => undefined);
      markSetupDone();
      setConfigured(done);
      toast.success(t("setup.done.toast"));
    } catch (error) {
      toast.error(t("setup.api.saveFailed"), {
        description: extractErrorMessage(error) || undefined,
        closeButton: true,
      });
      if (done.length > 0) setConfigured(done);
    } finally {
      setSaving(false);
    }
  };

  const clearConflictsAndSubmit = async () => {
    if (!pendingConflicts) return;
    try {
      await deleteEnvVars(pendingConflicts);
      toast.success(t("setup.env.conflictsCleared"));
    } catch (error) {
      toast.error(t("setup.env.conflictsFailed"), {
        description: extractErrorMessage(error) || undefined,
      });
      return;
    }
    await submit({ skipConflictCheck: true });
  };

  if (configured) {
    return (
      <DoneCard
        configured={configured}
        onOpenApp={onOpenApp}
        onAgain={() => {
          setConfigured(null);
          setApiKey("");
        }}
      />
    );
  }

  const models = test.status === "ok" ? test.models : [];

  return (
    <StepCard
      index={2}
      title={t("setup.api.title")}
      description={t("setup.api.description")}
    >
      <div className="space-y-4 px-4 py-4">
        <div className="space-y-1.5">
          <Label>{t("setup.api.apps")}</Label>
          <div className="flex gap-4">
            {SETUP_APPS.map((app) => {
              const unavailable = app === "claude-desktop" && !desktopInstalled;
              return (
                <label
                  key={app}
                  className={cn(
                    "flex items-center gap-2 text-body",
                    unavailable ? "text-fg-3" : "cursor-pointer",
                  )}
                  title={
                    unavailable ? t("setup.api.desktopMissing") : undefined
                  }
                >
                  <Checkbox
                    checked={apps[app] && !unavailable}
                    disabled={unavailable}
                    onCheckedChange={(checked) =>
                      setApps((prev) => ({ ...prev, [app]: checked }))
                    }
                  />
                  <AppGlyph app={app} size={16} />
                  {APP_DISPLAY_NAME[app]}
                </label>
              );
            })}
          </div>
          {apps["claude-desktop"] && desktopInstalled && (
            <p className="text-caption text-fg-3">
              {t("setup.api.desktopHint")}
            </p>
          )}
        </div>

        <Field
          id="setup-base-url"
          label={t("setup.api.baseUrl")}
          hint={
            urlValid
              ? selectedApps
                  .map(
                    (app) =>
                      `${APP_DISPLAY_NAME[app]}: ${
                        app === "codex"
                          ? codexBaseUrl(baseUrl)
                          : claudeBaseUrl(baseUrl)
                      }`,
                  )
                  .join("   ")
              : t("setup.api.baseUrlHint")
          }
          error={
            baseUrl.trim() && !urlValid
              ? t("setup.api.baseUrlInvalid")
              : undefined
          }
        >
          <Input
            id="setup-base-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        <Field
          id="setup-api-key"
          label={t("setup.api.apiKey")}
          hint={t("setup.api.apiKeyHint")}
        >
          <div className="relative">
            <Input
              id="setup-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              spellCheck={false}
              autoComplete="off"
              className="pe-9"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={
                showKey ? t("setup.api.hideKey") : t("setup.api.showKey")
              }
              className="absolute end-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-control text-fg-3 hover:bg-subtle hover:text-fg-1"
            >
              {showKey ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </Field>

        <Field
          id="setup-name"
          label={t("setup.api.name")}
          hint={t("setup.api.nameHint")}
        >
          <Input
            id="setup-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={providerName}
            autoComplete="off"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="regular"
            variant="neutral"
            disabled={!urlValid || !apiKey.trim() || test.status === "testing"}
            onClick={() => void runTest()}
          >
            {test.status === "testing" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlugZap className="h-4 w-4" />
            )}
            {t("setup.api.test")}
          </Button>
          {test.status === "ok" && (
            <span className="flex items-center gap-1.5 text-body text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t("setup.api.testOk", { count: test.models.length })}
            </span>
          )}
          {test.status === "failed" && (
            <span className="flex min-w-0 items-center gap-1.5 text-body text-danger-text">
              <XCircle className="h-4 w-4 shrink-0" />
              <span className="truncate" title={test.message}>
                {t("setup.api.testFailedShort")}
              </span>
            </span>
          )}
        </div>
        {test.status === "failed" && (
          <p className="rounded-control bg-danger-soft px-3 py-2 text-caption text-fg-2">
            {t("setup.api.testFailedHint")}
            <span className="mt-1 block break-all font-mono text-fg-3">
              {test.message}
            </span>
          </p>
        )}

        <div className="grid grid-cols-2 gap-4">
          {apps.claude && (
            <ModelField
              id="setup-claude-model"
              label={t("setup.api.claudeModel")}
              hint={t("setup.api.claudeModelHint")}
              value={claudeModel}
              onChange={setClaudeModel}
              options={filterModelsFor("claude", models)}
            />
          )}
          {apps.codex && (
            <ModelField
              id="setup-codex-model"
              label={t("setup.api.codexModel")}
              hint={t("setup.api.codexModelHint")}
              value={codexModel}
              onChange={setCodexModel}
              options={filterModelsFor("codex", models)}
            />
          )}
        </div>
      </div>
      {pendingConflicts && (
        <div className="space-y-2 bg-warning-soft px-4 py-3">
          <p className="flex items-start gap-2 text-body text-fg-1">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-text" />
            {t("setup.api.conflictWarning", {
              names: [...new Set(pendingConflicts.map((c) => c.varName))].join(
                "、",
              ),
            })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              size="compact"
              variant="quiet"
              disabled={saving}
              onClick={() => void submit({ skipConflictCheck: true })}
            >
              {t("setup.api.conflictIgnore")}
            </Button>
            <Button
              size="compact"
              variant="solid"
              disabled={saving}
              onClick={() => void clearConflictsAndSubmit()}
            >
              {t("setup.api.conflictClear")}
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-3 px-4 py-3">
        <span className="me-auto text-caption text-fg-3">
          {t("setup.api.submitHint")}
        </span>
        <Button
          size="regular"
          variant="solid"
          disabled={!canSubmit || pendingConflicts !== null}
          onClick={() => void submit()}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("setup.api.submit")}
        </Button>
      </div>
    </StepCard>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-caption text-danger-text">{error}</p>
      ) : (
        hint && <p className="break-all text-caption text-fg-3">{hint}</p>
      )}
    </div>
  );
}

/** 可自由输入的模型框：测试连接拿到的模型列表作为下拉建议 */
function ModelField({
  id,
  label,
  hint,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  const listId = `${id}-options`;
  return (
    <Field id={id} label={label} hint={hint}>
      <Input
        id={id}
        list={options.length > 0 ? listId : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      {options.length > 0 && (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
    </Field>
  );
}

function DoneCard({
  configured,
  onOpenApp,
  onAgain,
}: {
  configured: Configured;
  onOpenApp: (app: AppId) => void;
  onAgain: () => void;
}) {
  const { t } = useTranslation();
  const openTerminal = async (app: SetupApp, providerId: string) => {
    try {
      await providersApi.openTerminal(providerId, app);
    } catch (error) {
      toast.error(t("setup.done.terminalFailed"), {
        description: extractErrorMessage(error) || undefined,
      });
    }
  };

  return (
    <StepCard
      index={3}
      title={t("setup.done.title")}
      description={t("setup.done.description")}
    >
      {configured.map(({ app, providerId }) => (
        <div key={app} className="flex items-center gap-3 px-4 py-3">
          <CheckCircle2 className="h-4 w-4 text-success" />
          <AppGlyph app={app} size={18} />
          <div className="min-w-0 flex-1">
            <div className="text-strong text-fg-1">{APP_DISPLAY_NAME[app]}</div>
            <div className="text-caption text-fg-3">
              {app === "claude-desktop"
                ? t("setup.done.desktopHint")
                : t("setup.done.runHint", { command: app })}
            </div>
          </div>
          <Button
            size="compact"
            variant="neutral"
            onClick={() => onOpenApp(app)}
          >
            {t("setup.done.viewProviders")}
          </Button>
          {app !== "claude-desktop" && (
            <Button
              size="compact"
              variant="solid"
              onClick={() => void openTerminal(app, providerId)}
            >
              <Terminal className="h-3.5 w-3.5" />
              {t("setup.done.openTerminal")}
            </Button>
          )}
        </div>
      ))}
      <p className="flex items-start gap-2 bg-warning-soft px-4 py-3 text-body text-fg-1">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-text" />
        {t("setup.done.restartHint")}
      </p>
      <div className="flex justify-end px-4 py-3">
        <Button size="compact" variant="quiet" onClick={onAgain}>
          {t("setup.done.again")}
        </Button>
      </div>
    </StepCard>
  );
}
