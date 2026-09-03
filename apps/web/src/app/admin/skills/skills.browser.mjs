/* Local-only UI smoke. HTTP responses are fixtures; no database/provider writes.
 * Run from apps/web: node src/app/admin/skills/skills.browser.mjs
 * SKILL_UI_BASE_URL must point to a local Next.js server with non-secret test env.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const origin = process.env.SKILL_UI_BASE_URL ?? 'http://localhost:3107';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Local-only test');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const skills = [];
const modules = [];
const mutations = [];
let denied = false;
await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  if (!url.pathname.startsWith('/api/trpc/')) return route.continue();
  const names = decodeURIComponent(url.pathname.slice('/api/trpc/'.length)).split(',');
  const inputs = JSON.parse(url.searchParams.get('input') ?? route.request().postData() ?? '{}');
  const output = names.map((name, index) => {
    const input = inputs[index]?.json ?? inputs[index] ?? {};
    if (denied && (name.startsWith('admin.') || name.startsWith('skills.'))) {
      return { error: { message: 'Admin role required', code: -32003, data: { code: 'FORBIDDEN', httpStatus: 403 } } };
    }
    let data = {};
    if (name === 'skills.list') data = { skills, total: skills.length };
    if (name === 'skills.listModules') data = { modules, total: modules.length };
    if (name === 'skills.get') data = skills.find((skill) => skill.id === input.id);
    if (name === 'skills.create') {
      data = { id: '00000000-0000-4000-8000-000000000011', skill_key: input.skillKey, draft_content: input.draftContent,
        status: 'draft', published_version: 0, published_content_hash: null, published_at: null };
      skills.push(data); mutations.push(name);
    }
    if (name === 'skills.editDraft') {
      data = skills.find((skill) => skill.id === input.id);
      data.draft_content = input.draftContent; mutations.push(name);
    }
    if (name === 'skills.publish') {
      const skill = skills.find((item) => item.id === input.id);
      skill.status = 'published'; skill.published_version++;
      skill.published_content_hash = createHash('sha256').update(skill.draft_content).digest('hex');
      data = { success: true }; mutations.push(name);
    }
    if (name === 'skills.archive') {
      data = skills.find((skill) => skill.id === input.id); data.status = 'archived'; mutations.push(name);
    }
    if (name === 'skills.createModule') {
      data = { id: '00000000-0000-4000-8000-000000000001', title: input.title, description: input.description, skill_id: null, active: false };
      modules.push(data); mutations.push(name);
    }
    if (name === 'skills.bindModule') {
      data = modules.find((module) => module.id === input.id); data.skill_id = input.skillId; mutations.push(name);
    }
    if (name === 'skills.setModuleActive') {
      data = modules.find((module) => module.id === input.id); data.active = input.active; mutations.push(name);
    }
    return { result: { data } };
  });
  return route.fulfill({ status: denied ? 403 : 200, contentType: 'application/json', body: JSON.stringify(output) });
});
try {
  await page.goto(origin + '/admin/skills?domain=www', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Skill 管理', exact: true }).waitFor();
  await page.getByLabel(/新 Skill 标识/).fill('writer');
  await page.getByRole('button', { name: '新建 Skill', exact: true }).click();
  await page.getByLabel('草稿内容').fill('Private draft for browser smoke');
  assert(await page.getByRole('button', { name: '发布新版本' }).isDisabled());
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.getByText('草稿已保存', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发布新版本' }).click();
  await page.getByText('已发布新版本', { exact: true }).waitFor();
  assert.equal(skills[0].published_version, 1);
  await page.getByLabel('模块名称').fill('Writing module');
  await page.getByRole('button', { name: '新建停用模块' }).click();
  await page.getByRole('heading', { name: /Writing module/ }).waitFor();
  assert(await page.getByRole('button', { name: '启用', exact: true }).isDisabled());
  await page.getByRole('button', { name: '绑定 writer', exact: true }).click();
  await page.getByText('绑定已更新', { exact: true }).waitFor();
  await page.getByRole('button', { name: '启用', exact: true }).click();
  await page.getByText('模块已启用', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: '绑定 writer', exact: true }).isDisabled());
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByText('模块已停用', { exact: true }).waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByText('Skill 已归档', { exact: true }).waitFor();
  assert.equal(skills[0].status, 'archived');
  assert.equal(modules[0].active, false);
  await page.screenshot({ path: '/tmp/graylum-skill-1b-admin-ui.png', fullPage: true });
  assert.equal(await page.locator('[data-nextjs-dialog]').count(), 0);
  assert.deepEqual(errors, []);
  denied = true;
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByLabel('草稿内容').count(), 0);
  assert(!(await page.locator('body').innerText()).includes('Private draft for browser smoke'));
  console.log(JSON.stringify({ result: 'PASS', mutations, runtimeErrors: errors, screenshot: '/tmp/graylum-skill-1b-admin-ui.png', scope: 'local mocked HTTP only' }));
} finally {
  await context.close();
  await browser.close();
}
