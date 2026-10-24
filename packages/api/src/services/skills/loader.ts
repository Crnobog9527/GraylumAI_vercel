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
  sha256: hash, mediaType: z.enum(['text/markdown', 'text/yaml']), requires: z.array(z.string()).max(64),
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
  /** DB-PERF PR-4: one fresh check of current access and, in the same call, the bytes of every listed file of this
   * exact package. An empty list is the check alone. Refuses (UNAVAILABLE) whenever state() would not be 'enabled'. */
  readMany?(identity: PackageIdentity, files: readonly { path: string; bytes: number }[]): Promise<ReadonlyMap<string, Uint8Array>>;
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
  return sha256(packageHashPayload(p));
}
export function packageHashPayload(p: Omit<PackageDescriptor, 'packageHash'>): string {
  return JSON.stringify({
    packageId: p.packageId, revisionId: p.revisionId, directoryName: p.directoryName,
    files: [...p.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map(f => [f.path, f.bytes, f.mediaType, f.sha256, [...f.requires].sort()]),
    tasks: Object.keys(p.tasks).sort().map(key => [key, [...p.tasks[key]].sort()]),
    requiredCapabilities: [...p.requiredCapabilities].sort(),
  });
}
export function validateDescriptor(input: unknown): PackageDescriptor {
  const parsed = descriptorSchema.safeParse(input);
  if (!parsed.success) fail('INVALID_PACKAGE');
  const p = parsed.data;
  const paths = new Set<string>();
  for (const file of p.files) {
    assertPath(file.path);
    // Read-only text resources. YAML is supplied as text, never parsed or executed.
    if (!(/\.(md|ya?ml)$/.test(file.path)) || file.path.split('/').includes('scripts')) fail('UNSUPPORTED_CAPABILITY');
    if (file.mediaType !== (file.path.endsWith('.md') ? 'text/markdown' : 'text/yaml')) fail('INVALID_FORMAT');
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
/** AC-0c: process-local, bounded cache of verified resource text. A published
 * revision's files never change, and the validated packageHash binds each
 * path to its sha256, so an entry keyed by that whole identity can only hold
 * the exact verified bytes. Authorization is never cached: every activation
 * still checks state before use and again before returning.
 * Limits: at most 256 files and 16 MiB in total, least recently used evicted
 * first; a file above 1 MiB is never cached and is read on every use. Entries
 * are immutable strings, so no caller can change cached content. The cache is
 * per process: each server instance keeps its own and nothing is shared. */
const RESOURCE_CACHE_ENTRIES = 256, RESOURCE_CACHE_BYTES = 16 * 1024 * 1024, RESOURCE_CACHE_FILE_BYTES = 1024 * 1024;
const resourceCache = new Map<string, { text: string; bytes: number }>();
let resourceCacheBytes = 0;
/** Test isolation only. */
export function clearSkillResourceCache(): void { resourceCache.clear(); resourceCacheBytes = 0; descriptorCache.clear(); }
function cacheResource(key: string, text: string, bytes: number) {
  if (bytes > RESOURCE_CACHE_FILE_BYTES) return;
  // Concurrent misses may fill the same key; count its bytes only once.
  const replaced = resourceCache.get(key);
  if (replaced) { resourceCache.delete(key); resourceCacheBytes -= replaced.bytes; }
  resourceCache.set(key, { text, bytes }); resourceCacheBytes += bytes;
  for (const [oldest, entry] of resourceCache) {
    if (resourceCache.size <= RESOURCE_CACHE_ENTRIES && resourceCacheBytes <= RESOURCE_CACHE_BYTES) break;
    resourceCache.delete(oldest); resourceCacheBytes -= entry.bytes;
  }
}
type PackageFile = PackageDescriptor['files'][number];
function fileOf(p: PackageDescriptor, path: string): PackageFile {
  const file = p.files.find(f => f.path === path);
  if (!file) fail('RESOURCE_MISSING');
  return file;
}
function cachedText(p: PackageDescriptor, file: PackageFile): string | undefined {
  const key = JSON.stringify([p.packageId, p.revisionId, p.packageHash, file.path, file.sha256, file.bytes]);
  const cached = resourceCache.get(key);
  if (!cached) return undefined;
  resourceCache.delete(key); resourceCache.set(key, cached); return cached.text;
}
function verifiedText(p: PackageDescriptor, file: PackageFile, bytes: Uint8Array): string {
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) fail('INTEGRITY_MISMATCH');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('INVALID_FORMAT'); }
  cacheResource(JSON.stringify([p.packageId, p.revisionId, p.packageHash, file.path, file.sha256, file.bytes]), text, bytes.byteLength);
  return text;
}
async function readVerified(source: SkillSource, p: PackageDescriptor, path: string): Promise<string> {
  const file = fileOf(p, path);
  const cached = cachedText(p, file);
  if (cached !== undefined) return cached;
  // A source read still requires current access immediately before it.
  await enabled(source, p);
  return verifiedText(p, file, await guarded(() => source.read({ ...identityOf(p), path }, file.bytes)));
}
/** DB-PERF PR-4: the texts of `paths` from a batch source, with exactly one fresh access check. Cached files are not
 * read again, but the check is always made, even when every file is cached; the uncached files arrive in that same
 * checked call. It is the last remote step before the caller hands the texts on, so it stands for both AC-0c checks
 * (before private reads and before returning): only in-memory assembly follows it. */
async function checkedTexts(source: SkillSource, p: PackageDescriptor, paths: readonly string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>(), missing: PackageFile[] = [];
  for (const path of new Set(paths)) {
    const file = fileOf(p, path), cached = cachedText(p, file);
    if (cached === undefined) missing.push(file); else texts.set(path, cached);
  }
  const read = await guarded(() => source.readMany!(identityOf(p), missing.map(f => ({ path: f.path, bytes: f.bytes }))));
  for (const file of missing) {
    const bytes = read.get(file.path);
    if (!bytes) fail('SOURCE_FAILURE');
    texts.set(file.path, verifiedText(p, file, bytes));
  }
  return texts;
}
/** A batch source's reply: exactly the requested files, base64 encoded (read_skill_package with p_paths, 0347). */
export function batchFiles(data: unknown, files: readonly { path: string }[]): Map<string, Uint8Array> {
  const read = (data as { files?: unknown } | null)?.files;
  if (!read || typeof read !== 'object' || Array.isArray(read)) fail('SOURCE_FAILURE');
  const entries = Object.entries(read as Record<string, unknown>);
  if (entries.length !== new Set(files.map(f => f.path)).size || entries.some(([path, value]) =>
    typeof value !== 'string' || !files.some(f => f.path === path))) fail('SOURCE_FAILURE');
  return new Map(entries.map(([path, value]) => [path, Buffer.from(value as string, 'base64')]));
}
/** The total bytes a batch read may return. */
export function batchBytes(files: readonly { bytes: number }[]): number { return files.reduce((sum, f) => sum + f.bytes, 0); }

/** DB-PERF PR-4: process-local cache of validated descriptors by exact identity. A revision's package never changes and
 * validateDescriptor binds the descriptor to its packageHash, so a hit can only be the same descriptor. Only sources whose
 * identity is already frozen with its packageHash use it, and only for list(): every loader path checks current access
 * after a listing and before any private content leaves it, so a cached listing never stands in for a check. */
const DESCRIPTOR_CACHE_ENTRIES = 256;
const descriptorCache = new Map<string, PackageDescriptor>();
export async function frozenDescriptor(identity: PackageIdentity, load: () => Promise<unknown>): Promise<PackageDescriptor> {
  const key = JSON.stringify([identity.packageId, identity.revisionId, identity.packageHash]);
  const cached = descriptorCache.get(key);
  if (cached) { descriptorCache.delete(key); descriptorCache.set(key, cached); return structuredClone(cached); }
  const descriptor = validateDescriptor(await load());
  if (!sameIdentity(descriptor, identity)) fail('UNAVAILABLE');
  descriptorCache.set(key, structuredClone(descriptor));
  for (const oldest of descriptorCache.keys()) { if (descriptorCache.size <= DESCRIPTOR_CACHE_ENTRIES) break; descriptorCache.delete(oldest); }
  return descriptor;
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
    let entry: string;
    if (source.readMany) {
      // One checked call; a refusal skips the package as a non-enabled state did.
      try { entry = (await checkedTexts(source, p, ['SKILL.md'])).get('SKILL.md')!; }
      catch (error) { if (error instanceof SkillLoadError && error.code === 'UNAVAILABLE') continue; throw error; }
    } else {
      if (await guarded(() => source.state(p)) !== 'enabled') continue;
      entry = await readVerified(source, p, 'SKILL.md');
    }
    const metadata = metadataFor(entry, p);
    if (!source.readMany) await enabled(source, p);
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
export async function activateSkill(source: SkillSource, selection: PackageIdentity, options: { task?: string; resources?: readonly string[]; maxContextBytes: number }): Promise<LoadedSkill> {
  const selected = identitySchema.safeParse(selection);
  if (!selected.success) fail('INVALID_IDENTITY');
  if (!Number.isSafeInteger(options.maxContextBytes) || options.maxContextBytes < 1 || options.maxContextBytes > 2 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
  const p = (await inventory(source)).find(candidate => sameIdentity(candidate, selected.data));
  if (!p) fail('UNAVAILABLE');
  const batch = Boolean(source.readMany);
  if (!batch) await enabled(source, p);
  let roots: string[] = [];
  // Only the trusted workflow host supplies resources, from the immutable,
  // validated round. This does not change package identity or legacy task selection.
  if (options.resources !== undefined) {
    if (options.task !== undefined || options.resources.length < 1 || options.resources.length > 64) fail('INVALID_IDENTITY');
    roots = [...options.resources];
    roots.forEach(assertPath);
  } else if (Object.keys(p.tasks).length) {
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
  // A batch source checks access and returns every uncached file in one call (checkedTexts). Otherwise a small
  // bounded batch avoids serial network waits without flooding the database: readVerified still checks current
  // access before each uncached private read, and the fresh check below covers the whole assembled context.
  const texts = batch ? await checkedTexts(source, p, [...paths]) : undefined;
  const entry = texts?.get('SKILL.md') ?? await readVerified(source, p, 'SKILL.md');
  const metadata = metadataFor(entry, p);
  const methods = await readResourceBatch([...paths].filter(path => path !== 'SKILL.md'),
    async path => ({path, content: texts?.get(path) ?? await readVerified(source, p, path)}));
  const sections = [{path: 'SKILL.md', content: entry}, ...methods];
  // JSON encoding gives explicit boundaries without trusting markup in private files.
  const context = JSON.stringify({ skill: identityOf(p), resources: sections });
  if (Buffer.byteLength(context, 'utf8') > options.maxContextBytes) fail('CAPACITY_EXCEEDED');
  if (!batch) await enabled(source, p);
  return new LoadedSkill(context, [...paths].map(path => ({ ...identityOf(p), path })), { packageId: p.packageId, revisionId: p.revisionId, ...metadata });
}

/** Read one host-selected resource without exposing the rest of the private Skill to another model. */
export async function readSkillResource(source: SkillSource, selection: PackageIdentity,
  path: string, maxBytes: number): Promise<string> {
  if (!identitySchema.safeParse(selection).success) fail('INVALID_IDENTITY');
  assertPath(path);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
  const p = (await inventory(source)).find(candidate => sameIdentity(candidate, selection));
  if (!p) fail('UNAVAILABLE');
  if (!source.readMany) await enabled(source, p);
  const file = p.files.find(item => item.path === path);
  if (!file) fail('RESOURCE_MISSING');
  if (file.bytes > maxBytes) fail('CAPACITY_EXCEEDED');
  // A batch source: one checked call, even on a cache hit (checkedTexts).
  if (source.readMany) return (await checkedTexts(source, p, [path])).get(path)!;
  const text = await readVerified(source, p, path);
  await enabled(source, p);
  return text;
}

/** At most four concurrent reads; preserve descriptor order and wait for the
 * whole batch even on refusal, so no private work outlives admission. */
export async function readResourceBatch<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    const batch = await Promise.allSettled(items.slice(offset, offset + 4).map(read));
    const failure = batch.find(row => row.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    for (const row of batch) if (row.status === 'fulfilled') result.push(row.value);
  }
  return result;
}
