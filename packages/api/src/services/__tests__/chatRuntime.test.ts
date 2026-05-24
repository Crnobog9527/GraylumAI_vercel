import { describe, expect, it } from 'vitest';
import {
  ModulePromptResolutionError,
  applyUserPromptTemplate,
  buildRuntimeSystemPrompt,
  resolveActiveModulePrompt,
} from '../chatRuntime';

function createModuleSupabase(row: Record<string, unknown> | null, error: unknown = null) {
  return {
    from(table: string) {
      expect(table).toBe('modules');

      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        single() {
          return Promise.resolve({ data: row, error });
        },
      };

      return builder;
    },
  };
}

describe('resolveActiveModulePrompt', () => {
  it('uses the selected active module prompt, system prompt, user template, and model', async () => {
    const prompt = await resolveActiveModulePrompt(createModuleSupabase({
      id: '00000000-0000-4000-8000-000000000001',
      title: '短视频脚本',
      description: '生成短视频脚本',
      prompt_content: '只输出脚本结构',
      system_prompt: '你是短视频策划',
      user_prompt_template: '主题：{{input}}',
      model_id: '00000000-0000-4000-8000-000000000101',
      platform: 'web',
      category: 'video',
      active: 'true',
    }) as any, {
      moduleId: '00000000-0000-4000-8000-000000000001',
      platform: 'web',
    });

    expect(prompt).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      name: '短视频脚本',
      content: '只输出脚本结构',
      systemPrompt: '你是短视频策划',
      userPromptTemplate: '主题：{{input}}',
      modelId: '00000000-0000-4000-8000-000000000101',
      category: 'video',
    });
    expect(buildRuntimeSystemPrompt(prompt)).toBe('你是短视频策划\n\n只输出脚本结构');
    expect(applyUserPromptTemplate(prompt, '新品发布')).toBe('主题：新品发布');
  });

  it('falls back to module-owned title and description when prompt text is missing', async () => {
    const prompt = await resolveActiveModulePrompt(createModuleSupabase({
      id: '00000000-0000-4000-8000-000000000002',
      title: '营销文案',
      description: '为活动生成营销文案',
      prompt_content: null,
      system_prompt: null,
      user_prompt_template: null,
      model_id: null,
      platform: 'all',
      category: 'marketing',
      active: 'true',
    }) as any, {
      moduleId: '00000000-0000-4000-8000-000000000002',
      platform: 'web',
    });

    expect(prompt.content).toContain('「营销文案」功能模块');
    expect(prompt.content).toContain('为活动生成营销文案');
  });

  it('rejects inactive modules instead of falling back to a global prompt', async () => {
    await expect(resolveActiveModulePrompt(createModuleSupabase({
      id: '00000000-0000-4000-8000-000000000003',
      title: '已下架',
      description: 'hidden',
      prompt_content: 'hidden',
      system_prompt: null,
      user_prompt_template: null,
      model_id: null,
      platform: 'all',
      category: 'other',
      active: 'false',
    }) as any, {
      moduleId: '00000000-0000-4000-8000-000000000003',
      platform: 'web',
    })).rejects.toMatchObject<Partial<ModulePromptResolutionError>>({
      code: 'MODULE_INACTIVE',
      statusCode: 404,
    });
  });

  it('rejects modules with no prompt fields and no safe module description fallback', async () => {
    await expect(resolveActiveModulePrompt(createModuleSupabase({
      id: '00000000-0000-4000-8000-000000000004',
      title: '空配置',
      description: null,
      prompt_content: null,
      system_prompt: null,
      user_prompt_template: null,
      model_id: null,
      platform: 'all',
      category: 'other',
      active: 'true',
    }) as any, {
      moduleId: '00000000-0000-4000-8000-000000000004',
      platform: 'web',
    })).rejects.toMatchObject<Partial<ModulePromptResolutionError>>({
      code: 'MODULE_PROMPT_MISSING',
      statusCode: 400,
    });
  });
});
