import { afterEach, describe, expect, it } from 'vitest';
import { cp, link, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { inspectSkillFormat } from '../skills/format';
import { activateSkill, discoverSkills, identityOf, packageHash, sha256, validateDescriptor, type ExecutionState, type PackageDescriptor, type SkillSource } from '../skills/loader';
import { LocalSkillSource, type LocalPackage } from '../skills/localSource';

const fixtureRoot = fileURLToPath(new URL('./fixtures/standard-skills/', import.meta.url));
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function packages(root = fixtureRoot): Promise<LocalPackage[]> {
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')) as LocalPackage[];
  return catalog.map(p => ({ root: join(root, p.root), descriptor: p.descriptor }));
}
async function editable() {
  const root = await mkdtemp(join(tmpdir(), 'graylum-skill-test-')); temporary.push(root);
  await cp(fixtureRoot, root, { recursive: true });
  return packages(root);
}
function source(items: LocalPackage[], state: () => Promise<ExecutionState> = async () => 'enabled') {
  const local = new LocalSkillSource(items, state);
  const reads: string[] = [];
  const port: SkillSource = {
    list: () => local.list(), state: id => local.state(id),
    read: async (id, limit) => { reads.push(`${id.packageId}/${id.revisionId}/${id.path}`); return local.read(id, limit); },
  };
  return { port, reads, local };
}
const options = { maxContextBytes: 20_000, task: 'gather' };
function rehash(p: PackageDescriptor) { p.packageHash = packageHash(p); }
async function replace(items: LocalPackage[], path: string, text: string | Buffer) {
  await writeFile(join(items[0].root, path), text);
  const file = items[0].descriptor.files.find(f => f.path === path)!;
  file.bytes = Buffer.byteLength(text); file.sha256 = sha256(text); rehash(items[0].descriptor);
}

describe('standard Skill real filesystem loading', () => {
  it('discovers metadata only, explicitly activates a task, and reads complete transitive methods', async () => {
    const items = await packages(); const { port, reads } = source(items);
    const catalog = await discoverSkills(port);
    expect(catalog).toHaveLength(3);
    expect(reads).toEqual(items.map(p => `${p.descriptor.packageId}/${p.descriptor.revisionId}/SKILL.md`));
    expect(JSON.stringify(catalog)).not.toMatch(/ENTRY_END|manifest|requires|GATHER/);
    reads.length = 0;
    const loaded = await activateSkill(port, catalog[0].selection, options);
    expect(reads).toEqual(['workshop-notes/v1/SKILL.md', 'workshop-notes/v1/references/gather.md', 'workshop-notes/v1/assets/worksheet.md']);
    const resources = JSON.parse(loaded.forModel()).resources as { path: string; content: string }[];
    for (const r of resources) expect(r.content).toBe(await readFile(join(items[0].root, r.path), 'utf8'));
    expect(loaded.forModel()).toContain('GATHER_V1_END');
    expect(loaded.forModel()).toContain('WORKSHEET_END');
    expect(loaded.forModel()).not.toMatch(/OUTLINE_END|UNRELATED_SENTINEL/);
  });
  it('loads a generic document with no tasks or six-step extension', async () => {
    const items = await packages(); const { port, reads } = source(items);
    const loaded = await activateSkill(port, identityOf(items[2].descriptor), { maxContextBytes: 20_000 });
    expect(loaded.forModel()).toContain('READING_METHOD_END');
    expect(reads).toEqual(['reading-note/v1/SKILL.md', 'reading-note/v1/references/worksheet.md']);
  });
  it('selects only the second task resources', async () => {
    const items = await packages(); const { port, reads } = source(items);
    const loaded = await activateSkill(port, identityOf(items[0].descriptor), { ...options, task: 'outline' });
    expect(loaded.forModel()).toContain('OUTLINE_END');
    expect(reads).not.toContain('workshop-notes/v1/references/gather.md');
  });
  it('keeps v1 fixed even when v2 is available', async () => {
    const items = await packages(); const { port } = source(items.reverse());
    const old = items.find(p => p.descriptor.revisionId === 'v1' && p.descriptor.packageId === 'workshop-notes')!;
    const loaded = await activateSkill(port, identityOf(old.descriptor), options);
    expect(loaded.forModel()).toContain('GATHER_V1_END');
    expect(loaded.forModel()).not.toContain('GATHER_V2_END');
    expect(loaded.resourceIdentities().every(r => r.revisionId === 'v1' && r.packageHash === old.descriptor.packageHash)).toBe(true);
  });
  it.each(['disabled', 'archived', 'revoked', 'denied'] as const)('excludes and refuses %s even with a previously discovered identity', async state => {
    const items = await packages(); let current: ExecutionState = 'enabled';
    const { port } = source(items, async () => current);
    const catalog = await discoverSkills(port); current = state;
    expect(await discoverSkills(port)).toEqual([]);
    await expect(activateSkill(port, catalog[0].selection, options)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('rechecks revocation before delivering the assembled context', async () => {
    const items = await packages(); let current: ExecutionState = 'enabled';
    const { port } = source(items, async () => current); const read = port.read;
    port.read = async (id, limit) => { const bytes = await read(id, limit); if (id.path === 'assets/worksheet.md') current = 'revoked'; return bytes; };
    await expect(activateSkill(port, identityOf(items[0].descriptor), options)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('never falls back from missing, incomplete or forged identities', async () => {
    const items = await packages(); const { port } = source(items);
    await expect(activateSkill(port, { ...identityOf(items[0].descriptor), revisionId: 'missing' }, options)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(activateSkill(port, { packageId: 'workshop-notes' } as never, options)).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    await expect(activateSkill(port, { ...identityOf(items[0].descriptor), packageHash: '0'.repeat(64) }, options)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(activateSkill(port, identityOf(items[0].descriptor), { maxContextBytes: 20_000 })).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    await expect(activateSkill(port, identityOf(items[0].descriptor), { ...options, task: '__proto__' })).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
  });
  it('rejects ambiguous package revisions instead of choosing by order', async () => {
    const items = await packages(); const { port } = source([items[0], items[0]]);
    await expect(discoverSkills(port)).rejects.toMatchObject({ code: 'AMBIGUOUS_IDENTITY' });
    await expect(activateSkill(port, identityOf(items[0].descriptor), options)).rejects.toMatchObject({ code: 'AMBIGUOUS_IDENTITY' });
  });
  it('rejects missing and malformed entry files during real discovery', async () => {
    const items = await editable();
    await replace(items, 'SKILL.md', '---\nname: workshop-notes\ndescription: Not valid: YAML\n---\n');
    await expect(discoverSkills(source(items).port)).rejects.toMatchObject({ code: 'INVALID_FORMAT' });
    await unlink(join(items[0].root, 'SKILL.md'));
    await expect(discoverSkills(source(items).port)).rejects.toMatchObject({ code: 'RESOURCE_MISSING' });
  });
  it('rejects a descriptor hash mismatch before reading resources', async () => {
    const items = await packages(); items[0].descriptor.packageHash = '0'.repeat(64);
    expect(() => source(items)).toThrow('INTEGRITY_MISMATCH');
  });
  it('rejects missing on-disk references with no substitution', async () => {
    const items = await editable(); await unlink(join(items[0].root, 'references/gather.md'));
    await expect(activateSkill(source(items).port, identityOf(items[0].descriptor), options)).rejects.toMatchObject({ code: 'RESOURCE_MISSING' });
  });
  it('rejects missing manifest references and equivalent paths', async () => {
    const items = await packages(); const p = items[0].descriptor;
    p.files[0].requires.push('references/missing.md'); rehash(p);
    expect(() => validateDescriptor(p)).toThrow('RESOURCE_MISSING');
    p.files[0].requires = []; p.files.push({ ...p.files[0], path: 'skill.md' }); rehash(p);
    expect(() => validateDescriptor(p)).toThrow('AMBIGUOUS_IDENTITY');
  });
  it('rejects a changed reference and never regenerates trusted hashes on read', async () => {
    const items = await editable();
    const path = join(items[0].root, 'references/gather.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace('V1', 'V2'));
    await expect(activateSkill(source(items).port, identityOf(items[0].descriptor), options)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });
  it.each(['../outside.md', '/outside.md', 'references/../../x.md', 'references\\x.md', 'references/%2e%2e/x.md', 'references//x.md', './SKILL.md', 'C:/x.md'])('refuses isolated path %s', async path => {
    const items = await packages(); const { local } = source(items);
    await expect(local.read({ ...identityOf(items[0].descriptor), path }, 2000)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
  it.each(['symlink', 'hardlink', 'directory-symlink'] as const)('rejects %s resources', async kind => {
    const items = await editable(); const root = items[0].root;
    const original = join(root, 'references/gather.md'); const target = join(root, 'copy.md');
    if (kind === 'directory-symlink') {
      const copied = join(root, 'refs-copy'); await cp(join(root, 'references'), copied, { recursive: true });
      await rm(join(root, 'references'), { recursive: true }); await symlink(copied, join(root, 'references'));
    } else {
      await cp(original, target); await unlink(original);
      if (kind === 'symlink') await symlink(target, original); else await link(target, original);
    }
    await expect(activateSkill(source(items).port, identityOf(items[0].descriptor), options)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
  it('refuses invalid UTF-8 even with correct byte/hash inventory', async () => {
    const items = await editable(); await replace(items, 'references/gather.md', Buffer.from([0xc3, 0x28]));
    await expect(activateSkill(source(items).port, identityOf(items[0].descriptor), options)).rejects.toMatchObject({ code: 'INVALID_FORMAT' });
  });
  it('checks full encoded context capacity, including framing, without clipping', async () => {
    const items = await packages(); const { port } = source(items);
    const loaded = await activateSkill(port, identityOf(items[0].descriptor), options);
    const length = Buffer.byteLength(loaded.forModel());
    for (const maxContextBytes of [1, length - 1, NaN, Infinity, -1]) {
      await expect(activateSkill(port, identityOf(items[0].descriptor), { ...options, maxContextBytes })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    }
    expect((await activateSkill(port, identityOf(items[0].descriptor), { ...options, maxContextBytes: length })).forModel()).toBe(loaded.forModel());
  });
  it('rejects unsupported capabilities and script inventory', async () => {
    const items = await packages(); const p = items[0].descriptor;
    p.requiredCapabilities.push('shell.execute'); rehash(p);
    expect(() => validateDescriptor(p)).toThrow('UNSUPPORTED_CAPABILITY');
    p.requiredCapabilities = []; p.files[1].path = 'scripts/run.md'; rehash(p);
    expect(() => validateDescriptor(p)).toThrow('UNSUPPORTED_CAPABILITY');
  });
  it('keeps JSON, inspection, and errors free of bodies and private inventory', async () => {
    const items = await packages(); const { port } = source(items);
    const loaded = await activateSkill(port, identityOf(items[0].descriptor), options);
    expect(Object.keys(loaded.toJSON()).sort()).toEqual(['description', 'name', 'packageId', 'revisionId']);
    expect(JSON.stringify(loaded) + inspect(loaded)).not.toMatch(/ENTRY_END|GATHER|requires|packageHash|sha256|root|resources/);
    port.read = async () => { throw new Error('PRIVATE_BODY_SENTINEL /internal/path'); };
    try { await activateSkill(port, identityOf(items[0].descriptor), options); expect.unreachable(); }
    catch (error) { expect(String(error) + JSON.stringify(error) + inspect(error)).not.toContain('PRIVATE_BODY_SENTINEL'); }
  });
  it('validates both real fixture entries against the standard and host rules', async () => {
    for (const p of await packages()) {
      const report = inspectSkillFormat(await readFile(join(p.root, 'SKILL.md'), 'utf8'), p.descriptor.directoryName);
      expect(report).toEqual({ standard: { valid: true, issues: [] }, compatibility: { supported: true, issues: [] } });
    }
  });
});

describe('standard validation vs host compatibility diagnostics', () => {
  const entry = (yaml: string) => `---\n${yaml}\n---\nPRIVATE_BODY_SENTINEL\n`;
  it.each([
    ['description: A fictional example', 'NAME_REQUIRED'],
    ['name: Demo\ndescription: Example', 'INVALID_NAME'],
    ['name: demo--note\ndescription: Example', 'INVALID_NAME'],
    ['name: other\ndescription: Example', 'DIRECTORY_NAME_MISMATCH'],
    ['name: demo\ndescription: ""', 'INVALID_DESCRIPTION'],
    [`name: demo\ndescription: ${'x'.repeat(1025)}`, 'INVALID_DESCRIPTION'],
    ['name: demo\ndescription: Use when: needed', 'INVALID_YAML'],
    ['name: demo\nname: demo\ndescription: Example', 'INVALID_YAML'],
    ['name: demo\ndescription: Example\nmetadata: {version: 1}', 'INVALID_OPTIONAL_FIELD'],
  ])('does not silently repair invalid publication source (%s)', (yaml, code) => {
    const original = entry(yaml); const report = inspectSkillFormat(original, 'demo');
    expect(report.standard.valid).toBe(false); expect(report.standard.issues).toContain(code);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_BODY_SENTINEL'); expect(original).toBe(entry(yaml));
  });
  it('accepts block scalars, quoted colons, and unknown optional metadata without rewriting', () => {
    expect(inspectSkillFormat(entry('name: demo\ndescription: |-\n  Think: one thing\n  Then another\nx-future: {optional: true}'), 'demo').standard.valid).toBe(true);
  });
  it('reports standard-valid tools and environment metadata as unsupported by this host', () => {
    const report = inspectSkillFormat(entry('name: demo\ndescription: Example\nallowed-tools: Bash\ncompatibility: Needs an external executable'), 'demo');
    expect(report.standard.valid).toBe(true);
    expect(report.compatibility).toEqual({ supported: false, issues: ['ENVIRONMENT_REVIEW_REQUIRED', 'TOOLS_UNSUPPORTED'] });
  });
  it('reports unevaluated format separately when alias expansion is unsupported', () => {
    const report = inspectSkillFormat(entry('name: &n demo\ndescription: *n'), 'demo');
    expect(report.standard.valid).toBeNull();
    expect(report.compatibility).toEqual({ supported: false, issues: ['YAML_FEATURE_UNSUPPORTED'] });
  });
  it('does not emit parser warning values or accept unresolved custom tags', () => {
    const report = inspectSkillFormat(entry('name: demo\ndescription: !private PRIVATE_BODY_SENTINEL'), 'demo');
    expect(report.compatibility.supported).toBe(false); expect(JSON.stringify(report)).not.toContain('PRIVATE_BODY_SENTINEL');
  });
});
