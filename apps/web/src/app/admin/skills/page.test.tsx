import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ skills: { data: undefined, error: null, isLoading: false } as any,
  modules: { data: undefined, error: null, isLoading: false } as any }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ skills: { invalidate: vi.fn() } }),
  skills: {
    list: { useQuery: () => mocks.skills }, listModules: { useQuery: () => mocks.modules },
    get: { useQuery: () => ({ data: undefined }) },
    ...Object.fromEntries(['create', 'editDraft', 'publish', 'archive', 'createModule', 'bindModule', 'setModuleActive']
      .map((name) => [name, { useMutation: () => ({ mutateAsync: vi.fn() }) }])),
  },
} }));

import AdminSkillsPage, { SkillStatus } from './page';
const skill = { id: 'a', skill_key: 'writer', draft_content: '', status: 'published' as const,
  published_version: 2, published_content_hash: 'abc123', published_at: null };

beforeEach(() => {
  mocks.skills = { data: { skills: [], total: 0 }, error: null, isLoading: false };
  mocks.modules = { data: { modules: [], total: 0 }, error: null, isLoading: false };
});
describe('admin Skills UI', () => {
  it('renders published status, version and hash', () => {
    const html = renderToStaticMarkup(createElement(SkillStatus, { skill }));
    expect(html).toContain('已发布'); expect(html).toContain('版本 2'); expect(html).toContain('abc123');
  });
  it('renders empty states and minimal create forms', () => {
    const html = renderToStaticMarkup(createElement(AdminSkillsPage));
    expect(html).toContain('暂无 Skill'); expect(html).toContain('暂无模块');
    expect(html).toContain('新建 Skill'); expect(html).toContain('新建停用模块');
    expect(html).toContain('不作为 AI 提示词');
  });
  it('shows read failures with retry instead of a fabricated empty list', () => {
    mocks.skills = { error: { message: '读取 Skill 列表失败' }, isLoading: false };
    const html = renderToStaticMarkup(createElement(AdminSkillsPage));
    expect(html).toContain('role="alert"'); expect(html).toContain('重新加载');
    expect(html).not.toContain('暂无 Skill');
  });
  it('disables enable for unbound modules and binding for active modules', () => {
    mocks.modules.data = { modules: [{ id: 'module', title: 'Writer', skill_id: null, active: false }], total: 1 };
    const html = renderToStaticMarkup(createElement(AdminSkillsPage));
    expect(html).toContain('未绑定'); expect(html).toContain('已停用');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>启用<\/button>/);
  });
});
