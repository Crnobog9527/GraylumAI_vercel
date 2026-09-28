/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isOpenRouterEndpoint, resolveOpenAICompatibleEndpoint } from '../providerUtils';
import { OPENROUTER_MODEL_ID, checkReasoningConfig, readReasoningConfig } from '../../shared/modelReasoning';

/** Columns the eligibility check reads. The key is used here only and never returned. */
export const RUNTIME_MODEL_COLUMNS = 'id,name,model_id,provider,is_active,max_tokens,input_limit,api_key,api_endpoint,config';

export type RuntimeModelRow = {
  id: string; name: string; model_id: string; provider?: string | null; is_active?: string | null;
  max_tokens?: number | null; input_limit?: number | null; api_key?: string | null; api_endpoint?: string | null; config?: unknown;
};
/** `skill`: the model a Skill (module) dialogue runs on. `organizer`: the step result organizer. */
export type RuntimeModelUse = 'skill' | 'organizer';
export type RuntimeModelOption = { id: string; name: string; model_id: string; available: boolean; reason: string | null };

/**
 * Whether an administrator may select this model for a Runtime use. This
 * replaces the fixed model list (artifacts/modelPolicy.ts) for the Skill model
 * and the organizer; legacy generation paths keep that list until LEGACY-CLOSE.
 *
 * A Skill model needs a checked reasoning config with the interactive purpose
 * set. The organizer needs no reasoning config (unset means the provider's
 * default), but a config it does have must pass the same checks.
 */
export function runtimeModelOption(row: RuntimeModelRow, use: RuntimeModelUse): RuntimeModelOption {
  const result = (reason: string | null) => ({ id: row.id, name: row.name, model_id: row.model_id, available: reason === null, reason });
  if (row.is_active !== 'true') return result('模型已停用');
  if (!row.api_key?.trim()) return result('请先配置 API 密钥');
  if (!isOpenRouterEndpoint(resolveOpenAICompatibleEndpoint(row.provider ?? null, row.api_endpoint ?? null) ?? ''))
    return result('当前 Runtime 需要 OpenRouter 接口');
  if (!OPENROUTER_MODEL_ID.test(row.model_id) || row.model_id.toLowerCase().startsWith('openrouter/')) return result('模型 ID 格式不受支持');
  const maxTokens = Number(row.max_tokens), inputLimit = Number(row.input_limit);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) return result('请设置有效的输出上限');
  if (!Number.isSafeInteger(inputLimit) || inputLimit <= maxTokens) return result('请设置有效的上下文容量');
  const config = readReasoningConfig(row.config);
  if (use === 'skill' && !config.purposes.interactive) return result('请先在模型管理的"思考设置"里设置"交互对话"');
  const issues = checkReasoningConfig(config, { maxTokens, modelId: row.model_id });
  if (issues.length) return result('思考设置需要处理：' + issues[0]!.message);
  return result(null);
}
