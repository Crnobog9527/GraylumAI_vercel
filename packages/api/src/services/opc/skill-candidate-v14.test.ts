/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activateSkill, identityOf, packageHash, sha256, type PackageDescriptor } from "../skills/loader";
import { validatePublication } from "../skills/publication";
import { reportManifest } from "../report/contract";
import { POSITIONING_RESEARCH_TOOLS } from "../research/tools/schemas";

// RESEARCH-TOOLS RT-6: positioning Skill v14 uses the research tools for the benchmark step.
const root = resolve(import.meta.dirname, "../../../../../docs/skill-candidates/positioning-mentor-v14");
const privateRoot = process.env.V3_MENTOR_SKILL_V14;
const directoryName = "social-media-commercial-strategist";
const packageId = "4edbbee8-840b-4322-a01f-c8d49e36e1a8";
// staging v13 (FUSION-REVIEW PR-0), read back 2026-10-17: every file hash matched the private copy.
const v13 = { revisionId: "eae22201-461e-44b9-b191-c3d034ccbf53", packageHash: "72af5b86dbb182a78dd4c5d1049bf1819aab22c8dc0e9e0592001adcb6e5b371" };
type Entry = { path: string; mediaType: "text/markdown" | "text/yaml"; requires: string[];
  beforeSha256: string; beforeBytes: number; sha256: string; bytes: number; changed: boolean };
const inventory = JSON.parse(readFileSync(resolve(root, "file-hashes.json"), "utf8")) as Entry[];
const files = privateRoot ? inventory.map(file => ({ path: file.path, bytes: readFileSync(resolve(privateRoot, file.path)) })) : [];
const changed = ["EVALS.md", "README.md", "SKILL.md", "references/01-discovery.md", "references/02-benchmark-analysis.md",
  "references/research-policy.md", "workflow.yaml"];

function descriptor(revisionId: string, side: "before" | "after"): PackageDescriptor {
  const d: PackageDescriptor = { packageId, revisionId, packageHash: "", directoryName, tasks: {}, requiredCapabilities: ["documents.read"],
    files: inventory.map(f => ({ path: f.path, mediaType: f.mediaType, requires: f.requires,
      bytes: side === "before" ? f.beforeBytes : f.bytes, sha256: side === "before" ? f.beforeSha256 : f.sha256 })) };
  d.packageHash = packageHash(d);
  return d;
}
const text = (path: string) => files.find(f => f.path === path)!.bytes.toString("utf8");

describe("positioning Skill v14 candidate (benchmark research tools)", () => {
  it("changes only the listed files and reproduces the frozen staging v13 identity exactly", () => {
    expect(inventory).toHaveLength(23);
    expect(inventory.filter(f => f.changed).map(f => f.path)).toEqual(changed);
    expect(inventory.filter(f => !f.changed).every(f => f.sha256 === f.beforeSha256 && f.bytes === f.beforeBytes)).toBe(true);
    // Drafts frozen on v13 bind this identity; v14 must not alter it.
    expect(descriptor(v13.revisionId, "before").packageHash).toBe(v13.packageHash);
    expect(descriptor(randomUUID(), "after").packageHash).not.toBe(v13.packageHash);
  });

  it.skipIf(!privateRoot)("validates through the real publication path and carries the research rules", async () => {
    for (const file of files) expect(sha256(file.bytes)).toBe(inventory.find(f => f.path === file.path)!.sha256);
    const d = descriptor(randomUUID(), "after");
    const p = { id: packageId, revisionId: d.revisionId, requestId: randomUUID(), expectedVersion: 13, resourcePlanReviewed: true as const,
      descriptor: d, files: files.map(f => ({ path: f.path, base64: f.bytes.toString("base64") })) };
    expect(validatePublication(p).descriptor).toEqual(d);
    const benchmark = "references/02-benchmark-analysis.md";
    const loaded = await activateSkill({ list: async () => [d], state: async () => "enabled",
      read: async ({ path }) => files.find(f => f.path === path)!.bytes }, identityOf(d), { resources: [benchmark], maxContextBytes: 90000 });
    const guide = (JSON.parse(loaded.forModel()).resources as { path: string; content: string }[]).find(r => r.path === benchmark)!.content;
    // Every tool the guide names exists with that exact name; the old "search without confirming" rule is gone.
    for (const name of guide.match(/`([a-z_]+)`/g)!.map(m => m.slice(1, -1)).filter(n => /^(propose|benchmark)_/.test(n))) {
      expect(POSITIONING_RESEARCH_TOOLS).toContain(name);
    }
    for (const name of ["propose_keywords", "benchmark_discover", "benchmark_fetch", "propose_more_candidates"]) expect(guide).toContain(name);
    expect(guide).not.toContain("有搜索工具时不用等用户");
    expect(guide).toContain("用户在卡片上确认之前不要搜");
    expect(guide).toContain("hostTurnContext.research");
    expect(guide).toContain('{kind:"user_message"}');
    expect(guide).toContain('{kind:"candidate", confirmationId}');
    expect(guide).toContain("没有\"跳过\"这个选项");
    expect(guide).toContain("1 万到 20 万");
    expect(guide).toContain("30 天内");
    // R11: three qualified benchmarks stay a completion gate, now also declared for the report.
    expect(text("SKILL.md")).toContain("至少凑够 3 个");
    expect(text("SKILL.md")).toContain('version: "2.7.0"');
    // Owner 2026-10-17: the user-facing self-reference is "AI 教练"; "导师" survives only in the rule forbidding it.
    expect(text("SKILL.md")).toContain("# 社交媒体账号定位 AI 教练");
    expect(text("SKILL.md").split("\n").filter(line => line.includes("导师"))).toEqual([expect.stringContaining("不要自称\"导师\"")]);
    expect(text("workflow.yaml")).not.toContain("导师");
    const workflow = JSON.parse(text("workflow.yaml")) as { reportGeneration: unknown; steps: { resources: string[] }[] };
    expect(reportManifest.parse(workflow.reportGeneration).minQualifiedBenchmarks).toBe(3);
    expect(workflow.steps[1]!.resources).toContain(benchmark);
  });
});
