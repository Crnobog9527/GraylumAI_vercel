/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The admin "功能模块" page in a real browser with the server calls replaced: what each control sends, word for word.
// Written against the page while it was one 1322-line file; it has to keep passing unchanged when the page is split.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const entry = fileURLToPath(new URL('./__prompts_fixture__.js', import.meta.url));
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vite = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  const source = fileURLToPath(new URL('./page.tsx', import.meta.url));
  const mock = `
    if (!globalThis.crypto.randomUUID) { let n = 0; globalThis.crypto.randomUUID = () => 'uuid-' + (++n); }
    const mod = over => ({ id: 'm1', title: '写作助手', description: '一句话说明', full_description: null, prompt_content: 'PROMPT',
      system_prompt: null, user_prompt_template: null, model_id: null, platform: 'all', features: null, examples: '["例一","例二"]',
      preparation_questions: null, icon: 'Wand2', image_url: null, badge_type: null, badge_text: null, credits_display: null,
      category: 'writing', is_featured: false, active: true, sort_order: 3, created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z', skill_id: null, ...over });
    const modules = [mod({}), mod({ id: 'm2', title: '营销文案', description: null, prompt_content: 'P2', category: 'marketing',
      active: false, is_featured: true, examples: null })];
    const dashboard = { modules, prompts: modules, total: 2, models: [{ id: 'model-a', name: '模型 A' }],
      stats: { total: 2, active: 1, inactive: 1, featured: 1, byCategory: { writing: 1, marketing: 1 } } };
    window.calls = []; window.queries = [];
    const mutation = name => ({ useMutation: options => ({ isPending: false, mutate: (input, extra) => {
      window.calls.push([name, input]);
      void options?.onSuccess?.({ deletedIds: input?.ids ?? [] }, input);
    } }) });
    export const trpc = {
      useUtils: () => ({
        admin: { getPromptsDashboard: { cancel: async () => {}, setData: () => {}, invalidate: async () => {} } },
        skills: { readModule: { fetch: async () => null } },
      }),
      settings: { getSummaryModels: { useQuery: () => ({ data: undefined }) } },
      skills: { saveModule: mutation('saveSkill') },
      admin: {
        getPromptsDashboard: { useQuery: input => { window.queries.push(input);
          return { data: dashboard, isLoading: false, error: null, refetch: async () => ({}) }; } },
        createPrompt: mutation('createPrompt'), updatePrompt: mutation('updatePrompt'), removePrompts: mutation('removePrompts'),
        batchUpdatePrompts: mutation('batchUpdatePrompts'), batchSetPromptActive: mutation('batchSetPromptActive'),
        batchDeletePrompts: mutation('batchDeletePrompts'),
      },
    };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../../../', import.meta.url)) } },
    plugins: [{ name: 'prompts-local-fixture', enforce: 'pre', resolveId(id: string) {
      if (id === entry) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return '\0prompts-trpc';
    }, load(id: string) {
      if (id === '\0prompts-trpc') return mock;
      if (id === entry) return `import React from 'react'; import { createRoot } from 'react-dom/client';
        import Page from ${JSON.stringify(source)};
        createRoot(document.getElementById('root')).render(React.createElement(Page));`;
    } }],
    build: { write: false, minify: false, lib: { entry, name: 'PromptsTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

async function open() {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: code });
  return { page, errors };
}
const calls = (page: Page) => page.evaluate('window.calls') as Promise<[string, unknown][]>;
const stat = (page: Page, label: string) => page.getByText(label, { exact: true }).locator('xpath=following-sibling::p');

it('the list: counts, row actions, the category filter and every batch action send what the page shows', async () => {
  const { page, errors } = await open();
  try {
    const first = page.getByTestId('admin-prompt-row-m1');
    const second = page.getByTestId('admin-prompt-row-m2');
    await browserExpect(first.getByTestId('admin-prompt-name')).toHaveText('写作助手');
    await browserExpect(first).toContainText('一句话说明');
    await browserExpect(first).toContainText('内容创作');
    await browserExpect(first).toContainText('展示中');
    await browserExpect(second).toContainText('P2');
    await browserExpect(second).toContainText('已下架');
    await browserExpect(second).toContainText('精选');
    await browserExpect(stat(page, '总模块')).toHaveText('2');
    await browserExpect(stat(page, '前台展示')).toHaveText('1');
    await browserExpect(stat(page, '精选置顶')).toHaveText('1');
    expect(await page.evaluate('window.queries[0]')).toEqual({ limit: 50 });

    await page.getByTestId('admin-prompt-toggle-m1').click();
    await first.getByText('普通', { exact: true }).click();
    expect(await calls(page)).toEqual([['updatePrompt', { id: 'm1', active: false }], ['updatePrompt', { id: 'm1', isFeatured: true }]]);

    await page.getByTestId('admin-prompt-delete-m1').click();
    const confirm = page.getByRole('dialog');
    await browserExpect(confirm.getByText('删除功能模块')).toBeVisible();
    await browserExpect(confirm).toContainText('确定删除“写作助手”吗？');
    await confirm.getByTestId('admin-module-confirm').click();
    expect((await calls(page))[2]).toEqual(['removePrompts', { ids: ['m1'] }]);
    await browserExpect(confirm).toHaveCount(0);

    await page.getByLabel('Select all modules').click();
    await browserExpect(page.getByText('已选择 2 个模块')).toBeVisible();
    await page.getByRole('button', { name: '批量启用' }).click();
    expect((await calls(page))[3]).toEqual(['batchSetPromptActive', { ids: ['m1', 'm2'], active: true }]);
    await browserExpect(page.getByText(/已选择 \d+ 个模块/)).toHaveCount(0);

    await page.getByLabel('Select module 营销文案').click();
    await page.getByRole('button', { name: '批量下架' }).click();
    await browserExpect(confirm.getByText('下架功能模块')).toBeVisible();
    await browserExpect(confirm).toContainText('确定下架选中的 1 个模块 吗？');
    await confirm.getByTestId('admin-module-confirm').click();
    expect((await calls(page))[4]).toEqual(['batchDeletePrompts', { ids: ['m2'] }]);

    await page.getByLabel('Select module 写作助手').click();
    await page.getByRole('button', { name: '删除选中' }).click();
    await browserExpect(confirm).toContainText('确定删除“1 个模块”吗？');
    await confirm.getByRole('button', { name: '取消' }).click();
    await page.getByRole('button', { name: '批量编辑' }).click();
    const batch = page.getByRole('dialog');
    await browserExpect(batch.getByText('批量编辑共享字段')).toBeVisible();
    // Nothing chosen: nothing is sent and the dialog stays (the toast host lives in the layout, not in this page).
    await batch.getByRole('button', { name: '应用到选中项' }).click();
    expect(await calls(page)).toHaveLength(5);
    await browserExpect(batch.getByText('批量编辑共享字段')).toBeVisible();
    await batch.getByRole('combobox').nth(2).click();
    await page.getByRole('option', { name: '清空模型限制' }).click();
    await batch.getByRole('combobox').nth(4).click();
    await page.getByRole('option', { name: '设为精选' }).click();
    await batch.getByRole('button', { name: '应用到选中项' }).click();
    expect((await calls(page))[5]).toEqual(['batchUpdatePrompts', { ids: ['m1'], patch: { modelId: null, isFeatured: true } }]);
    await browserExpect(batch).toHaveCount(0);

    await page.getByRole('tab', { name: '营销文案' }).click();
    expect(await page.evaluate('window.queries.at(-1)')).toEqual({ limit: 50, category: 'marketing' });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('the editor dialog: a new prompt module and an edited one send the whole form; Skill mode waits for a reviewed Skill', async () => {
  const { page, errors } = await open();
  try {
    await page.getByRole('button', { name: '新建模块' }).click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByText('新建功能模块')).toBeVisible();
    await browserExpect(dialog.getByTestId('prompt-save')).toBeDisabled();
    await dialog.getByTestId('prompt-name-input').fill('短视频脚本');
    await browserExpect(dialog.getByTestId('prompt-save')).toBeDisabled();
    await dialog.getByTestId('prompt-content-input').fill('写一个脚本');
    await dialog.getByTestId('prompt-description-input').fill('卡片说明');
    await dialog.getByTestId('prompt-sort-order-input').fill('7');
    await dialog.getByPlaceholder('每行一个').first().fill('快\n\n 准 ');
    await dialog.getByTestId('module-featured-switch').click();
    await browserExpect(dialog.getByTestId('prompt-save')).toHaveText('保存');
    await dialog.getByTestId('prompt-save').click();
    expect(await calls(page)).toEqual([['createPrompt', {
      name: '短视频脚本', description: '卡片说明', content: '写一个脚本', platform: 'all', features: ['快', '准'], icon: 'Wand2',
      category: 'other', sortOrder: 7, active: true, isFeatured: true,
    }]]);
    await browserExpect(dialog).toHaveCount(0);

    await page.getByTestId('admin-prompt-edit-m1').click();
    await browserExpect(dialog.getByText('编辑功能模块')).toBeVisible();
    await browserExpect(dialog.getByLabel('功能类型')).toHaveValue('prompt');
    await browserExpect(dialog.getByTestId('prompt-name-input')).toHaveValue('写作助手');
    await browserExpect(dialog.getByTestId('prompt-content-input')).toHaveValue('PROMPT');
    await browserExpect(dialog.getByTestId('prompt-sort-order-input')).toHaveValue('3');
    await browserExpect(dialog.getByPlaceholder('每行一个').nth(1)).toHaveValue('例一\n例二');
    await dialog.getByTestId('prompt-name-input').fill('写作助手 2');
    await dialog.getByTestId('module-active-switch').click();
    await dialog.getByTestId('prompt-save').click();
    expect((await calls(page))[1]).toEqual(['updatePrompt', {
      id: 'm1', name: '写作助手 2', description: '一句话说明', fullDescription: null, content: 'PROMPT', systemPrompt: null,
      userPromptTemplate: null, modelId: null, platform: 'all', features: null, examples: ['例一', '例二'], userQuestions: null,
      icon: 'Wand2', imageUrl: null, badgeType: null, badgeText: null, creditsDisplay: null, category: 'writing', sortOrder: 3,
      active: false, isFeatured: false,
    }]);
    await browserExpect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: '新建模块' }).click();
    await dialog.getByTestId('prompt-name-input').fill('定位 Skill');
    await dialog.getByLabel('功能类型').selectOption('skill');
    await browserExpect(dialog.getByTestId('prompt-save')).toHaveText('发布 Skill 与模块');
    await browserExpect(dialog.getByTestId('prompt-save')).toBeDisabled();
    await browserExpect(dialog.getByTestId('prompt-content-input')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消' }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(await calls(page)).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
