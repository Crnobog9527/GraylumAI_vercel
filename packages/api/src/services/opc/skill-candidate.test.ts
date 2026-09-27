/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activateSkill, identityOf, packageHash, sha256, type PackageDescriptor } from "../skills/loader";
import { validatePublication } from "../skills/publication";

const root = resolve(import.meta.dirname, "../../../../../docs/skill-candidates/positioning-mentor-v3");
const privateRoot = process.env.V3_MENTOR_SKILL_CANDIDATE;
const directoryName = "social-media-commercial-strategist";
const inventory = JSON.parse(readFileSync(resolve(root, "file-hashes.json"), "utf8")) as {
  path: string; beforeSha256: string; sha256: string; bytes: number; changed: boolean;
}[];
const files = privateRoot ? inventory.map(file => ({ path: file.path, bytes: readFileSync(resolve(privateRoot, directoryName, file.path)) })) : [];
function candidate() {
  const descriptor: PackageDescriptor = {
    packageId: "4edbbee8-840b-4322-a01f-c8d49e36e1a8", revisionId: randomUUID(), packageHash: "", directoryName,
    files: inventory.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, mediaType: file.path.endsWith(".md") ? "text/markdown" : "text/yaml", requires: [] })),
    tasks: {}, requiredCapabilities: ["documents.read"],
  };
  descriptor.packageHash = packageHash(descriptor);
  return { id: descriptor.packageId, revisionId: descriptor.revisionId, requestId: randomUUID(), expectedVersion: 2, resourcePlanReviewed: true as const,
    descriptor, files: files.map(file => ({ path: file.path, base64: file.bytes.toString("base64") })) };
}

describe("unpublished positioning mentor Skill candidate", () => {
  it("records a bounded two-file candidate without exposing private content in CI", () => {
    expect(inventory).toHaveLength(19);
    expect(inventory.filter(file => file.changed).map(file => file.path)).toEqual(["SKILL.md", "references/01-intake.md"]);
    expect(inventory.filter(file => !file.changed).every(file => file.sha256 === file.beforeSha256)).toBe(true);
    expect(inventory.find(file => file.path === "workflow.yaml")!.sha256).toBe("9f53a1be0d21cbade5daaa9c54c1930b1d2e8e336455c92021df61b6a5b0ab02");
  });
  it.skipIf(!privateRoot)("validates through the real publication and resource loader without publishing", async () => {
    const p = candidate();
    expect(validatePublication(p).descriptor).toEqual(p.descriptor);
    const loaded = await activateSkill({ list: async () => [p.descriptor], state: async () => "enabled",
      read: async ({ path }) => files.find(file => file.path === path)!.bytes }, identityOf(p.descriptor),
    { resources: ["references/01-intake.md"], maxContextBytes: 64000 });
    const context = JSON.parse(loaded.forModel());
    expect(context.resources.map((resource: { path: string }) => resource.path)).toEqual(["SKILL.md", "references/01-intake.md"]);
    const prompt = context.resources.map((resource: { content: string }) => resource.content).join("\n");
    expect(prompt).not.toContain("首次启动完整流程时，应一次性展示以下五个问题");
    expect(prompt).not.toContain("# 固定输出骨架");
    expect(prompt).toContain("宿主提供 `Current information question`");
    expect(prompt).toContain("已知名称不要再问");
    expect(prompt).toContain("YouTube 和 X");
    expect(prompt).toContain("不自动确认或进入下一题");
    // These are instruction/transport contracts, not proof of model quality.
  });
  it.skipIf(!privateRoot)("preserves all other original files and the six-step nine-question workflow", () => {
    expect(inventory.filter(file => file.changed).map(file => file.path)).toEqual(["SKILL.md", "references/01-intake.md"]);
    for (const file of files) {
      const recorded = inventory.find(item => item.path === file.path)!;
      expect(sha256(file.bytes)).toBe(recorded.sha256);
      expect(file.bytes.length).toBe(recorded.bytes);
      if (!recorded.changed) expect(sha256(file.bytes)).toBe(recorded.beforeSha256);
    }
    const workflow = JSON.parse(files.find(file => file.path === "workflow.yaml")!.bytes.toString("utf8"));
    expect(workflow.steps).toHaveLength(6);
    expect(workflow.steps.flatMap((step: { information: unknown[] }) => step.information)).toHaveLength(9);
    expect(inventory.find(file => file.path === "workflow.yaml")!.sha256).toBe("9f53a1be0d21cbade5daaa9c54c1930b1d2e8e336455c92021df61b6a5b0ab02");
    const changed = candidate();
    changed.files[0].base64 = Buffer.from("unaudited content").toString("base64");
    expect(() => validatePublication(changed)).toThrow("INTEGRITY_MISMATCH");
  });
});
