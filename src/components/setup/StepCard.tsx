import type { ReactNode } from "react";

/** 快速配置里带序号的步骤卡片 */
export function StepCard({
  index,
  title,
  description,
  actions,
  children,
}: {
  index: number;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-panel border border-border bg-surface">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-action text-caption font-semibold text-action-fg">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-fg-1">{title}</h2>
          {description && (
            <p className="mt-0.5 text-caption text-fg-3">{description}</p>
          )}
        </div>
        {actions}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}
