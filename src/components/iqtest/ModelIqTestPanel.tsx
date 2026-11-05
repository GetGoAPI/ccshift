import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  modelIqTestProvider,
  type ModelIqTestResult,
} from "@/lib/api/model-iq-test";
import type { AppId } from "@/lib/api/types";
import type { Provider } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";

/** 经典题：Simon Willison 的「鹈鹕骑自行车」，保持英文原句，方便和网上的结果对比。 */
const PELICAN_PROMPT = "Generate an SVG of a pelican riding a bicycle";

const RANDOM_ANIMALS = [
  "an octopus",
  "a giraffe",
  "a penguin",
  "a kangaroo",
  "a flamingo",
  "a hedgehog",
  "a walrus",
  "a capybara",
];
const RANDOM_VEHICLES = [
  "a skateboard",
  "a unicycle",
  "a tandem bicycle",
  "a scooter",
  "a tractor",
  "a hot air balloon",
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** 随机题：防止模型或上游对「鹈鹕」这道题专门做过优化。 */
function randomPrompt(): string {
  return `Generate an SVG of ${pick(RANDOM_ANIMALS)} riding ${pick(RANDOM_VEHICLES)}`;
}

type PromptMode = "pelican" | "random" | "custom";

/** 卡片配置里的默认模型：Claude 看 env，Codex 看 config.toml 的 model。 */
function defaultIqTestModel(appId: AppId, provider: Provider): string {
  const cfg = provider.settingsConfig ?? {};
  if (appId === "codex") {
    if (typeof cfg.model === "string" && cfg.model.trim()) return cfg.model;
    const toml = typeof cfg.config === "string" ? cfg.config : "";
    const match = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(toml);
    return match?.[1] ?? "gpt-5";
  }
  const env = cfg.env ?? {};
  return (
    env.ANTHROPIC_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    "claude-sonnet-4-5"
  );
}

/** 取最长的一段完整 <svg>…</svg>（模型有时先给草稿再给终稿）。 */
function extractSvg(text: string): string | null {
  const matches = text.match(/<svg[\s\S]*?<\/svg>/gi);
  if (!matches || matches.length === 0) return null;
  return matches.reduce((a, b) => (b.length >= a.length ? b : a));
}

function seconds(ms?: number | null): string {
  return ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

interface ModelIqTestPanelProps {
  appId: AppId;
  provider: Provider;
}

/**
 * 智商测试面板（嵌在「智商测试」页里）。父组件按 appId + provider.id 设 key，
 * 换供应商时整个面板重建，状态自然清空。
 */
export function ModelIqTestPanel({ appId, provider }: ModelIqTestPanelProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PromptMode>("pelican");
  const [prompt, setPrompt] = useState(PELICAN_PROMPT);
  const [model, setModel] = useState(() => defaultIqTestModel(appId, provider));
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<ModelIqTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  // 离开页面 / 换供应商后迟到的结果不要写回
  const runIdRef = useRef(0);
  useEffect(
    () => () => {
      runIdRef.current++;
    },
    [],
  );

  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - start), 200);
    return () => clearInterval(timer);
  }, [running]);

  const svg = useMemo(
    () => (result ? extractSvg(result.text) : null),
    [result],
  );
  // 用 <img> + data URL 渲染：SVG 里的脚本和外链都不会执行
  const svgUrl = useMemo(
    () =>
      svg
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        : null,
    [svg],
  );

  const changeMode = (next: PromptMode) => {
    setMode(next);
    if (next === "pelican") setPrompt(PELICAN_PROMPT);
    if (next === "random") setPrompt(randomPrompt());
  };

  const run = async () => {
    const runId = ++runIdRef.current;
    setRunning(true);
    setResult(null);
    setError(null);
    setShowRaw(false);
    try {
      const res = await modelIqTestProvider(
        appId,
        provider.id,
        model.trim(),
        prompt.trim(),
      );
      if (runId === runIdRef.current) setResult(res);
    } catch (e) {
      if (runId === runIdRef.current) setError(extractErrorMessage(e));
    } finally {
      if (runId === runIdRef.current) setRunning(false);
    }
  };

  const truncated =
    result?.stopReason &&
    ["max_tokens", "length", "incomplete", "max_output_tokens"].includes(
      result.stopReason,
    );
  const reported = result?.modelReported?.toLowerCase();
  const requested = result?.modelRequested.toLowerCase();
  const modelMismatch =
    reported &&
    requested &&
    !reported.includes(requested) &&
    !requested.includes(reported);
  const streamMs =
    result && result.firstTokenMs != null
      ? result.totalMs - result.firstTokenMs
      : result?.totalMs;
  const speed =
    result?.outputTokens && streamMs && streamMs > 0
      ? result.outputTokens / (streamMs / 1000)
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl<PromptMode>
          size="sm"
          aria-label={t("provider.iqTest.promptMode")}
          value={mode}
          onValueChange={changeMode}
          items={[
            { value: "pelican", label: t("provider.iqTest.modePelican") },
            { value: "random", label: t("provider.iqTest.modeRandom") },
            { value: "custom", label: t("provider.iqTest.modeCustom") },
          ]}
        />
        {mode === "random" && (
          <Button
            type="button"
            variant="quiet"
            size="compact"
            disabled={running}
            onClick={() => setPrompt(randomPrompt())}
          >
            {t("provider.iqTest.reroll")}
          </Button>
        )}
      </div>

      <Textarea
        value={prompt}
        disabled={running || mode !== "custom"}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        className="font-mono text-caption"
      />

      <div className="space-y-1">
        <label htmlFor="iq-test-model" className="text-caption text-fg-3">
          {t("provider.iqTest.model")}
        </label>
        <div className="flex gap-2">
          <Input
            id="iq-test-model"
            value={model}
            disabled={running}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono"
          />
          <Button
            type="button"
            variant="solid"
            className="shrink-0"
            disabled={running || !model.trim() || !prompt.trim()}
            onClick={() => void run()}
          >
            {running && <Loader2 className="h-4 w-4 animate-spin" />}
            {result || error
              ? t("provider.iqTest.retry")
              : t("provider.iqTest.start")}
          </Button>
        </div>
      </div>

      {running && (
        <div className="flex items-center gap-2 text-body text-fg-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("provider.iqTest.running", {
            seconds: (elapsed / 1000).toFixed(0),
          })}
        </div>
      )}

      {error && (
        <Notice tone="danger" title={t("provider.iqTest.failed")}>
          <span className="break-all">{error}</span>
        </Notice>
      )}

      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-caption sm:grid-cols-4">
            <Metric
              label={t("provider.iqTest.firstToken")}
              value={seconds(result.firstTokenMs)}
            />
            <Metric
              label={t("provider.iqTest.total")}
              value={seconds(result.totalMs)}
            />
            <Metric
              label={t("provider.iqTest.outputTokens")}
              value={result.outputTokens?.toString() ?? "—"}
            />
            <Metric
              label={t("provider.iqTest.speed")}
              value={speed ? `${speed.toFixed(0)} tok/s` : "—"}
            />
          </div>
          <div className="text-caption text-fg-3">
            {t("provider.iqTest.reportedModel")}
            <code className="font-mono text-fg-1">
              {result.modelReported ?? "—"}
            </code>
          </div>

          {modelMismatch && (
            <Notice tone="warning" title={t("provider.iqTest.mismatchTitle")}>
              {t("provider.iqTest.mismatchBody", {
                requested: result.modelRequested,
                reported: result.modelReported,
              })}
            </Notice>
          )}
          {truncated && (
            <Notice tone="warning" title={t("provider.iqTest.truncated")} />
          )}

          {svgUrl ? (
            <div className="flex justify-center rounded-control border border-border bg-white p-3">
              <img
                src={svgUrl}
                alt={prompt}
                className="max-h-[480px] w-full object-contain"
              />
            </div>
          ) : (
            <Notice tone="warning" title={t("provider.iqTest.noSvg")}>
              {t("provider.iqTest.noSvgBody")}
            </Notice>
          )}

          <Notice title={t("provider.iqTest.howToJudge")}>
            {t("provider.iqTest.howToJudgeBody")}
          </Notice>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="neutral"
              size="compact"
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw
                ? t("provider.iqTest.hideRaw")
                : t("provider.iqTest.showRaw")}
            </Button>
            {svg && (
              <Button
                type="button"
                variant="neutral"
                size="compact"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(svg)
                    .then(() => toast.success(t("provider.iqTest.copied")));
                }}
              >
                <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t("provider.iqTest.copySvg")}
              </Button>
            )}
          </div>
          {(showRaw || !svgUrl) && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-control bg-subtle p-3 font-mono text-caption text-fg-2">
              {result.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control bg-subtle px-3 py-2">
      <div className="text-fg-3">{label}</div>
      <div className="font-mono text-body text-fg-1">{value}</div>
    </div>
  );
}
