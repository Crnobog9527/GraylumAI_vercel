/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser;
let code: string;
const fixtureId = fileURLToPath(new URL('./__reasoning_browser_fixture__.js', import.meta.url));
const mockId = '\0reasoning-trpc';

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const vitePath = createRequire(require.resolve('vitest/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vitePath).href);
  const source = fileURLToPath(new URL('./ModelReasoningDialog.tsx', import.meta.url));
  const mock = `
    const catalog = {
      fetchedAt: '2026-09-29T00:00:00.000Z', model: 'example/model',
      reasoning: { mandatory: false, defaultEnabled: false, supportedEfforts: ['high', 'low'], defaultEffort: 'low', supportsMaxTokens: true },
      endpoints: [{ tag: 'example', providerName: 'Example', supportedParameters: ['tools', 'reasoning'], contextLength: 8192, maxCompletionTokens: 8192 }]
    };
    const data = { model: 'example/model', maxTokens: 8192, issues: [], config: {
      catalog, route: 'example', purposes: { interactive: { mode: 'effort', effort: 'high', wire: 'reasoning' } }
    }};
    const state = window.__mr1 = {
      data, initialError: true, refetches: 0, saved: [], refreshError: null, saveError: null,
      queryError: { message: 'fetch failed: internal transport token', data: { code: 'INTERNAL_SERVER_ERROR' } },
      refreshCatalog: null,
    };
    const setData = (_, value) => { state.data = value; window.rerender(); };
    export const trpc = {
      useUtils: () => ({ modelReasoning: { get: { setData } }, settings: { getSummaryModels: { invalidate() {} } } }),
      modelReasoning: {
        get: { useQuery: () => ({
          data: state.initialError ? undefined : state.data, error: state.initialError ? state.queryError : null,
          isLoading: false, isFetching: false,
          refetch: async () => { state.refetches++; state.initialError = false; window.rerender(); }
        }) },
        refreshCatalog: { useMutation: options => ({
          error: state.refreshError, isPending: false,
          mutate: () => {
            if (state.refreshCatalog) options.onSuccess({ ...state.data, config: { ...state.data.config, catalog: state.refreshCatalog } });
          }
        }) },
        save: { useMutation: () => ({ error: state.saveError, isPending: false, isSuccess: false,
          mutate: input => { state.saved.push(input); }
        }) }
      }
    };
  `;
  const bundle = await build({
    configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    oxc: { jsx: { runtime: 'automatic' } },
    resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
    plugins: [{ name: 'reasoning-local-mocks', enforce: 'pre', resolveId(id: string) {
      if (id === fixtureId) return id;
      if (id === '@/trpc/client' || id.endsWith('/trpc/client')) return mockId;
    }, load(id: string) {
      if (id === mockId) return mock;
      if (id === fixtureId) return `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import { ModelReasoningButton } from ${JSON.stringify(source)};
        const root = createRoot(document.getElementById('root'));
        window.rerender = () => root.render(React.createElement(ModelReasoningButton, { modelId: 'model-fixture', name: 'Test model' }));
        window.rerender();
      `;
    } }],
    build: { write: false, minify: false, lib: { entry: fixtureId, name: 'ReasoningTest', formats: ['iife'] } },
  });
  const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  code = output.find((item: { type: string }) => item.type === 'chunk').code;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);

afterAll(async () => { await browser?.close(); });

async function withDialog(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: code });
    await page.getByRole('button', { name: '思考设置', exact: true }).click();
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}

async function loadSettings(page: Page) {
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await browserExpect(page.getByRole('combobox', { name: '交互对话的档位', exact: true })).toHaveText('high');
}

describe('reasoning dialog local browser regression', () => {
  it('shows a safe initial error and refetches successfully when retry is clicked', async () => {
    await withDialog(async page => {
      await browserExpect(page.getByRole('alert')).toHaveText('无法读取思考设置，请稍后重试');
      await browserExpect(page.getByText('读取中', { exact: true })).toHaveCount(0);
      await browserExpect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
      await loadSettings(page);
      expect(await page.evaluate('window.__mr1.refetches')).toBe(1);
      await browserExpect(page.getByRole('alert')).toHaveCount(0);
      await browserExpect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    });
  });

  it.each([
    ['refreshError', '暂时无法读取模型目录，请稍后重试'],
    ['saveError', '保存思考设置失败，请稍后重试'],
  ])('sanitizes unknown/transport errors from %s', async (target, fallback) => {
    await withDialog(async page => {
      await loadSettings(page);
      for (const message of ['fetch failed: internal transport token', 'Unknown error: provider diagnostic']) {
        await page.evaluate(`window.__mr1.${target} = ${JSON.stringify({ message })}; window.rerender();`);
        await browserExpect(page.getByRole('alert')).toHaveText(fallback);
        await browserExpect(page.getByText(message, { exact: true })).toHaveCount(0);
      }
    });
  });

  it.each(['refreshError', 'saveError'])('preserves server BAD_REQUEST details from %s', async target => {
    await withDialog(async page => {
      await loadSettings(page);
      const message = target === 'refreshError'
        ? 'OpenRouter 目录返回的格式无法识别，没有保存；原有快照保持不变'
        : Array(6).fill('思考预算加上至少 1024 个回答 token 超过了所选线路的输出上限（2000）').join('；');
      if (target === 'saveError') expect(message.length).toBeGreaterThan(180);
      await page.evaluate(`window.__mr1.${target} = ${JSON.stringify({ message, data: { code: 'BAD_REQUEST' } })}; window.rerender();`);
      await browserExpect(page.getByRole('alert')).toHaveText(message);
    });
  });

  it('uses the refreshed default effort in the actual selection and saved payload', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await page.evaluate(`window.__mr1.refreshCatalog = {
        ...window.__mr1.data.config.catalog,
        reasoning: { ...window.__mr1.data.config.catalog.reasoning, supportedEfforts: ['low'], defaultEffort: 'low' }
      };`);
      await page.getByRole('button', { name: '重新读取', exact: true }).click();
      await browserExpect(page.getByRole('combobox', { name: '交互对话的档位', exact: true })).toHaveText('low');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      expect(await page.evaluate('window.__mr1.saved[0].purposes.interactive'))
        .toEqual({ mode: 'effort', effort: 'low', wire: 'reasoning' });
      expect(await page.evaluate('window.__mr1.data.config.purposes.interactive.effort')).toBe('high');
    });
  });
});
