import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';
import { parseSkillEntry } from './format';

export type SkillErrorCode = 'INVALID_IDENTITY' | 'AMBIGUOUS_IDENTITY' | 'UNAVAILABLE'
  | 'INVALID_PACKAGE' | 'INVALID_FORMAT' | 'UNSUPPORTED_CAPABILITY' | 'INVALID_PATH'
  | 'RESOURCE_MISSING' | 'INTEGRITY_MISMATCH' | 'CAPACITY_EXCEEDED' | 'SOURCE_FAILURE';
export class SkillLoadError extends Error {
  constructor(readonly code: SkillErrorCode) { super(code); this.name = 'SkillLoadError'; }
  toJSON() { return { code: this.code }; }
}
export function fail(code: SkillErrorCode): never { throw new SkillLoadError(code); }
export async function guarded<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) { if (error instanceof SkillLoadError) throw error; return fail('SOURCE_FAILURE'); }
}
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({ packageId: id, revisionId: id, packageHash: hash }).strict();
export type PackageIdentity = z.infer<typeof identitySchema>;
const fileSchema = z.object({
  path: z.string().min(1).max(240), bytes: z.number().int().min(0).max(2 * 1024 * 1024),
  sha256: hash, mediaType: z.literal('text/markdown'), requires: z.array(z.string()).max(64),
}).strict();
const descriptorSchema = identitySchema.extend({
  directoryName: z.string().min(1).max(64),
  files: z.array(fileSchema).min(1).max(64),
  tasks: z.record(id, z.array(z.string()).max(64)),
  requiredCapabilities: z.array(z.string()).max(64),
}).strict();
export type PackageDescriptor = z.infer<typeof descriptorSchema>;
export type ResourceIdentity = PackageIdentity & { path: string };
export type ExecutionState = 'enabled' | 'disabled' | 'archived' | 'revoked' | 'denied';
/** Internal, request-scoped port. Implementations must not log private values. */
export interface SkillSource {
  list(): Promise<readonly PackageDescriptor[]>;
  state(identity: PackageIdentity): Promise<ExecutionState>;
  read(identity: ResourceIdentity, maxBytes: number): Promise<Uint8Array>;
}
export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function assertPath(path: string): void {
  if (typeof path !== 'string' || !path || path.length > 240 || path !== path.normalize('NFC') ||
    /[\\:%?#\x00-\x20\x7f]/.test(path) || path.startsWith('/') ||
    path.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_PATH');
}
export function identityOf(p: PackageIdentity): PackageIdentity {
  return { packageId: p.packageId, revisionId: p.revisionId, packageHash: p.packageHash };
}
export function sameIdentity(a: PackageIdentity, b: PackageIdentity): boolean {
  return a.packageId === b.packageId && a.revisionId === b.revisionId && a.packageHash === b.packageHash;
}
/** Integrity binds identity, complete inventory, and the host's reviewed resource plan. */
export function packageHash(p: Omit<PackageDescriptor, 'packageHash'>): string {
  return sha256(JSON.stringify({
    packageId: p.packageId, revisionId: p.revisionId, directoryName: p.directoryName,
    files: [...p.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map(f => [f.path, f.bytes, f.mediaType, f.sha256, [...f.requires].sort()]),
    tasks: Object.keys(p.tasks).sort().map(key => [key, [...p.tasks[key]].sort()]),
    requiredCapabilities: [...p.requiredCapabilities].sort(),
  }));
}
export function validateDescriptor(input: unknown): PackageDescriptor {
  const parsed = descriptorSchema.safeParse(input);
  if (!parsed.success) fail('INVALID_PACKAGE');
  const p = parsed.data;
  const paths = new Set<string>();
  for (const file of p.files) {
    assertPath(file.path);
    // Local text-only host: optional scripts/binaries need a different reviewed host.
    if (!file.path.endsWith('.md') || file.path.split('/').includes('scripts')) fail('UNSUPPORTED_CAPABILITY');
    const key = file.path.toLowerCase();
    if (paths.has(key)) fail('AMBIGUOUS_IDENTITY');
    paths.add(key);
  }
  if (!p.files.some(f => f.path === 'SKILL.md')) fail('RESOURCE_MISSING');
  for (const path of [...p.files.flatMap(f => f.requires), ...Object.values(p.tasks).flat()]) {
    assertPath(path);
    if (!p.files.some(f => f.path === path)) fail('RESOURCE_MISSING');
  }
  if (p.files.reduce((sum, f) => sum + f.bytes, 0) > 2 * 1024 * 1024 || Object.keys(p.tasks).length > 64) fail('CAPACITY_EXCEEDED');
  if (p.requiredCapabilities.some(c => c !== 'documents.read')) fail('UNSUPPORTED_CAPABILITY');
  if (packageHash(p) !== p.packageHash) fail('INTEGRITY_MISMATCH');
  return p;
}
async function enabled(source: SkillSource, identity: PackageIdentity): Promise<void> {
  if (await guarded(() => source.state(identity)) !== 'enabled') fail('UNAVAILABLE');
}
async function readVerified(source: SkillSource, p: PackageDescriptor, path: string): Promise<string> {
  const file = p.files.find(f => f.path === path);
  if (!file) fail('RESOURCE_MISSING');
  await enabled(source, p);
  const bytes = await guarded(() => source.read({ ...identityOf(p), path }, file.bytes));
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) fail('INTEGRITY_MISMATCH');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('INVALID_FORMAT'); }
}
function metadataFor(entry: string, p: PackageDescriptor) {
  const parsed = parseSkillEntry(entry, p.directoryName);
  if (!parsed.report.standard.valid || !parsed.metadata) fail('INVALID_FORMAT');
  if (!parsed.report.compatibility.supported) fail('UNSUPPORTED_CAPABILITY');
  return parsed.metadata;
}
export interface PublicSkill { packageId: string; revisionId: string; name: string; description: string }
export interface DiscoveredSkill { selection: PackageIdentity; public: PublicSkill }
async function inventory(source: SkillSource): Promise<PackageDescriptor[]> {
  const entries = await guarded(() => source.list());
  if (entries.length > 256) fail('CAPACITY_EXCEEDED');
  const keys = new Set<string>();
  return entries.map(entry => {
    const p = validateDescriptor(entry);
    const key = JSON.stringify([p.packageId, p.revisionId]);
    if (keys.has(key)) fail('AMBIGUOUS_IDENTITY');
    keys.add(key); return p;
  });
}
export async function discoverSkills(source: SkillSource): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = [];
  for (const p of await inventory(source)) {
    if (await guarded(() => source.state(p)) !== 'enabled') continue;
    const metadata = metadataFor(await readVerified(source, p, 'SKILL.md'), p);
    await enabled(source, p);
    discovered.push({ selection: identityOf(p), public: { packageId: p.packageId, revisionId: p.revisionId, ...metadata } });
  }
  return discovered;
}
/** Private context cannot be serialized accidentally by JSON or ordinary inspection. */
export class LoadedSkill {
  #context: string;
  #records: readonly ResourceIdentity[];
  #public: PublicSkill;
  constructor(context: string, records: ResourceIdentity[], projection: PublicSkill) {
    this.#context = context; this.#records = records; this.#public = projection;
  }
  forModel(): string { return this.#context; }
  resourceIdentities(): readonly ResourceIdentity[] { return this.#records.map(r => ({ ...r })); }
  toJSON(): PublicSkill { return { ...this.#public }; }
  [inspect.custom]() { return this.toJSON(); }
}
/** Host selects a reviewed task plan; no name guessing, markdown execution, or model tool loop. */
export async function activateSkill(source: SkillSource, selection: PackageIdentity, options: { task?: string; maxContextBytes: number }): Promise<LoadedSkill> {
  const selected = identitySchema.safeParse(selection);
  if (!selected.success) fail('INVALID_IDENTITY');
  if (!Number.isSafeInteger(options.maxContextBytes) || options.maxContextBytes < 1 || options.maxContextBytes > 2 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
  const p = (await inventory(source)).find(candidate => sameIdentity(candidate, selected.data));
  if (!p) fail('UNAVAILABLE');
  await enabled(source, p);
  let roots: string[] = [];
  if (Object.keys(p.tasks).length) {
    if (!options.task || !Object.hasOwn(p.tasks, options.task)) fail('INVALID_IDENTITY');
    roots = p.tasks[options.task];
  } else if (options.task !== undefined) fail('INVALID_IDENTITY');
  const paths = new Set<string>();
  const visit = (path: string) => {
    if (paths.has(path)) return;
    paths.add(path);
    const file = p.files.find(f => f.path === path);
    if (!file) fail('RESOURCE_MISSING');
    file.requires.forEach(visit);
  };
  ['SKILL.md', ...roots].forEach(visit);
  // Fail before reading methods when even the raw method bytes cannot fit.
  if ([...paths].reduce((sum, path) => sum + p.files.find(f => f.path === path)!.bytes, 0) > options.maxContextBytes) fail('CAPACITY_EXCEEDED');
  const entry = await readVerified(source, p, 'SKILL.md');
  const metadata = metadataFor(entry, p);
  const sections: { path: string; content: string }[] = [];
  for (const path of paths) sections.push({ path, content: path === 'SKILL.md' ? entry : await readVerified(source, p, path) });
  // JSON encoding gives explicit boundaries without trusting markup in private files.
  const context = JSON.stringify({ skill: identityOf(p), resources: sections });
  if (Buffer.byteLength(context, 'utf8') > options.maxContextBytes) fail('CAPACITY_EXCEEDED');
  await enabled(source, p);
  return new LoadedSkill(context, [...paths].map(path => ({ ...identityOf(p), path })), { packageId: p.packageId, revisionId: p.revisionId, ...metadata });
}
