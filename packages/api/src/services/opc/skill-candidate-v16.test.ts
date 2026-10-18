/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { activateSkill, identityOf, packageHash, sha256, type PackageDescriptor } from '../skills/loader';
import { validatePublication } from '../skills/publication';

const root = resolve(import.meta.dirname, '../../../../../docs/skill-candidates/positioning-mentor-v16');
const privateRoot = process.env.V3_MENTOR_SKILL_V16;
const manifest = JSON.parse(readFileSync(resolve(root, 'file-hashes.json'), 'utf8')) as {
  baseVersion: number; baseRevisionId: string; expectedVersion: number;
  files: { path: string; mediaType: 'text/markdown' | 'text/yaml'; requires: string[];
    beforeSha256: string; beforeBytes: number; sha256: string; bytes: number; changed: boolean }[];
};
const inventory = manifest.files;
const files = privateRoot ? inventory.map(file => ({ path: file.path, bytes: readFileSync(resolve(privateRoot, file.path)) })) : [];

function descriptor(side: 'before' | 'after', revisionId: string): PackageDescriptor {
  const value: PackageDescriptor = {
    packageId: '4edbbee8-840b-4322-a01f-c8d49e36e1a8', revisionId, packageHash: '',
    directoryName: 'social-media-commercial-strategist', tasks: {}, requiredCapabilities: ['documents.read'],
    files: inventory.map(file => ({ path: file.path, mediaType: file.mediaType, requires: file.requires,
      bytes: side === 'before' ? file.beforeBytes : file.bytes,
      sha256: side === 'before' ? file.beforeSha256 : file.sha256 })),
  };
  value.packageHash = packageHash(value);
  return value;
}

describe('positioning Skill v16 candidate', () => {
  it('pins published v15 as its base and limits changes to the requested files', () => {
    expect(manifest).toMatchObject({
      baseVersion: 15,
      baseRevisionId: '1ec66964-517f-4709-a9fd-dea7b7f8de63',
      expectedVersion: 15,
    });
    expect(inventory).toHaveLength(23);
    expect(inventory.filter(file => file.changed).map(file => file.path).sort())
      .toEqual(['README.md', 'SKILL.md', 'references/02-benchmark-analysis.md']);
    expect(inventory.filter(file => !file.changed).every(file => file.sha256 === file.beforeSha256
      && file.bytes === file.beforeBytes)).toBe(true);
    const revisionId = randomUUID();
    expect(descriptor('before', revisionId).packageHash).not.toBe(descriptor('after', revisionId).packageHash);
  });

  it.skipIf(!privateRoot)('validates v16 publication and its benchmark guidance', async () => {
    for (const file of files) expect(sha256(file.bytes)).toBe(inventory.find(entry => entry.path === file.path)!.sha256);
    const d = descriptor('after', randomUUID());
    const publication = {
      id: d.packageId, revisionId: d.revisionId, requestId: randomUUID(), expectedVersion: manifest.expectedVersion,
      resourcePlanReviewed: true as const, descriptor: d,
      files: files.map(file => ({ path: file.path, base64: file.bytes.toString('base64') })),
    };
    expect(validatePublication(publication).descriptor).toEqual(d);
    const loaded = await activateSkill({ list: async () => [d], state: async () => 'enabled',
      read: async ({ path }) => files.find(file => file.path === path)!.bytes }, identityOf(d), {
      resources: ['references/02-benchmark-analysis.md'], maxContextBytes: 90000,
    });
    const guide = (JSON.parse(loaded.forModel()).resources as { path: string; content: string }[])
      .find(resource => resource.path === 'references/02-benchmark-analysis.md')!.content;
    expect(guide).toContain('活跃度待核对');
    expect(guide).toContain('数据已取到、只是可选账号不够');
    expect(guide).toContain('已找到 N 个可选、需要 8 个');
    expect(guide).toContain('不要说“没取到数据”');
  });
});
