//! 模型「智商测试」命令：用供应商当前配置发一次真实请求（如画鹈鹕 SVG）。

use crate::app_config::AppType;
use crate::error::AppError;
use crate::services::model_iq_test::{ModelIqTestResult, ModelIqTestService};
use crate::store::AppState;
use tauri::State;

#[tauri::command]
pub async fn model_iq_test_provider(
    state: State<'_, AppState>,
    app_type: AppType,
    provider_id: String,
    model: String,
    prompt: String,
) -> Result<ModelIqTestResult, AppError> {
    let providers = state.db.get_all_providers(app_type.as_str())?;
    let provider = providers
        .get(&provider_id)
        .ok_or_else(|| AppError::Message(format!("供应商 {provider_id} 不存在")))?
        .clone();
    ModelIqTestService::run(&app_type, &provider, &model, &prompt).await
}
