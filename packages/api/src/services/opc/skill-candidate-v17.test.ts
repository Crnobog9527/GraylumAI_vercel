/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { activateSkill, identityOf, packageHash, sha256, type PackageDescriptor } from '../skills/loader';
import { validatePublication } from '../skills/publication';

const root = resolve(import.meta.dirname, '../../../../../docs/skill-candidates/positioning-mentor-v17');
const privateRoot = process.env.V3_MENTOR_SKILL_V17;
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

describe('positioning Skill v17 candidate', () => {
  it('pins published v16 as its base and limits changes to the requested files', () => {
    expect(manifest).toMatchObject({
      baseVersion: 16,
      baseRevisionId: 'a4efef7e-471d-427c-9c5e-0eb2642d8d4b',
      expectedVersion: 16,
    });
    expect(inventory).toHaveLength(23);
    expect(inventory.filter(file => file.changed).map(file => file.path).sort())
      .toEqual(['EVALS.md', 'README.md', 'SKILL.md', 'assets/report-template.md', 'references/02-benchmark-analysis.md',
        'references/reporting.md']);
    expect(inventory.filter(file => !file.changed).every(file => file.sha256 === file.beforeSha256
      && file.bytes === file.beforeBytes)).toBe(true);
    const revisionId = randomUUID();
    expect(descriptor('before', revisionId).packageHash).not.toBe(descriptor('after', revisionId).packageHash);
  });

  it.skipIf(!privateRoot)('validates v17 publication and its benchmark guidance', async () => {
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
    // v16 guidance stays; the shortfall choice (Owner 2026-10-20, B) is added.
    expect(guide).toContain('活跃度待核对');
    expect(guide).toContain('已找到 N 个可选、需要 8 个');
    expect(guide).toContain('搜了两轮还不够：选择卡');
    expect(guide).toContain('"继续找对标"（推荐）');
    expect(guide).toContain('不要提预计消耗多少积分');
    expect(guide).toContain('hostTurnContext.research.shortfall');
    expect(guide).toContain('一个合格的都没有时，不会出这张卡，也不能生成报告');
    const template = files.find(file => file.path === 'assets/report-template.md')!.bytes.toString('utf8');
    expect(template).toContain('对标样本不足');
    expect(template.split('\n').filter(line => line.startsWith('## ')).length).toBe(14);
  });
});
