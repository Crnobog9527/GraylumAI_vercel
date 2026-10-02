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
    const capacity = { route: 'example', fetchedAt: '2026-09-29T00:00:00.000Z',
      inputLimit: { supplier: 8192, current: 8192, matches: true }, maxTokens: { supplier: 8192, current: 8192, matches: true } };
    const priceView = { status: 'unread', label: '未读取', route: 'example', fetchedAt: null, pricingHash: null, source: null,
      base: null, frozen: null, promptTokensUpper: null };
    const data = { model: 'example/model', maxTokens: 8192, issues: [], capacity, priceView, config: {
      catalog, route: 'example', purposes: { interactive: { mode: 'effort', effort: 'high', wire: 'reasoning' } }
    }};
    const multipliers = { available: true, site: { creditsPerUsd: '100', defaultMultiplier: '1.5' },
      models: [{ id: 'model-fixture', effective: '2' }] };
    const state = window.__mr1 = {
      data, initialError: true, refetches: 0, saved: [], refreshError: null, saveError: null,
      queryError: { message: 'fetch failed: internal transport token', data: { code: 'INTERNAL_SERVER_ERROR' } },
      refreshCatalog: null, refreshCapacity: null, multipliers, tried: [], tryPending: false, tryError: null,
      tryResult: { ok: true, firstTextMs: 123, totalMs: 456, hasText: true, reasoningTokens: 0, costUsd: 0.00001, truncated: false },
    };
    const setData = (_, value) => { state.data = value; window.rerender(); };
    export const trpc = {
      useUtils: () => ({ modelReasoning: { get: { setData } }, settings: { getSummaryModels: { invalidate() {} } },
        modelPricing: { getMultipliers: { invalidate() {} } }, model: { getAdminModelsDashboard: { invalidate() {} } } }),
      modelPricing: { getMultipliers: { useQuery: () => ({ data: state.multipliers }) } },
      modelReasoning: {
        tryOnce: { useMutation: () => ({ isPending: state.tryPending,
          mutate: (input, options) => {
            state.tried.push(input);
            if (state.tryError) options.onError(state.tryError);
            else options.onSuccess(state.tryResult);
          }
        }) },
        get: { useQuery: () => ({
          data: state.initialError ? undefined : state.data, error: state.initialError ? state.queryError : null,
          isLoading: false, isFetching: false,
          refetch: async () => { state.refetches++; state.initialError = false; window.rerender(); }
        }) },
        refreshCatalog: { useMutation: options => ({
          error: state.refreshError, isPending: false,
          mutate: () => {
            if (state.refreshCatalog) options.onSuccess({ ...state.data, config: { ...state.data.config, catalog: state.refreshCatalog },
              capacity: state.refreshCapacity ?? state.data.capacity, previousCapacity: state.data.capacity, priceChanges: [] });
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

  it('tries the saved setting and shows measurements without submitting unsaved drafts', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await page.getByRole('combobox', { name: '交互对话的档位', exact: true }).click();
      await page.getByRole('option', { name: 'low', exact: true }).click();
      await page.getByRole('button', { name: '试一次', exact: true }).first().click();
      expect(await page.evaluate('window.__mr1.tried')).toEqual([{ modelId: 'model-fixture', purpose: 'interactive' }]);
      expect(await page.evaluate('window.__mr1.saved')).toEqual([]);
      await browserExpect(page.getByRole('status')).toContainText('首字 123 ms');
      await browserExpect(page.getByRole('status')).toContainText('有正文');
      await page.evaluate('window.__mr1.tryPending = true; window.rerender();');
      for (const button of await page.getByRole('button', { name: '试一次', exact: true }).all())
        await browserExpect(button).toBeDisabled();
    });
  });

  it('shows safe try errors and preserves the administrator validation reason', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await page.evaluate(`window.__mr1.tryError = { message: 'fetch failed SECRET_CANARY' };`);
      await page.getByRole('button', { name: '试一次', exact: true }).first().click();
      await browserExpect(page.getByRole('status')).toHaveText('试用失败，请稍后重试');
      await page.evaluate(`window.__mr1.tryError = { message: '当前思考预算超过试用上限', data: { code: 'BAD_REQUEST' } };`);
      await page.getByRole('button', { name: '试一次', exact: true }).first().click();
      await browserExpect(page.getByRole('status')).toHaveText('当前思考预算超过试用上限');
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

  it('shows the read-only price snapshot of the selected route, its tiers and staleness', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await browserExpect(page.getByTestId('model-price-snapshot')).toContainText('还没有读取价格');
      await page.evaluate(`window.__mr1.data = { ...window.__mr1.data, pricing: {
        fetchedAt: '2026-09-01T00:00:00.000Z', model: 'example/model', source: 'openrouter:/api/v1/models/example/model/endpoints',
        pricingHash: '${'c'.repeat(64)}', endpoints: [{ tag: 'example', contextLength: 8192, admissible: true, issues: [], discount: 0, unknownKeys: [],
          base: { prompt: '0.1', completion: '0.5', input_cache_write: '0.125' }, raw: {},
          overrides: [{ when: { minPromptTokens: 272000 }, prices: { prompt: '0.2', completion: '0.75' } }] }] } }; window.rerender();`);
      const panel = page.getByTestId('model-price-snapshot');
      await browserExpect(panel).toContainText('缓存写入（5 分钟）');
      await browserExpect(panel).toContainText('当 输入 ≥ 272,000 token 时');
      await browserExpect(panel).toContainText('价格已超过 7 天没有更新');
      await browserExpect(panel.getByRole('textbox')).toHaveCount(0);
    });
  });

  it('shows read-only capacity, flags a supplier mismatch and reports what an explicit read synced', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await page.evaluate(`const d = window.__mr1.data;
        window.__mr1.data = { ...d, capacity: { ...d.capacity, maxTokens: { supplier: 8192, current: 4096, matches: false } } };
        window.rerender();`);
      const panel = page.getByTestId('model-capacity-panel');
      await browserExpect(panel.locator('[data-capacity-field="inputLimit"]')).toHaveText(/上下文限制8,1928,192一致/);
      await browserExpect(panel.locator('[data-capacity-field="maxTokens"]')).toHaveText(/最大输出 Token8,1924,096不一致/);
      await browserExpect(panel).toContainText('当前值和供应商不一致，请点上面的"重新读取"同步');
      await browserExpect(panel.getByRole('textbox')).toHaveCount(0);
      await browserExpect(panel.getByRole('spinbutton')).toHaveCount(0);
      await page.evaluate(`window.__mr1.refreshCatalog = window.__mr1.data.config.catalog;
        window.__mr1.refreshCapacity = { ...window.__mr1.data.capacity, maxTokens: { supplier: 8192, current: 8192, matches: true } };`);
      await page.getByRole('button', { name: '重新读取', exact: true }).click();
      await browserExpect(panel).toContainText('本次读取已按供应商同步：最大输出 Token：4,096 → 8,192');
      await browserExpect(panel).not.toContainText('不一致');
    });
  });

  it('says capacity and frozen prices follow the saved route when the selection is unsaved', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await page.evaluate(`const d = window.__mr1.data;
        window.__mr1.data = { ...d, capacity: { ...d.capacity, route: 'old-route' },
          priceView: { ...d.priceView, status: 'route_unavailable', label: '不可推导', route: 'old-route', fetchedAt: '2026-09-29T00:00:00.000Z' } };
        window.rerender();`);
      await browserExpect(page.getByTestId('model-capacity-panel')).toContainText('你改选了线路但还没保存');
      const frozen = page.getByTestId('model-frozen-price');
      await browserExpect(frozen).toContainText('按已保存的线路 old-route 计算');
      await browserExpect(frozen).toContainText('不可推导：已选线路不在最新价格或目录里');
    });
  });

  it('shows frozen prices with their source and a reference user price, never a guessed one', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await browserExpect(page.getByTestId('model-frozen-price')).toHaveCount(0);
      await page.evaluate(`window.__mr1.data = { ...window.__mr1.data, priceView: { ...window.__mr1.data.priceView,
        status: 'ready', label: '已读取', fetchedAt: '2026-09-29T00:00:00.000Z', promptTokensUpper: 8192,
        base: { prompt: '0.1', completion: '0.5' },
        frozen: { promptUsdPerMillion: '0.2', completionUsdPerMillion: '0.75', requestUsd: '0',
          explain: { prompt: '第 1 档输入', completion: '第 1 档输出' } } } }; window.rerender();`);
      const frozen = page.getByTestId('model-frozen-price');
      await browserExpect(frozen).toContainText('输入最高单价 $0.2 美元 / 百万 token（来源：第 1 档输入）');
      await browserExpect(frozen).toContainText('输出最高单价 $0.75 美元 / 百万 token（来源：第 1 档输出）');
      await browserExpect(frozen).not.toContainText('每次请求');
      const preview = page.getByTestId('model-user-price-preview');
      await browserExpect(preview).toContainText('倍数 m（2）× 每美元积分 q（100）。仅供参考，实扣按实际费用');
      await browserExpect(preview).toContainText('输入最多约 40 积分 / 百万 token');
      await browserExpect(preview).toContainText('输出最多约 150 积分 / 百万 token');
      await page.evaluate(`window.__mr1.multipliers = { ...window.__mr1.multipliers, site: null }; window.rerender();`);
      await browserExpect(preview).toContainText('倍数或每美元积分未知，无法换算');
      await browserExpect(preview).not.toContainText('积分 / 百万 token');
    });
  });

  it('does not let a route with conflicting duplicate prices be chosen', async () => {
    await withDialog(async page => {
      await loadSettings(page);
      await page.evaluate(`const d = window.__mr1.data;
        const catalog = { ...d.config.catalog, endpoints: [...d.config.catalog.endpoints,
          { tag: 'dup', providerName: 'Dup', supportedParameters: [], contextLength: 8192, maxCompletionTokens: 8192 }] };
        const endpoint = { tag: 'dup', contextLength: 8192, admissible: false, issues: ['PRICE_NOT_UNIQUE'], discount: null,
          unknownKeys: [], base: { prompt: '0.1', completion: '0.5' }, raw: {}, overrides: [] };
        window.__mr1.data = { ...d, config: { ...d.config, catalog }, pricing: { fetchedAt: '2026-09-29T00:00:00.000Z',
          model: 'example/model', source: 'openrouter', pricingHash: '${'d'.repeat(64)}', endpoints: [endpoint] } };
        window.rerender();`);
      await page.getByRole('combobox', { name: '供应商线路', exact: true }).click();
      const option = page.getByRole('option', { name: /价格不唯一，不可选/ });
      await browserExpect(option).toHaveAttribute('aria-disabled', 'true');
      await browserExpect(page.getByRole('option', { name: /Example/ })).not.toHaveAttribute('aria-disabled', 'true');
    });
  });
});
