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
  it("records a bounded three-file candidate without exposing private content in CI", () => {
    expect(inventory).toHaveLength(19);
    expect(inventory.filter(file => file.changed).map(file => file.path)).toEqual(["EVALS.md", "SKILL.md", "references/01-intake.md"]);
    expect(inventory.filter(file => !file.changed)).toHaveLength(16);
    expect(inventory.find(file => file.path === "EVALS.md")!.beforeSha256).toBe("c8c595a808b5908c91ca8af33833fe8356326f794e306b92015ac3e3d3ae0f10");
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
  it.skipIf(!privateRoot)("loads the revised E1 contract consistently with mentor resources and host confirmation", async () => {
    const p = candidate();
    const loaded = await activateSkill({ list: async () => [p.descriptor], state: async () => "enabled",
      read: async ({ path }) => files.find(file => file.path === path)!.bytes }, identityOf(p.descriptor),
    { resources: ["EVALS.md", "references/01-intake.md"], maxContextBytes: 64000 });
    const resources = JSON.parse(loaded.forModel()).resources as { path: string; content: string }[];
    const text = (path: string) => resources.find(resource => resource.path === path)!.content;
    const evals = text("EVALS.md"), e1 = evals.slice(evals.indexOf("## E1 "), evals.indexOf("## E2 "));
    expect(e1).toContain("我想做一个摄影自媒体账号，帮我从0规划。");
    expect(e1).not.toContain("一次性收集核心需求");
    for (const clause of ["Current information question", "workflow.yaml", "不一次性展示五题问卷", "不把辅助分析维度变成额外必填题",
      "信息不足时自然追问", "不作为业务答案，不视为确认，不自动进入下一题", "保存和确认由宿主处理", "confirmed/deferred",
      "正文不主动带步骤编号", "也一次讨论一个关键缺口"]) expect(e1).toContain(clause);
    expect(sha256(Buffer.from(evals.slice(evals.indexOf("## E2 "))))).toBe("807a6288d603d8121a1fdab48848ffd9858925fa905b4928490bba9bf7b9b882");
    expect(text("SKILL.md")).toContain("宿主提供 `Current information question`");
    expect(text("SKILL.md")).toContain("当前字段与当前步骤的完成状态只由宿主的用户确认流程决定");
    expect(text("references/01-intake.md")).toContain("已知名称不要再问");
    expect(text("references/01-intake.md")).toContain("信息尚不充分时自然追问；充分时简洁归纳");
    const host = readFileSync(resolve(import.meta.dirname, "service.ts"), "utf8");
    expect(host).toContain("The host owns question navigation and confirmation");
    expect(host).toContain("A help request is not a field answer or consent to advance");
    // Text/resource contracts only; real E1 model behavior remains NOT_RUN.
  });
  it.skipIf(!privateRoot)("preserves all other original files and the six-step nine-question workflow", () => {
    expect(inventory.filter(file => file.changed).map(file => file.path)).toEqual(["EVALS.md", "SKILL.md", "references/01-intake.md"]);
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
