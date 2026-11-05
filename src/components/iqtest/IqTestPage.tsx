import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { useProvidersQuery } from "@/lib/query/queries";
import { supportsIqTest } from "@/utils/providerCapabilities";
import { ModelIqTestPanel } from "./ModelIqTestPanel";

export type IqTestApp = "claude" | "codex";

export interface IqTestTarget {
  app: IqTestApp;
  providerId?: string;
}

interface IqTestPageProps {
  /** 从供应商卡片「⋯ → 智商测试」跳过来时预选的应用和供应商 */
  target?: IqTestTarget | null;
}

/**
 * 智商测试页（仅高级模式）：选应用 → 选供应商 → 让模型画一张 SVG（经典题「鹈鹕骑自行车」），
 * 看图判断上游质量。新手模式不显示（见 edition.ts 的 SIMPLE_MODE_PAGES）。
 * 请求逻辑见 services/model_iq_test.rs。
 */
export function IqTestPage({ target }: IqTestPageProps) {
  const { t } = useTranslation();
  const [app, setApp] = useState<IqTestApp>(target?.app ?? "claude");
  const [providerId, setProviderId] = useState<string | undefined>(
    target?.providerId,
  );

  // 已经停在这页时再从卡片跳过来，也要切到新的目标
  useEffect(() => {
    if (!target) return;
    setApp(target.app);
    setProviderId(target.providerId);
  }, [target]);

  const { data, isLoading } = useProvidersQuery(app);
  const candidates = useMemo(
    () =>
      Object.values(data?.providers ?? {}).filter((p) =>
        supportsIqTest(app, p),
      ),
    [data, app],
  );

  // 没选或选的已不在列表里：默认选当前在用的，否则第一个
  const selected =
    candidates.find((p) => p.id === providerId) ??
    candidates.find((p) => p.id === data?.currentProviderId) ??
    candidates[0];

  return (
    <>
      <AppPageHeader
        icon={<Brain className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.iqTest")}
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable"
      >
        <div className="mx-auto max-w-[760px] space-y-5 px-6 pb-10 pt-4">
          <p className="text-body text-fg-2">
            {t("provider.iqTest.pageIntro")}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl<IqTestApp>
              aria-label={t("provider.iqTest.appLabel")}
              value={app}
              onValueChange={(next) => {
                setApp(next);
                setProviderId(undefined);
              }}
              items={[
                { value: "claude", label: "Claude Code" },
                { value: "codex", label: "Codex" },
              ]}
            />
            {selected && (
              <Select value={selected.id} onValueChange={setProviderId}>
                <SelectTrigger className="h-9 w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {!isLoading && candidates.length === 0 && (
            <Notice tone="warning" title={t("provider.iqTest.noProviders")}>
              {t("provider.iqTest.noProvidersBody")}
            </Notice>
          )}

          {selected && (
            <ModelIqTestPanel
              key={`${app}:${selected.id}`}
              appId={app}
              provider={selected}
            />
          )}
        </div>
      </div>
    </>
  );
}
