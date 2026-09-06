import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  assertPath, fail, guarded, identityOf, sameIdentity, validateDescriptor,
  type ExecutionState, type PackageDescriptor, type PackageIdentity, type ResourceIdentity, type SkillSource,
} from './loader';

export interface LocalPackage { root: string; descriptor: PackageDescriptor }
/** Local/test adapter only. Roots are operator-controlled, never request parameters.
 * The descriptor comes from reviewed immutable inventory, not hashes regenerated on read.
 * A database adapter must enforce the same port using its own current authorization.
 */
export class LocalSkillSource implements SkillSource {
  #packages: LocalPackage[];
  #state: (identity: PackageIdentity) => Promise<ExecutionState>;
  constructor(packages: readonly LocalPackage[], state: (identity: PackageIdentity) => Promise<ExecutionState>) {
    this.#packages = packages.map(p => ({ root: p.root, descriptor: validateDescriptor(p.descriptor) }));
    this.#state = state;
  }
  async list(): Promise<PackageDescriptor[]> { return structuredClone(this.#packages.map(p => p.descriptor)); }
  async state(identity: PackageIdentity): Promise<ExecutionState> {
    this.#resolve(identity);
    return guarded(() => this.#state(identityOf(identity)));
  }
  #resolve(identity: PackageIdentity): LocalPackage {
    const matches = this.#packages.filter(p => sameIdentity(p.descriptor, identity));
    if (matches.length > 1) fail('AMBIGUOUS_IDENTITY');
    if (!matches.length) fail('UNAVAILABLE');
    return matches[0];
  }
  async read(identity: ResourceIdentity, maxBytes: number): Promise<Uint8Array> {
    return guarded(async () => {
      assertPath(identity.path);
      const pkg = this.#resolve(identity);
      if (await this.state(identity) !== 'enabled') fail('UNAVAILABLE');
      const resource = pkg.descriptor.files.find(f => f.path === identity.path);
      if (!resource) fail('RESOURCE_MISSING');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < resource.bytes) fail('CAPACITY_EXCEEDED');
      const rootStat = await lstat(pkg.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('INVALID_PATH');
      const root = await realpath(pkg.root);
      let target = root;
      const parts = identity.path.split('/');
      for (const [index, part] of parts.entries()) {
        target = join(target, part);
        const stat = await lstat(target).catch(() => fail('RESOURCE_MISSING'));
        if (stat.isSymbolicLink()) fail('INVALID_PATH');
        if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail('INVALID_PATH');
      }
      const canonical = await realpath(target);
      const contained = relative(root, canonical);
      if (contained.startsWith(`..${sep}`) || contained === '..' || !contained) fail('INVALID_PATH');
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1) fail('INVALID_PATH');
        if (before.size !== resource.bytes) fail('INTEGRITY_MISMATCH');
        // Bound allocation and detect both short reads and unexpected trailing bytes.
        const buffer = Buffer.alloc(resource.bytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (offset !== resource.bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('INTEGRITY_MISMATCH');
        if (await realpath(target) !== canonical) fail('INVALID_PATH');
        if (await this.state(identity) !== 'enabled') fail('UNAVAILABLE');
        return buffer.subarray(0, offset);
      } finally { await handle.close(); }
    });
  }
}
