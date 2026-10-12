/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataUseConsentState } from './dataUseConsent';

const state = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  mutateAsync: vi.fn(),
  isPending: false,
  setData: vi.fn(),
  onCheckedChange: undefined as undefined | ((next: boolean) => void),
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, disabled, onCheckedChange }: { checked: boolean; disabled?: boolean; onCheckedChange: (next: boolean) => void }) => {
    state.onCheckedChange = onCheckedChange;
    return <button type="button" role="switch" aria-checked={checked} disabled={disabled} />;
  },
}));
vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ dataUse: { consent: { setData: state.setData } } }),
    dataUse: {
      consent: { useQuery: () => state.query },
      setConsent: { useMutation: () => ({ mutateAsync: state.mutateAsync, isPending: state.isPending }) },
    },
  },
}));

const { DataUseConsentCard } = await import('./DataUseConsentCard');

const base: DataUseConsentState = {
  purpose: 'team_improvement', currentVersion: 'd5-v1', granted: false, version: null, grantedAt: null, revokedAt: null,
};
const grantedState: DataUseConsentState = { ...base, granted: true, version: 'd5-v1', grantedAt: '2026-10-11T08:00:00Z' };
const revokedState: DataUseConsentState = { ...grantedState, granted: false, revokedAt: '2026-10-12T08:00:00Z' };

const refetch = vi.fn();
const loaded = (data: DataUseConsentState) => ({ data, isLoading: false, isError: false, isFetching: false, refetch });
const render = () => renderToStaticMarkup(<DataUseConsentCard />);

beforeEach(() => {
  state.query = loaded(base);
  state.mutateAsync = vi.fn();
  state.isPending = false;
  state.setData = vi.fn();
  state.onCheckedChange = undefined;
  refetch.mockReset();
});

describe('data-use consent card', () => {
  it('explains what the team may read, that it can be revoked, and promises nothing the server lacks', () => {
    const html = render();
    expect(html).toContain('对话内容和生成的成果');
    expect(html).toContain('随时关闭');
    expect(html).toContain('团队不再读取你的记录');
    expect(html).toContain('不影响你自己使用和查看自己的内容');
    expect(html).not.toMatch(/去除身份|匿名|脱敏/);
  });

  it('shows the default (not granted) as off and grants with the version of the shown text', async () => {
    const html = render();
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('未开启（默认不参与）');
    state.mutateAsync.mockResolvedValue(grantedState);
    state.onCheckedChange?.(true);
    await vi.waitFor(() => expect(state.setData).toHaveBeenCalledWith(undefined, grantedState));
    expect(state.mutateAsync).toHaveBeenCalledWith({ granted: true, version: 'd5-v1' });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('shows a current grant as on, with when it was given', () => {
    state.query = loaded(grantedState);
    const html = render();
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('已开启（2026-10-');
    expect(html).not.toContain('disabled=""');
  });

  it('revokes from the on state and keeps the revoked state the server returns', async () => {
    state.query = loaded(grantedState);
    render();
    state.mutateAsync.mockResolvedValue(revokedState);
    state.onCheckedChange?.(false);
    await vi.waitFor(() => expect(state.setData).toHaveBeenCalledWith(undefined, revokedState));
    expect(state.mutateAsync).toHaveBeenCalledWith({ granted: false, version: 'd5-v1' });
  });

  it('shows a revoked consent as off with when it was revoked', () => {
    state.query = loaded(revokedState);
    const html = render();
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('已关闭（2026-10-');
  });

  it('on a failed save, shows an error and re-reads the real state instead of trusting the switch', async () => {
    render();
    state.mutateAsync.mockRejectedValue(new Error('DATA_USE_UNAVAILABLE'));
    state.onCheckedChange?.(true);
    await vi.waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(state.setData).not.toHaveBeenCalled();
  });

  it('does not offer a grant when the server has moved to a newer text, but still allows revoking', () => {
    state.query = loaded({ ...base, currentVersion: 'd5-v2', version: 'd5-v1', grantedAt: '2026-10-11T08:00:00Z' });
    const html = render();
    expect(html).toContain('disabled=""');
    expect(html).toContain('之前的同意已失效');
  });

  it('on a grant to a newer text than this page carries, says so instead of showing the old text, and still revokes', async () => {
    const newer = { ...grantedState, currentVersion: 'd5-v2', version: 'd5-v2' };
    state.query = loaded(newer);
    const html = render();
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('你已同意更新后的说明，这个页面显示的还是旧版本');
    expect(html).not.toContain('对话内容和生成的成果');
    state.mutateAsync.mockResolvedValue({ ...newer, granted: false, revokedAt: '2026-10-12T08:00:00Z' });
    state.onCheckedChange?.(false);
    await vi.waitFor(() => expect(state.setData).toHaveBeenCalled());
    expect(state.mutateAsync).toHaveBeenCalledWith({ granted: false, version: 'd5-v1' });
  });

  it('keeps the explanation for a current grant', () => {
    state.query = loaded(grantedState);
    const html = render();
    expect(html).toContain('对话内容和生成的成果');
    expect(html).not.toContain('这个页面显示的还是旧版本');
  });

  it('hides the switch rather than showing "off" when the state cannot be read', () => {
    state.query = { data: undefined, isLoading: false, isError: true, isFetching: false, refetch };
    const html = render();
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('暂时无法读取你的选择');
    expect(html).toContain('重试');
    expect(html).not.toContain('未开启');
  });

  it('shows reading, not "off", while loading', () => {
    state.query = { data: undefined, isLoading: true, isError: false, isFetching: true, refetch };
    const html = render();
    expect(html).toContain('正在读取');
    expect(html).not.toContain('role="switch"');
  });

  it('locks the switch while a change is being saved', () => {
    state.isPending = true;
    expect(render()).toContain('disabled=""');
  });
});
