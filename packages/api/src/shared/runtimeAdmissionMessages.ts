/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Fixed refusal when the selected model/purpose has no per-call billing profile (no call, no charge). */
export const RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE = '当前模型用途尚未完成逐次计费验证，请管理员核对配置；未发起模型调用。';

/** These refusals happen before an execution or reservation exists. No paid fallback is allowed. */
export const RESEARCH_TOOLS_UNAVAILABLE_MESSAGE = '搜索暂时不可用，请稍后重试。本轮未发起模型调用，也未扣积分。';
export const RESEARCH_TOOLS_CONTEXT_CAPACITY_MESSAGE = '本轮内容加上搜索工具后超出处理容量，请精简本轮输入后重试。本轮未发起模型调用，也未扣积分。';
