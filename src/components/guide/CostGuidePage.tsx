import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lightbulb } from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";

/**
 * 费用科普：给小白用户讲清楚为什么 Claude Code / Codex 花钱快、钱花在哪、怎么省。
 *
 * 内容面向中文用户，直接写在这里（不走 i18n），改文案只改这个文件。
 */

const LOOP_STEPS = [
  "第 1 次请求：模型决定先搜索代码",
  "第 2 次请求：带上搜索结果 → 读文件 A",
  "第 3 次请求：带上文件 A → 读文件 B",
  "第 4 次请求：修改代码",
  "第 5 次请求：运行测试",
  "第 6 次请求：测试没过，再改一次",
  "……",
  "第 N 次请求：回复你「已修复」",
];

export function CostGuidePage() {
  const { t } = useTranslation();

  return (
    <>
      <AppPageHeader
        icon={<Lightbulb className="h-5 w-5" strokeWidth={1.5} />}
        title={t("nav.guide")}
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable"
      >
        <div className="mx-auto max-w-[760px] space-y-5 px-6 pb-10 pt-4">
          <p className="text-body text-fg-2">
            用 Claude Code、Codex
            写代码时，常见的疑问是：「我就发了一句话，怎么扣了这么多？」「后台怎么有好多条请求？」
            这一页用大白话讲清楚钱花在哪，以及怎么省。
          </p>

          <Section index={1} title="先搞懂计费：输入、输出、缓存是四种不同的钱">
            <Para>
              计费单位是 token（大约 1 个汉字 ≈ 1～2 个 token，1 个英文单词 ≈ 1
              个 token）。每条请求分四项计费：
            </Para>
            <ul className="space-y-1.5 text-body text-fg-2">
              <Bullet label="输入">
                发给模型的内容：你的话、代码、历史对话。
              </Bullet>
              <Bullet label="缓存写入">
                第一次发送的内容会存进缓存，比普通输入贵一点（1.25 倍）。
              </Bullet>
              <Bullet label="缓存读取">
                后面的请求再发同样的内容，直接读缓存，只要输入价的 1/10。
              </Bullet>
              <Bullet label="输出">
                模型写出来的内容，
                <strong className="text-fg-1">包括它的思考过程</strong>
                ——界面上看不到，但同样计费，单价是输入的 5 倍。
              </Bullet>
            </ul>
          </Section>

          <Section index={2} title="为什么每条请求都这么大：项目上下文">
            <Para>
              模型<strong className="text-fg-1">没有记忆</strong>
              。每一条请求都要把下面这些内容整个重新发一遍：
            </Para>
            <ul className="list-disc space-y-1 pl-5 text-body text-fg-2">
              <li>系统提示词和所有工具说明（光这一块就有几万 token）</li>
              <li>CLAUDE.md / AGENTS.md 项目说明</li>
              <li>已接入的 MCP 服务器的工具说明</li>
              <li>从开始到现在的全部聊天记录</li>
              <li>它读过的每个文件、跑过的每条命令的输出</li>
            </ul>
            <Para>
              所以项目越大、对话越长，
              <strong className="text-fg-1">每一条</strong>
              请求就越贵。同一个会话聊到后面，一句「好的，继续」也可能要带上十几万
              token。
            </Para>
          </Section>

          <Section index={3} title="为什么发一条消息，后台却有好多条请求">
            <Para>
              Claude Code 和 Codex
              不是普通聊天，而是会自己动手的「Agent」。你说「帮我修这个
              bug」，它会这样一步步做：
            </Para>
            <ol className="space-y-1 rounded-md bg-subtle px-4 py-3 font-mono text-caption text-fg-2">
              {LOOP_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Para>
              <strong className="text-fg-1">
                每调用一次工具就是一次完整请求
              </strong>
              ，而且每次都带着前面全部的内容。一条消息产生 10～50
              条请求很正常。另外还有一些后台请求：
            </Para>
            <ul className="list-disc space-y-1 pl-5 text-body text-fg-2">
              <li>生成会话标题、判断话题（走小模型，很便宜）</li>
              <li>
                子代理（Explore / Task）：每个子代理都有自己的一整套上下文
              </li>
              <li>
                自动压缩：上下文快满时，把整段历史发给模型做总结，这一次请求特别大
              </li>
            </ul>
          </Section>

          <Section index={4} title="缓存是什么：基本规则">
            <Para>
              每条请求开头的大部分内容（系统提示词、项目说明、前面的对话）都是一样的。缓存就是把这部分暂存起来，下一条请求开头一样时直接读取，不用再按普通输入计费。
            </Para>
            <ul className="list-disc space-y-1 pl-5 text-body text-fg-2">
              <li>
                <strong className="text-fg-1">只认开头完全一致：</strong>
                从请求开头逐字比对，中间任何一处不同，后面的内容都要重新发送。
              </li>
              <li>
                <strong className="text-fg-1">有有效期：</strong>
                大约 5 分钟内没有新请求，缓存就会过期。
              </li>
              <li>
                <strong className="text-fg-1">这些操作会让缓存失效：</strong>
                会话中途切换模型、修改 CLAUDE.md / AGENTS.md、增删 MCP
                服务器、长时间不操作。
              </li>
              <li>
                <strong className="text-fg-1">命中情况不固定：</strong>
                能不能命中、命中多少，取决于使用方式和线路情况，不保证每次都能命中。
              </li>
            </ul>
          </Section>

          <Section index={5} title="怎么省钱">
            <TipGroup title="① 选对模型（效果最明显）">
              <Tip>
                日常写代码用 <Code>Sonnet 5.5</Code> 或 <Code>Opus 5.5</Code>
                ，Fable 留给大型重构、疑难 bug 这种真正难的问题。
              </Tip>
              <Tip>
                Claude Code 用 <Code>/model</Code>{" "}
                切换模型，最好在开新会话时再切。
              </Tip>
            </TipGroup>

            <TipGroup title="② 降低思考强度">
              <Tip>
                思考 token 按输出价计费。简单任务把思考强度（effort）调到 medium
                或 low，能省下不少。
              </Tip>
              <Tip>
                Codex：在 <Code>~/.codex/config.toml</Code> 里写{" "}
                <Code>model_reasoning_effort = "medium"</Code>
              </Tip>
            </TipGroup>

            <TipGroup title="③ 控制上下文">
              <Tip>
                一个任务做完就开新会话：Claude Code 用 <Code>/clear</Code>
                ，Codex 用 <Code>/new</Code>。不要一个会话从早聊到晚。
              </Tip>
              <Tip>
                上下文变长了就主动 <Code>/compact</Code>{" "}
                压缩，不要等它自动压缩。
              </Tip>
              <Tip>
                CLAUDE.md / AGENTS.md 写短一点，它会出现在每一条请求里。
              </Tip>
              <Tip>关掉用不到的 MCP 服务器，每个工具的说明都要占 token。</Tip>
              <Tip>
                不要整段粘贴很长的日志或文件，告诉它文件路径，让它自己去读需要的部分。
              </Tip>
              <Tip>
                随时查看：Claude Code 用 <Code>/context</Code> 看上下文占用、
                <Code>/cost</Code> 看本次会话花了多少；Codex 用{" "}
                <Code>/status</Code>。
              </Tip>
            </TipGroup>
          </Section>
        </div>
      </div>
    </>
  );
}

// ─── 小组件 ────────────────────────────────────────────────────────────────

function Section({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-panel border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-action text-caption font-semibold text-action-fg">
          {index}
        </span>
        <h2 className="text-section text-fg-1">{title}</h2>
      </header>
      <div className="space-y-3 px-4 py-4">{children}</div>
    </section>
  );
}

function Para({ children }: { children: ReactNode }) {
  return <p className="text-body text-fg-2">{children}</p>;
}

function Bullet({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="w-16 shrink-0 font-medium text-fg-1">{label}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function TipGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-body font-medium text-fg-1">{title}</h3>
      <ul className="list-disc space-y-1 pl-5 text-body text-fg-2">
        {children}
      </ul>
    </div>
  );
}

function Tip({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-subtle px-1 py-0.5 font-mono text-caption text-fg-1">
      {children}
    </code>
  );
}
