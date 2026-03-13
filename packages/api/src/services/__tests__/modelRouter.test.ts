import { describe, it, expect } from 'vitest';
import {
  classifyTask,
  classifyTaskComplexity,
  decideWebSearch,
  getSystemDefaultModelForRole,
  selectModel,
  shouldUpgradeAssistantRoute,
} from '../modelRouter';

type Row = Record<string, unknown>;

function createMockSupabase() {
  const systemSettings: Row[] = [
    { key: 'enable_smart_routing', value: 'true' },
    { key: 'enable_smart_search_decision', value: 'true' },
    { key: 'smart_routing_min_confidence', value: '0.72' },
  ];

  const aiModels: Row[] = [
    {
      id: 'primary-model',
      name: 'Claude Sonnet 4',
      model_id: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      max_tokens: 8192,
      input_limit: 200000,
      enable_web_search: 'true',
      input_token_cost: 3000,
      output_token_cost: 15000,
      is_active: 'true',
      token_counting_supported: 'true',
      token_counting_method: 'anthropic_count_tokens',
      tokenizer_family: 'anthropic',
      config: {},
    },
    {
      id: 'assistant-model',
      name: 'Claude Haiku 3.5',
      model_id: 'claude-3-5-haiku-20241022',
      provider: 'anthropic',
      max_tokens: 8192,
      input_limit: 200000,
      enable_web_search: 'true',
      input_token_cost: 800,
      output_token_cost: 4000,
      is_active: 'true',
      token_counting_supported: 'true',
      token_counting_method: 'anthropic_count_tokens',
      tokenizer_family: 'anthropic',
      config: {},
    },
  ];

  const queryState = {
    table: '',
    filters: [] as Array<{ op: 'eq' | 'in'; column: string; value: unknown }>,
  };

  const applyFilters = (rows: Row[]) => rows.filter((row) => queryState.filters.every((filter) => {
    if (filter.op === 'eq') return row[filter.column] === filter.value;
    if (filter.op === 'in') return Array.isArray(filter.value) && filter.value.includes(row[filter.column] as never);
    return true;
  }));

  const builder = {
    select: () => builder,
    order: () => {
      const source = queryState.table === 'ai_models' ? aiModels : systemSettings;
      return Promise.resolve({
        data: applyFilters(source),
        error: null,
      });
    },
    eq: (column: string, value: unknown) => {
      queryState.filters.push({ op: 'eq', column, value });
      return builder;
    },
    in: (column: string, value: unknown) => {
      queryState.filters.push({ op: 'in', column, value });
      return Promise.resolve({
        data: systemSettings.filter((row) => Array.isArray(value) && value.includes(row[column] as never)),
        error: null,
      });
    },
    single: () => {
      const source = queryState.table === 'ai_models' ? aiModels : systemSettings;
      const found = applyFilters(source)[0];
      return Promise.resolve({ data: found ?? null, error: null });
    },
  };

  return {
    from: (table: string) => {
      queryState.table = table;
      queryState.filters = [];
      return builder;
    },
  } as any;
}

describe('modelRouter', () => {
  it('classifies greetings and simple tasks as simple complexity', () => {
    expect(classifyTask('你好', 0)).toBe('greeting');
    expect(classifyTaskComplexity('帮我把这句话翻译成英文', 0)).toBe('simple');
  });

  it('classifies coding and complex multi-turn tasks as complex', () => {
    expect(classifyTask('请帮我修复这个 TypeScript 报错', 0)).toBe('coding');
    expect(classifyTaskComplexity('继续', 5)).toBe('complex');
  });

  it('decides realtime searches only for realtime-sensitive queries', () => {
    expect(decideWebSearch('你好').shouldSearch).toBe(false);
    const realtimeDecision = decideWebSearch('请查一下今天的英伟达股价');
    expect(realtimeDecision.shouldSearch).toBe(true);
    expect(realtimeDecision.estimatedSearchCount).toBeGreaterThan(0);
  });

  it('can route different turns in the same conversation to different model roles', async () => {
    const supabase = createMockSupabase();

    const firstTurn = await selectModel({
      supabase,
      conversationId: 'conversation-1',
      message: '你好',
      conversationTurns: 0,
    });

    const secondTurn = await selectModel({
      supabase,
      conversationId: 'conversation-1',
      message: '请帮我设计一个带权限系统的用户管理后端',
      conversationTurns: 1,
    });

    expect(firstTurn.modelConfig.id).toBe('assistant-model');
    expect(firstTurn.routingDecision.modelRole).toBe('assistant');
    expect(secondTurn.modelConfig.id).toBe('primary-model');
    expect(secondTurn.routingDecision.modelRole).toBe('primary');
  });

  it('upgrades risky assistant requests before execution', () => {
    const upgrade = shouldUpgradeAssistantRoute({
      message: '请帮我看这个报错：```ts\nTypeError: x is not a function\n```',
      decision: {
        taskType: 'simple_qa',
        confidence: 0.84,
        modelRole: 'assistant',
        assistantEligible: true,
        reasonCodes: ['short_simple_query'],
      },
      minConfidence: 0.72,
    });

    expect(upgrade.shouldUpgrade).toBe(true);
    expect(upgrade.reasonCodes).toContain('assistant_low_confidence');
    expect(upgrade.reasonCodes).toContain('assistant_code_or_error_context');
  });

  it('resolves a primary fallback model even when explicit settings are empty', async () => {
    const supabase = createMockSupabase();

    const primaryModel = await getSystemDefaultModelForRole(supabase, 'primary');
    const assistantModel = await getSystemDefaultModelForRole(supabase, 'assistant');

    expect(primaryModel.id).toBe('primary-model');
    expect(assistantModel.id).toBe('assistant-model');
  });
});
