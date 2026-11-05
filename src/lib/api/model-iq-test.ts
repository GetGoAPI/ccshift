import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

// ===== 模型智商测试（高级模式）=====
// 与连通检测不同：这里用供应商当前配置发一次真实的大模型请求（会消耗少量额度）。

export interface ModelIqTestResult {
  modelRequested: string;
  /** 上游响应里报告的模型名 */
  modelReported?: string | null;
  wireFormat: "anthropic" | "openai_chat" | "openai_responses";
  text: string;
  firstTokenMs?: number | null;
  totalMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  stopReason?: string | null;
}

export async function modelIqTestProvider(
  appType: AppId,
  providerId: string,
  model: string,
  prompt: string,
): Promise<ModelIqTestResult> {
  return invoke("model_iq_test_provider", {
    appType,
    providerId,
    model,
    prompt,
  });
}
