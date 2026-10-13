/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activateSkill, identityOf, packageHash, sha256, type PackageDescriptor } from "../skills/loader";
import { validatePublication } from "../skills/publication";

// FUSION-REVIEW PR-0: positioning Skill v13 only removes "the review panel may search the web".
const root = resolve(import.meta.dirname, "../../../../../docs/skill-candidates/positioning-mentor-v13");
const privateRoot = process.env.V3_MENTOR_SKILL_V13;
const directoryName = "social-media-commercial-strategist";
const packageId = "4edbbee8-840b-4322-a01f-c8d49e36e1a8";
const v12 = { revisionId: "0479891f-a1e9-4b44-9596-9c2f67ec406b", packageHash: "a8528efd05f7bf8ca4a835ba9ab03f45a2e2d24a594ab50efa03794b1b56a7d6" };
type Entry = { path: string; mediaType: "text/markdown" | "text/yaml"; requires: string[];
  beforeSha256: string; beforeBytes: number; sha256: string; bytes: number; changed: boolean };
const inventory = JSON.parse(readFileSync(resolve(root, "file-hashes.json"), "utf8")) as Entry[];
const files = privateRoot ? inventory.map(file => ({ path: file.path, bytes: readFileSync(resolve(privateRoot, file.path)) })) : [];
const rubric = "references/review-rubric.md";

function descriptor(revisionId: string, side: "before" | "after"): PackageDescriptor {
  const d: PackageDescriptor = { packageId, revisionId, packageHash: "", directoryName, tasks: {}, requiredCapabilities: ["documents.read"],
    files: inventory.map(f => ({ path: f.path, mediaType: f.mediaType, requires: f.requires,
      bytes: side === "before" ? f.beforeBytes : f.bytes, sha256: side === "before" ? f.beforeSha256 : f.sha256 })) };
  d.packageHash = packageHash(d);
  return d;
}

describe("positioning Skill v13 candidate (review panel does not search the web)", () => {
  it("changes only the review rubric and reproduces the frozen v12 identity exactly", () => {
    expect(inventory).toHaveLength(23);
    expect(inventory.filter(f => f.changed).map(f => f.path)).toEqual([rubric]);
    expect(inventory.filter(f => !f.changed).every(f => f.sha256 === f.beforeSha256 && f.bytes === f.beforeBytes)).toBe(true);
    // Drafts frozen on v12 bind this identity; v13 must not alter it.
    expect(descriptor(v12.revisionId, "before").packageHash).toBe(v12.packageHash);
    const v13 = descriptor(randomUUID(), "after");
    expect(v13.packageHash).not.toBe(v12.packageHash);
    expect(descriptor(v12.revisionId, "before").packageHash).toBe(v12.packageHash);
  });
  it.skipIf(!privateRoot)("validates through the real publication path and loads the revised rubric", async () => {
    for (const file of files) expect(sha256(file.bytes)).toBe(inventory.find(f => f.path === file.path)!.sha256);
    const d = descriptor(randomUUID(), "after");
    const p = { id: packageId, revisionId: d.revisionId, requestId: randomUUID(), expectedVersion: 12, resourcePlanReviewed: true as const,
      descriptor: d, files: files.map(f => ({ path: f.path, base64: f.bytes.toString("base64") })) };
    expect(validatePublication(p).descriptor).toEqual(d);
    const loaded = await activateSkill({ list: async () => [d], state: async () => "enabled",
      read: async ({ path }) => files.find(f => f.path === path)!.bytes }, identityOf(d), { resources: [rubric], maxContextBytes: 64000 });
    const text = (JSON.parse(loaded.forModel()).resources as { path: string; content: string }[]).find(r => r.path === rubric)!.content;
    expect(text).not.toContain("评审团可以联网");
    expect(text).toContain("评审不联网");
    expect(text).toContain("待核实");
    // R11 (Owner 2026-10-12): three qualified benchmarks remain a completion gate.
    expect(text).toContain("至少 3 个合格账号");
  });
});
