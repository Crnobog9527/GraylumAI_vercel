/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ push: vi.fn(), mutate: vi.fn(), catalog: { data: [] as {moduleId: string}[], isError: false } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/trpc/client', () => ({ trpc: {
  opc: { catalog: { useQuery: () => mocks.catalog } },
  modules: { incrementUsage: { useMutation: () => ({ mutate: mocks.mutate }) } },
} }));
vi.mock('@/components/ui/dialog', () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Dialog: Wrapper, DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper };
});
import ModuleDetailDialog from './ModuleDetailDialog';
import { LegacyChatDisabledButton } from '../../app/workbench/report-work-actions';
const module = { id: 'positioning-module', title: '任意显示名称', description: 'fixture' };
function action(node: ReactNode): ReactElement<any> | undefined {
  if (Array.isArray(node)) return node.map(action).find(Boolean);
  if (!isValidElement(node)) return;
  const element = node as ReactElement<any>;
  return element.props.onClick?.name === 'handleUse' ? element : action(element.props.children);
}
beforeEach(() => { vi.clearAllMocks(); mocks.catalog = { data: [], isError: false }; });
describe('legacy entry replacements', () => {
  it.each([
    ['app/workbench/page.tsx', '/positioning'],
    ['components/home/SixStepsGuide.tsx', '/positioning'],
    ['components/profile/UsageHistoryCard.tsx', '/positioning'],
    ['components/admin/AdminSidebar.tsx', '/'],
  ])('%s links to %s', (file, destination) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    expect(source).toContain(`href="${destination}"`);
    expect(source).not.toMatch(/['"`]\/chat(?:[?'"`])/);
  });
  it('admin guard returns to the homepage', () => {
    const source = readFileSync(new URL('../admin/AdminGuard.tsx', import.meta.url), 'utf8');
    expect(source).toContain("router.push('/')");
    expect(source).not.toContain("router.push('/chat')");
  });
  it('both old workbench chat actions use a disabled button with a visible explanation', () => {
    for (const label of ['在聊天中继续此轮次', '基于此定位创作脚本']) {
      const html = renderToStaticMarkup(<LegacyChatDisabledButton>{label}</LegacyChatDisabledButton>);
      expect(html).toMatch(/<button[^>]*disabled=""/);
      expect(html).toContain('旧对话已停用');
      expect(html).not.toContain('href=');
    }
    for (const file of ['page.tsx', 'report-work-actions.tsx']) {
      const source = readFileSync(new URL(`../../app/workbench/${file}`, import.meta.url), 'utf8');
      expect(source).toContain('<LegacyChatDisabledButton>');
      expect(source).not.toContain('/chat?conversation=');
      expect(source).not.toContain('api.chatEnter.mutate');
    }
  });
  it('opens positioning only for a module in the published positioning catalog', () => {
    mocks.catalog.data = [{ moduleId: module.id }];
    const tree = ModuleDetailDialog({ module, open: true, onOpenChange: vi.fn() });
    const button = action(tree)!;
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/positioning');
  });
  it.each([false, true])('disables other skills, including when catalog lookup fails (%s)', isError => {
    mocks.catalog.isError = isError;
    const onUse = vi.fn();
    const tree = ModuleDetailDialog({ module: { ...module, title: '定位分析' }, open: true, onOpenChange: vi.fn(), onUse });
    const button = action(tree)!;
    expect(button.props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain('该技能将在新工作区上线后开放');
    button.props.onClick();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(onUse).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
