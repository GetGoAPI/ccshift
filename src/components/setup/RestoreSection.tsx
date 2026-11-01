import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "@/lib/toast";
import { queryClient } from "@/lib/query";
import {
  devEnvironmentApi,
  type DevCleanupPreview,
} from "@/lib/api/devEnvironment";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SettingsBlock,
  SettingsCard,
  SettingsRow,
} from "@/components/settings/SettingsLayout";
import { cn } from "@/lib/utils";
import { cleanupEverything, restoreConfigs } from "./restore";

type Level = "config" | "full";

/** 设置 → 通用：一键还原（不再使用时撤销 ccshift 做过的改动） */
export function RestoreSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<Level>("config");
  const [preview, setPreview] = useState<DevCleanupPreview | null>(null);
  const [running, setRunning] = useState(false);

  const openDialog = async () => {
    setLevel("config");
    setOpen(true);
    setPreview(await devEnvironmentApi.previewCleanup().catch(() => null));
  };

  const run = async () => {
    setRunning(true);
    try {
      const { failures } =
        level === "full" ? await cleanupEverything() : await restoreConfigs();
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      if (failures.length === 0) {
        toast.success(t("setup.restore.done"), {
          description: t("setup.restore.restartHint"),
          closeButton: true,
        });
        setOpen(false);
      } else {
        toast.warning(t("setup.restore.partial"), {
          description: failures
            .map((f) => `${f.step}: ${f.message}`)
            .join("\n"),
          closeButton: true,
        });
      }
    } finally {
      setRunning(false);
    }
  };

  // 彻底清理会删掉的东西，逐条列给客户看
  const fullItems = [
    t("setup.restore.itemUninstall"),
    preview?.nodeDir && t("setup.restore.itemNode", { path: preview.nodeDir }),
    preview?.gitDir && t("setup.restore.itemGit", { path: preview.gitDir }),
    preview?.npmRegistry && t("setup.restore.itemRegistry"),
    preview?.powershellPolicy && t("setup.restore.itemPolicy"),
    preview?.npmPrefix && t("setup.restore.itemPrefix"),
  ].filter((item): item is string => Boolean(item));

  const option = (value: Level, title: string, items: string[]) => (
    <button
      type="button"
      disabled={running}
      onClick={() => setLevel(value)}
      className={cn(
        "w-full rounded-control border px-3 py-2.5 text-start transition-colors",
        level === value
          ? "border-action bg-action-soft"
          : "border-border hover:bg-subtle",
      )}
    >
      <div className="text-strong text-fg-1">{title}</div>
      <ul className="mt-1 list-disc space-y-0.5 ps-4 text-caption text-fg-2">
        {items.map((item) => (
          <li key={item} className="break-all">
            {item}
          </li>
        ))}
      </ul>
    </button>
  );

  return (
    <SettingsBlock title={t("setup.restore.block")}>
      <SettingsCard>
        <SettingsRow
          label={t("setup.restore.label")}
          description={t("setup.restore.description")}
          control={
            <Button
              size="compact"
              variant="neutral"
              onClick={() => void openDialog()}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("setup.restore.button")}
            </Button>
          }
        />
      </SettingsCard>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!running) setOpen(next);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="space-y-2 border-b-0 bg-transparent pb-0">
            <DialogTitle>{t("setup.restore.title")}</DialogTitle>
            <DialogDescription>{t("setup.restore.intro")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 px-6 pt-3">
            {option("config", t("setup.restore.config"), [
              t("setup.restore.itemSwitch"),
              t("setup.restore.itemOnboarding"),
            ])}
            {option("full", t("setup.restore.full"), [
              t("setup.restore.itemConfigToo"),
              ...fullItems,
            ])}
            <p className="text-caption text-fg-3">
              {t("setup.restore.keepNote")}
            </p>
          </div>
          <DialogFooter className="flex gap-2 border-t-0 bg-transparent pt-2 sm:justify-end">
            <Button
              variant="outline"
              disabled={running}
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant={level === "full" ? "destructive" : "default"}
              disabled={running}
              onClick={() => void run()}
            >
              {running && <Loader2 className="h-4 w-4 animate-spin" />}
              {level === "full"
                ? t("setup.restore.confirmFull")
                : t("setup.restore.confirmConfig")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsBlock>
  );
}
