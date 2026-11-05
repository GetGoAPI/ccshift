//! 模型「智商测试」服务（高级模式工具，主要给商家自己测上游）
//!
//! 和只探测可达性的连通检测不同，这里会用供应商当前配置（地址、Key、协议）
//! 发一次**真实**的大模型请求，比如网上流行的「画一只骑自行车的鹈鹕（SVG）」。
//! 画出来的图、首字耗时、输出速度、上游报告的模型名一起交给前端展示。
//!
//! 统一走流式请求：很多中转站（尤其是 Codex 号池）只支持 stream，
//! 流式也顺带能测出首字耗时。上游无视 stream 直接回 JSON 时同样兼容。

use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::providers::{
    codex_provider_uses_anthropic, codex_provider_uses_chat_completions, get_claude_api_format,
    is_codex_official_provider, AuthStrategy, ClaudeAdapter, CodexAdapter, ProviderAdapter,
};
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, USER_AGENT};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 整次测试的上限：画一张 SVG 慢的模型也就一两分钟。
const TOTAL_TIMEOUT_SECS: u64 = 240;
/// 回给前端的文本上限，防止异常上游刷出超长内容。
const MAX_TEXT_CHARS: usize = 200_000;
const ERROR_BODY_MAX_CHARS: usize = 600;

const CLAUDE_CODE_UA: &str = "claude-cli/2.1.161 (external, cli)";
const CODEX_UA: &str = "codex_cli_rs/0.153.4";
/// 部分 Claude Code 中转只放行带 Claude Code 身份的请求。
const CLAUDE_CODE_SYSTEM: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
const GENERIC_SYSTEM: &str = "You are a helpful assistant.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WireFormat {
    Anthropic,
    OpenAiChat,
    OpenAiResponses,
}

impl WireFormat {
    fn label(self) -> &'static str {
        match self {
            WireFormat::Anthropic => "anthropic",
            WireFormat::OpenAiChat => "openai_chat",
            WireFormat::OpenAiResponses => "openai_responses",
        }
    }
}

type AuthHeaders = Vec<(http::HeaderName, http::HeaderValue)>;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelIqTestResult {
    /// 请求里填的模型
    pub model_requested: String,
    /// 上游响应里报告的模型（可能和请求不同，值得留意）
    pub model_reported: Option<String>,
    /// 使用的协议：anthropic / openai_chat / openai_responses
    pub wire_format: String,
    /// 模型输出的全部文本
    pub text: String,
    /// 首个文本片段到达耗时
    pub first_token_ms: Option<u64>,
    pub total_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// 上游给出的结束原因（如 max_tokens 表示被截断）
    pub stop_reason: Option<String>,
}

pub struct ModelIqTestService;

impl ModelIqTestService {
    pub async fn run(
        app_type: &AppType,
        provider: &Provider,
        model: &str,
        prompt: &str,
    ) -> Result<ModelIqTestResult, AppError> {
        let model = model.trim();
        if model.is_empty() {
            return Err(AppError::InvalidInput("请填写要测试的模型名".to_string()));
        }
        if prompt.trim().is_empty() {
            return Err(AppError::InvalidInput("测试题目不能为空".to_string()));
        }

        let (format, url, auth_headers, api_key) = Self::resolve_target(app_type, provider)?;
        let body = Self::build_body(format, *app_type == AppType::Claude, model, prompt);
        let headers = Self::build_headers(app_type, provider, format, auth_headers)?;
        let secrets = vec![api_key];

        let started = Instant::now();
        let client = crate::proxy::http_client::get_for_url(&url);
        let response = client
            .post(&url)
            .headers(headers)
            .json(&body)
            .timeout(Duration::from_secs(TOTAL_TIMEOUT_SECS))
            .send()
            .await
            .map_err(|e| {
                AppError::Message(crate::redact_known_secrets_strict(
                    &format!("请求失败：{e}"),
                    &secrets,
                ))
            })?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let text = crate::redact_known_secrets_strict(&text, &secrets);
            return Err(AppError::Message(format!(
                "HTTP {status}：{}",
                truncate(&text, ERROR_BODY_MAX_CHARS)
            )));
        }

        let is_sse = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.contains("event-stream"))
            .unwrap_or(false);

        let mut acc = Accumulator::new(format);

        if is_sse {
            let mut stream = response.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| AppError::Message(format!("读取响应流失败：{e}")))?;
                buf.extend_from_slice(&chunk);
                while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line);
                    acc.feed_sse_line(line.trim_end_matches(['\r', '\n']), &started)?;
                }
                if acc.text.chars().count() > MAX_TEXT_CHARS {
                    break;
                }
            }
            if !buf.is_empty() {
                let line = String::from_utf8_lossy(&buf).to_string();
                acc.feed_sse_line(line.trim_end(), &started)?;
            }
        } else {
            let text = response
                .text()
                .await
                .map_err(|e| AppError::Message(format!("读取响应失败：{e}")))?;
            let value: Value = serde_json::from_str(&text).map_err(|_| {
                AppError::Message(format!(
                    "上游返回的不是 JSON：{}",
                    truncate(
                        &crate::redact_known_secrets_strict(&text, &secrets),
                        ERROR_BODY_MAX_CHARS
                    )
                ))
            })?;
            acc.feed_full_json(&value, &started)?;
        }

        if acc.text.trim().is_empty() {
            return Err(AppError::Message(
                "上游没有返回任何文本内容（可能模型名不对，或该模型只输出了思考内容）".to_string(),
            ));
        }

        Ok(ModelIqTestResult {
            model_requested: model.to_string(),
            model_reported: acc.model,
            wire_format: format.label().to_string(),
            text: truncate(&acc.text, MAX_TEXT_CHARS),
            first_token_ms: acc.first_token_ms,
            total_ms: started.elapsed().as_millis() as u64,
            input_tokens: acc.input_tokens,
            output_tokens: acc.output_tokens,
            stop_reason: acc.stop_reason,
        })
    }

    /// 解析协议、请求地址、鉴权头。返回 (协议, URL, 鉴权头, 原始 key 用于脱敏)。
    fn resolve_target(
        app_type: &AppType,
        provider: &Provider,
    ) -> Result<(WireFormat, String, AuthHeaders, String), AppError> {
        let unsupported = || {
            AppError::Message(
                "这类供应商（官方登录 / OAuth 账号）暂不支持智商测试，请用 API Key 方式的供应商"
                    .to_string(),
            )
        };
        if provider.category.as_deref() == Some("official") {
            return Err(unsupported());
        }

        match app_type {
            AppType::Claude => {
                let adapter = ClaudeAdapter::new();
                let format = match get_claude_api_format(provider) {
                    "anthropic" => WireFormat::Anthropic,
                    "openai_chat" => WireFormat::OpenAiChat,
                    "openai_responses" => WireFormat::OpenAiResponses,
                    _ => return Err(unsupported()),
                };
                let auth = adapter
                    .extract_auth(provider)
                    .ok_or_else(|| AppError::Message("这个供应商没有填写 API Key".to_string()))?;
                if !matches!(
                    auth.strategy,
                    AuthStrategy::Anthropic | AuthStrategy::ClaudeAuth | AuthStrategy::Bearer
                ) {
                    return Err(unsupported());
                }
                let base = adapter
                    .extract_base_url(provider)
                    .map_err(|e| AppError::Message(format!("读取接口地址失败：{e}")))?;
                let endpoint = match format {
                    WireFormat::Anthropic => "/v1/messages",
                    WireFormat::OpenAiChat => "/v1/chat/completions",
                    WireFormat::OpenAiResponses => "/v1/responses",
                };
                let url = if provider.meta.as_ref().and_then(|m| m.is_full_url) == Some(true) {
                    base
                } else {
                    adapter.build_url(&base, endpoint)
                };
                let headers = adapter
                    .get_auth_headers(&auth)
                    .map_err(|e| AppError::Message(e.to_string()))?;
                Ok((format, url, headers, auth.api_key))
            }
            AppType::Codex => {
                if is_codex_official_provider(provider)
                    || provider.is_github_copilot()
                    || provider.is_xai_oauth()
                {
                    return Err(unsupported());
                }
                let adapter = CodexAdapter::new();
                let auth = adapter
                    .extract_auth(provider)
                    .ok_or_else(|| AppError::Message("这个供应商没有填写 API Key".to_string()))?;
                let base = adapter
                    .extract_base_url(provider)
                    .map_err(|e| AppError::Message(format!("读取接口地址失败：{e}")))?;
                let (format, url) = if codex_provider_uses_anthropic(provider) {
                    let mut url = format!("{}/v1/messages", base.trim_end_matches('/'));
                    while url.contains("/v1/v1") {
                        url = url.replace("/v1/v1", "/v1");
                    }
                    (WireFormat::Anthropic, url)
                } else if codex_provider_uses_chat_completions(provider) {
                    (
                        WireFormat::OpenAiChat,
                        adapter.build_url(&base, "/chat/completions"),
                    )
                } else {
                    (
                        WireFormat::OpenAiResponses,
                        adapter.build_url(&base, "/responses"),
                    )
                };
                let headers = adapter
                    .get_auth_headers(&auth)
                    .map_err(|e| AppError::Message(e.to_string()))?;
                Ok((format, url, headers, auth.api_key))
            }
            _ => Err(AppError::Message(
                "智商测试目前只支持 Claude Code 和 Codex".to_string(),
            )),
        }
    }

    fn build_body(format: WireFormat, is_claude_app: bool, model: &str, prompt: &str) -> Value {
        match format {
            WireFormat::Anthropic => json!({
                "model": model,
                "max_tokens": 8192,
                "system": [{
                    "type": "text",
                    "text": if is_claude_app { CLAUDE_CODE_SYSTEM } else { GENERIC_SYSTEM },
                }],
                "messages": [{ "role": "user", "content": prompt }],
                "stream": true,
            }),
            WireFormat::OpenAiChat => json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": GENERIC_SYSTEM },
                    { "role": "user", "content": prompt },
                ],
                "stream": true,
                "stream_options": { "include_usage": true },
            }),
            WireFormat::OpenAiResponses => json!({
                "model": model,
                "instructions": GENERIC_SYSTEM,
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": prompt }],
                }],
                "stream": true,
                "store": false,
            }),
        }
    }

    fn build_headers(
        app_type: &AppType,
        provider: &Provider,
        format: WireFormat,
        auth_headers: AuthHeaders,
    ) -> Result<HeaderMap, AppError> {
        let mut headers = HeaderMap::new();
        for (name, value) in auth_headers {
            let name = HeaderName::from_bytes(name.as_str().as_bytes())
                .map_err(|e| AppError::Message(e.to_string()))?;
            let value = HeaderValue::from_bytes(value.as_bytes())
                .map_err(|e| AppError::Message(e.to_string()))?;
            headers.insert(name, value);
        }
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("text/event-stream, application/json"),
        );
        if format == WireFormat::Anthropic {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }

        let custom_ua = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.custom_user_agent_header().ok().flatten());
        let ua = match (custom_ua, app_type) {
            (Some(ua), _) => ua,
            (None, AppType::Codex) => HeaderValue::from_static(CODEX_UA),
            (None, _) => HeaderValue::from_static(CLAUDE_CODE_UA),
        };
        headers.insert(USER_AGENT, ua);
        match app_type {
            AppType::Codex => {
                headers.insert("originator", HeaderValue::from_static("codex_cli_rs"));
            }
            _ => {
                headers.insert("x-app", HeaderValue::from_static("cli"));
            }
        }
        Ok(headers)
    }
}

/// 把流式 / 非流式响应累积成最终文本和统计信息。
struct Accumulator {
    format: WireFormat,
    text: String,
    model: Option<String>,
    first_token_ms: Option<u64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    stop_reason: Option<String>,
}

impl Accumulator {
    fn new(format: WireFormat) -> Self {
        Self {
            format,
            text: String::new(),
            model: None,
            first_token_ms: None,
            input_tokens: None,
            output_tokens: None,
            stop_reason: None,
        }
    }

    fn push_text(&mut self, s: &str, started: &Instant) {
        if s.is_empty() {
            return;
        }
        if self.first_token_ms.is_none() {
            self.first_token_ms = Some(started.elapsed().as_millis() as u64);
        }
        self.text.push_str(s);
    }

    fn set_model(&mut self, v: Option<&Value>) {
        if let Some(m) = v.and_then(Value::as_str).filter(|m| !m.is_empty()) {
            self.model = Some(m.to_string());
        }
    }

    fn feed_sse_line(&mut self, line: &str, started: &Instant) -> Result<(), AppError> {
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(());
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(());
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return Ok(());
        };
        if let Some(err) = stream_error_message(&event) {
            return Err(AppError::Message(format!("上游返回错误：{err}")));
        }

        match self.format {
            WireFormat::Anthropic => match event.get("type").and_then(Value::as_str) {
                Some("message_start") => {
                    let msg = event.get("message");
                    self.set_model(msg.and_then(|m| m.get("model")));
                    if let Some(n) = msg
                        .and_then(|m| m.pointer("/usage/input_tokens"))
                        .and_then(Value::as_u64)
                    {
                        self.input_tokens = Some(n);
                    }
                }
                Some("content_block_delta") => {
                    if let Some(t) = event.pointer("/delta/text").and_then(Value::as_str) {
                        self.push_text(t, started);
                    }
                }
                Some("message_delta") => {
                    if let Some(n) = event
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64)
                    {
                        self.output_tokens = Some(n);
                    }
                    if let Some(r) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                        self.stop_reason = Some(r.to_string());
                    }
                }
                _ => {}
            },
            WireFormat::OpenAiChat => {
                self.set_model(event.get("model"));
                if let Some(choice) = event.pointer("/choices/0") {
                    if let Some(t) = choice.pointer("/delta/content").and_then(Value::as_str) {
                        self.push_text(t, started);
                    }
                    if let Some(r) = choice.get("finish_reason").and_then(Value::as_str) {
                        self.stop_reason = Some(r.to_string());
                    }
                }
                self.read_openai_usage(event.get("usage"));
            }
            WireFormat::OpenAiResponses => match event.get("type").and_then(Value::as_str) {
                Some("response.created") | Some("response.in_progress") => {
                    self.set_model(event.pointer("/response/model"));
                }
                Some("response.output_text.delta") => {
                    if let Some(t) = event.get("delta").and_then(Value::as_str) {
                        self.push_text(t, started);
                    }
                }
                Some("response.completed") | Some("response.incomplete") => {
                    let resp = event.get("response");
                    self.set_model(resp.and_then(|r| r.get("model")));
                    self.read_openai_usage(resp.and_then(|r| r.get("usage")));
                    if let Some(s) = resp.and_then(|r| r.get("status")).and_then(Value::as_str) {
                        self.stop_reason = Some(s.to_string());
                    }
                    if let Some(r) = resp
                        .and_then(|r| r.pointer("/incomplete_details/reason"))
                        .and_then(Value::as_str)
                    {
                        self.stop_reason = Some(r.to_string());
                    }
                    // 个别网关不发 delta，只在 completed 里给完整输出
                    if self.text.is_empty() {
                        if let Some(resp) = resp {
                            let t = responses_output_text(resp);
                            self.push_text(&t, started);
                        }
                    }
                }
                Some("response.failed") => {
                    let msg = event
                        .pointer("/response/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("response.failed");
                    return Err(AppError::Message(format!("上游返回错误：{msg}")));
                }
                _ => {}
            },
        }
        Ok(())
    }

    fn read_openai_usage(&mut self, usage: Option<&Value>) {
        let Some(usage) = usage else { return };
        if let Some(n) = usage
            .get("prompt_tokens")
            .or_else(|| usage.get("input_tokens"))
            .and_then(Value::as_u64)
        {
            self.input_tokens = Some(n);
        }
        if let Some(n) = usage
            .get("completion_tokens")
            .or_else(|| usage.get("output_tokens"))
            .and_then(Value::as_u64)
        {
            self.output_tokens = Some(n);
        }
    }

    fn feed_full_json(&mut self, v: &Value, started: &Instant) -> Result<(), AppError> {
        if let Some(err) = stream_error_message(v) {
            return Err(AppError::Message(format!("上游返回错误：{err}")));
        }
        self.set_model(v.get("model"));
        match self.format {
            WireFormat::Anthropic => {
                if let Some(blocks) = v.get("content").and_then(Value::as_array) {
                    for b in blocks {
                        if b.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                self.push_text(t, started);
                            }
                        }
                    }
                }
                self.input_tokens = v.pointer("/usage/input_tokens").and_then(Value::as_u64);
                self.output_tokens = v.pointer("/usage/output_tokens").and_then(Value::as_u64);
                self.stop_reason = v
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            WireFormat::OpenAiChat => {
                if let Some(t) = v
                    .pointer("/choices/0/message/content")
                    .and_then(Value::as_str)
                {
                    self.push_text(t, started);
                }
                self.stop_reason = v
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.read_openai_usage(v.get("usage"));
            }
            WireFormat::OpenAiResponses => {
                let t = responses_output_text(v);
                self.push_text(&t, started);
                self.read_openai_usage(v.get("usage"));
                self.stop_reason = v.get("status").and_then(Value::as_str).map(str::to_string);
            }
        }
        // 非流式没法区分首字时间，不报
        self.first_token_ms = None;
        Ok(())
    }
}

fn responses_output_text(resp: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = resp.get("output").and_then(Value::as_array) {
        for item in items {
            if let Some(parts) = item.get("content").and_then(Value::as_array) {
                for p in parts {
                    if p.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(t) = p.get("text").and_then(Value::as_str) {
                            out.push_str(t);
                        }
                    }
                }
            }
        }
    }
    out
}

/// 流里夹带的错误事件（Anthropic `type: error`、OpenAI `{error: {...}}`）。
fn stream_error_message(v: &Value) -> Option<String> {
    let err = v.get("error")?;
    if err.is_null() {
        return None;
    }
    let msg = err
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| err.as_str().map(str::to_string))
        .unwrap_or_else(|| err.to_string());
    Some(msg)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_stream_accumulates_text_and_usage() {
        let started = Instant::now();
        let mut acc = Accumulator::new(WireFormat::Anthropic);
        for line in [
            r#"data: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":12}}}"#,
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"<svg>"}}"#,
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"</svg>"}}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":34}}"#,
        ] {
            acc.feed_sse_line(line, &started).unwrap();
        }
        assert_eq!(acc.text, "<svg></svg>");
        assert_eq!(acc.model.as_deref(), Some("claude-x"));
        assert_eq!(acc.input_tokens, Some(12));
        assert_eq!(acc.output_tokens, Some(34));
        assert_eq!(acc.stop_reason.as_deref(), Some("end_turn"));
        assert!(acc.first_token_ms.is_some());
    }

    #[test]
    fn responses_stream_accumulates_text() {
        let started = Instant::now();
        let mut acc = Accumulator::new(WireFormat::OpenAiResponses);
        for line in [
            r#"data: {"type":"response.created","response":{"model":"gpt-x"}}"#,
            r#"data: {"type":"response.output_text.delta","delta":"hi"}"#,
            r#"data: {"type":"response.completed","response":{"model":"gpt-x-2","status":"completed","usage":{"input_tokens":3,"output_tokens":4}}}"#,
        ] {
            acc.feed_sse_line(line, &started).unwrap();
        }
        assert_eq!(acc.text, "hi");
        assert_eq!(acc.model.as_deref(), Some("gpt-x-2"));
        assert_eq!(acc.output_tokens, Some(4));
    }

    #[test]
    fn chat_stream_and_error_events() {
        let started = Instant::now();
        let mut acc = Accumulator::new(WireFormat::OpenAiChat);
        acc.feed_sse_line(
            r#"data: {"model":"m","choices":[{"delta":{"content":"a"}}],"usage":null}"#,
            &started,
        )
        .unwrap();
        acc.feed_sse_line("data: [DONE]", &started).unwrap();
        assert_eq!(acc.text, "a");
        assert!(acc
            .feed_sse_line(r#"data: {"error":{"message":"bad model"}}"#, &started)
            .is_err());
    }
}
