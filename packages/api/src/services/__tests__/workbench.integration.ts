/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { publishSkillPackage } from "../skills/publication";
import { makePackage, makeWorkflow } from "./fixtures/artifacts";
import { packageHash, sha256 } from "../skills/loader";
import { databaseArtifactStore } from "../artifacts/store";
import { webCommandSchema, workbenchService } from "../artifacts/workbench";
const requireWeb = createRequire(
  new URL("../../../../../apps/web/package.json", import.meta.url),
);
const { chromium } = requireWeb(
  "@playwright/test",
) as typeof import("../../../../../apps/web/node_modules/@playwright/test");
const url = process.env.V3_LOCAL_REST!,
  app = process.env.V3_LOCAL_APP!,
  output = process.env.V3_WORKBENCH_OUTPUT!;
if (
  !url?.startsWith("http://127.0.0.1:") ||
  !app?.startsWith("http://127.0.0.1:") ||
  !process.env.V3_LOCAL_DB?.endsWith("/v3_disposable")
)
  throw new Error("isolated workbench runner required");
const sql = new pg.Client({ connectionString: process.env.V3_LOCAL_DB });
const db = createClient(url, process.env.V3_LOCAL_SERVICE_JWT!, {
  auth: { persistSession: false },
});
const password = `Local-${randomUUID()}!`;
let actor: string,
  owner: string,
  browser: Awaited<ReturnType<typeof chromium.launch>>;
let fixtures: Array<{
  label: string;
  moduleId: string;
  pack: ReturnType<typeof makePackage>;
  flow: ReturnType<typeof makeWorkflow>;
  registration: string;
}>;
let credentials: {
  email: string;
  password: string;
};
const outputs: string[] = [];
async function newUser(confirmed = true) {
  const email = `${randomUUID()}@example.test`;
  const r = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: confirmed,
  });
  if (r.error)
    throw new Error(
      "local auth account creation failed: " +
        r.error.message +
        " " +
        r.error.code,
    );
  const id = r.data.user.id;
  await sql.query(
    "insert into profiles(id,email,nickname,role) values($1,$2,$3,$4)",
    [id, email, "Fixture", "user"],
  );
  return { id, email, password };
}
async function authenticated(c = credentials) {
  const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
  const r = await client.auth.signInWithPassword(c);
  if (r.error) throw new Error("local password login failed");
  return client;
}
async function fixture(config: {
  id: string;
  label: string;
  methodText: string;
  workflow: ReturnType<typeof makeWorkflow>;
}) {
  const pack = makePackage(),
    moduleId = randomUUID(),
    registration = config.id,
    flow = config.workflow;
  const entry = pack.files[0],
    text = Buffer.from(entry.base64, "base64").toString() + config.methodText;
  entry.base64 = Buffer.from(text).toString("base64");
  pack.descriptor.files[0].bytes = Buffer.byteLength(text);
  pack.descriptor.files[0].sha256 = sha256(text);
  pack.descriptor.packageHash = packageHash(pack.descriptor);
  await sql.query(
    "insert into skills(id,skill_key,created_by) values($1,$2,$3)",
    [pack.id, registration, owner],
  );
  await sql.query(
    "insert into modules(id,title,skill_id,active) values($1,$2,$3,true)",
    [moduleId, config.label, pack.id],
  );
  await publishSkillPackage(db, owner, pack);
  await sql.query(
    "insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
    [registration, moduleId, pack.id, pack.revisionId, flow, config.label],
  );
  if (flow.kind === "social")
    await sql.query("insert into artifact_accounts values($1,$2,$3,$4)", [
      actor,
      moduleId,
      pack.id,
      "synthetic:local-account",
    ]);
  return { pack, moduleId, flow, registration, label: config.label };
}
async function pageFor(c = credentials) {
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (
      ["127.0.0.1", "localhost"].includes(u.hostname) ||
      ["data:", "blob:"].includes(u.protocol)
    )
      return route.continue();
    outputs.push("blocked browser external " + u.hostname);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("response", async (response) => {
    if (response.url().includes("/api/trpc/")) {
      const text = await response.text().catch(() => "");
      expect(text).not.toContain("METHOD_CANARY");
      expect(text).not.toContain("references/step-");
    }
  });
  await page.goto(app + "/login?redirect=/workbench");
  await page.getByPlaceholder("name@example.com").fill(c.email);
  await page.getByPlaceholder("输入你的密码").fill(c.password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.waitForURL("**/workbench", { timeout: 90000 });
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.getByRole("button", { name: "重新加载服务端状态" }).waitFor();
  return { page, context };
}
async function quiet(
  page: import("../../../../../apps/web/node_modules/@playwright/test").Page,
) {
  await expect
    .poll(
      async () =>
        await page
          .getByRole("button", { name: "重新加载服务端状态" })
          .isEnabled(),
      { timeout: 20000 },
    )
    .toBe(true);
}
async function fillConfirm(
  page: import("../../../../../apps/web/node_modules/@playwright/test").Page,
  f: (typeof fixtures)[number],
  suffix = "v1",
) {
  for (let i = 0; i < f.flow.steps.length; i++) {
    const step = f.flow.steps[i];
    await page
      .getByRole("button", { name: new RegExp(`^${i + 1}\\. ${step.title}`) })
      .click();
    await page
      .getByRole("textbox", { name: `${step.title} 工作稿` })
      .fill(
        `用户确认 ${suffix} ${step.title} <script>alert(1)</script> [unsafe](javascript:alert(1))`,
      );
    await page
      .getByRole("button", { name: "保存全部编辑", exact: true })
      .click();
    await quiet(page);
    await page
      .getByRole("button", { name: "确认当前工作稿", exact: true })
      .click();
    await quiet(page);
    expect(await page.locator("main [role=alert]").count()).toBe(0);
  }
}
// Vitest expect has no browser poll API in some versions; bounded retries use real UI state.
expect.extend({});
beforeAll(async () => {
  await sql.connect();
  browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  if (process.env.V3_WORKBENCH_PHASE === "restore") {
    const saved = JSON.parse(readFileSync(output + "/restore.json", "utf8"));
    credentials = saved.credentials;
    fixtures = saved.fixtures;
    actor = saved.actor;
    owner = saved.owner;
    return;
  }
  const o = await newUser();
  owner = o.id;
  await sql.query("update profiles set role='admin' where id=$1", [owner]);
  const a = await newUser();
  actor = a.id;
  credentials = { email: a.email, password: a.password };
  fixtures = [];
  for (const file of readdirSync(
    new URL("./fixtures/workbench/", import.meta.url),
  ).sort())
    fixtures.push(
      await fixture(
        JSON.parse(
          readFileSync(
            new URL("./fixtures/workbench/" + file, import.meta.url),
            "utf8",
          ),
        ),
      ),
    );
  const boot = await db.rpc("artifact_query", {
    p_actor_id: actor,
    p_action: "projects",
  });
  if (boot.error)
    throw new Error(
      "query bootstrap: " + boot.error.code + " " + boot.error.message,
    );
  // Wait for actual Next HTTP, without replacing its route or authentication.
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(app + "/login")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}, 120000);
afterAll(async () => {
  if (process.env.V3_WORKBENCH_PHASE !== "restore") {
    const state = JSON.parse(readFileSync(output + "/restore.json", "utf8"));
    const service = workbenchService(await authenticated(), db);
    state.expectedSnapshots = [];
    for (const p of await service.projects()) {
      const rounds = await service.rounds(p.projectId);
      const current =
        rounds.find((r) => r.state === "draft") ??
        rounds
          .filter((r) => r.state === "published")
          .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
      state.expectedSnapshots.push(
        await service.read(p.projectId, current.roundId),
      );
    }
    writeFileSync(output + "/restore.json", JSON.stringify(state));
  }
  writeFileSync(output + "/network.txt", outputs.join("\n"));
  await browser?.close();
  await sql.end();
});
it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "runs every configured workflow through browser login → Next HTTP → PostgREST → SQL",
  async () => {
    if (process.env.V3_WORKBENCH_PHASE === "restore") return;
    const { page, context } = await pageFor();
    await quiet(page);
    for (const f of fixtures) {
      await page
        .getByRole("button", { name: `创建 ${f.label}`, exact: true })
        .click();
      await quiet(page);
      await fillConfirm(page, f);
      if (f === fixtures[0])
        await page.route("**/api/trpc/workbench.execute*", async (route) => {
          const response = await route.fetch();
          if (route.request().postData()?.includes("publish"))
            await route.abort("failed");
          else await route.fulfill({ response });
        });
      await page
        .getByRole("button", { name: "发布正式版", exact: true })
        .click();
      if (f === fixtures[0]) {
        await quiet(page);
        expect(await page.locator("main [role=alert]").count()).toBe(1);
        await page.unroute("**/api/trpc/workbench.execute*");
        await page.getByRole("button", { name: "重试同一请求" }).click();
      }
      await quiet(page);
      expect(await page.locator("main [role=alert]").count()).toBe(0);
      await page
        .getByRole("button", { name: "查看正式报告", exact: true })
        .click();
      await quiet(page);
      expect(
        await page
          .getByText(`${f.flow.report.title} · v1`, { exact: true })
          .count(),
      ).toBe(1);
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "重新校验并导出 Markdown" })
        .click();
      const file = await download;
      await file.saveAs(`${output}/sample-${f.flow.steps.length}.md`);
      expect(
        readFileSync(`${output}/sample-${f.flow.steps.length}.md`, "utf8"),
      ).not.toContain("<script>");
      await page.getByRole("button", { name: "沿用此方法开启新轮次" }).click();
      await quiet(page);
      await fillConfirm(page, f, "v2");
      await page
        .getByRole("button", { name: "发布正式版", exact: true })
        .click();
      await quiet(page);
      await page.getByLabel("比较历史轮次").selectOption({ label: "正式 v1" });
      await quiet(page);
      expect(
        await page
          .getByText("仅比较保存内容；没有实践数据，不推断效果或原因。")
          .count(),
      ).toBe(1);
      await page.reload();
      await quiet(page);
    }
    console.log(
      "verified workflow configurations",
      JSON.stringify(
        fixtures.map((f) => ({
          id: f.registration,
          label: f.label,
          steps: f.flow.steps.length,
        })),
      ),
    );
    await page.screenshot({
      path: output + "/workbench-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: output + "/workbench-mobile.png",
      fullPage: true,
    });
    const rows = await sql.query(
      "select p.id,count(v.*)::int n from artifact_projects p join artifact_versions v on v.project_id=p.id where p.actor_id=$1 group by p.id",
      [actor],
    );
    expect(rows.rows).toHaveLength(fixtures.length);
    expect(rows.rows.every((r) => r.n === 2)).toBe(true);
    await context.close();
    writeFileSync(
      output + "/restore.json",
      JSON.stringify({ credentials, fixtures, actor, owner }),
      { mode: 0o600 },
    );
    console.log(
      "configured browser chain: save/confirm/v1/v2/history/export/reload PASS",
    );
  },
  240000,
);
it.skipIf(process.env.V3_WORKBENCH_PHASE !== "restore")(
  "restores all projects in a new browser login after a real application process restart",
  async () => {
    if (process.env.V3_WORKBENCH_PHASE !== "restore") return;
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(app + "/login")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    const { page, context } = await pageFor();
    await quiet(page);
    expect(
      await page.getByText("文档项目 · 正式 v2", { exact: true }).count(),
    ).toBe(fixtures.filter((f) => f.flow.kind === "document").length);
    expect(
      await page
        .getByText("synthetic:local-account · 正式 v3", { exact: true })
        .count(),
    ).toBe(1);
    const saved = JSON.parse(readFileSync(output + "/restore.json", "utf8"));
    for (const f of fixtures) {
      const expected = saved.expectedSnapshots.find(
        (s: { skillId: string }) => s.skillId === f.pack.id,
      );
      await page
        .getByRole("button", { name: new RegExp(`^${f.label}`) })
        .first()
        .click();
      await quiet(page);
      for (const [n, step] of expected.workflow.steps.entries()) {
        await page
          .getByRole("button", {
            name: new RegExp(`^${n + 1}\\. ${step.title}`),
          })
          .click();
        expect(
          await page
            .getByRole("textbox", { name: `${step.title} 工作稿` })
            .inputValue(),
        ).toBe(expected.steps[step.id].body ?? "");
      }
    }
    await context.close();
    console.log(
      "new process + new browser + real password login restores all configured projects and exact saved bodies PASS",
    );
  },
  120000,
);
it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "rejects anonymous, unverified, forged and cross-user identities; web schema has no internal candidate capability",
  async () => {
    if (process.env.V3_WORKBENCH_PHASE === "restore") return;
    const user = await authenticated(),
      service = workbenchService(user, db),
      projects = await service.projects(),
      rounds = await service.rounds(projects[0].projectId);
    const another = await newUser(),
      otherService = workbenchService(await authenticated(another), db);
    await expect(
      otherService.read(projects[0].projectId, rounds[0].roundId),
    ).rejects.toThrow("ARTIFACT_DENIED");
    expect(await otherService.projects()).toEqual([]);
    const foreign = { projectId: randomUUID(), roundId: randomUUID() };
    await otherService.start({
      ...foreign,
      requestId: randomUUID(),
      registration: fixtures[0].registration,
    });
    const ownBrowser = await pageFor();
    await quiet(ownBrowser.page);
    const denied = await ownBrowser.page.request.get(
      app +
        "/api/trpc/workbench.read?input=" +
        encodeURIComponent(JSON.stringify(foreign)),
    );
    expect(denied.status()).toBe(403);
    const deniedExport = await ownBrowser.page.request.post(
      app + "/api/trpc/workbench.export",
      { data: foreign },
    );
    expect(deniedExport.status()).toBe(403);
    await ownBrowser.context.close();

    const anonymous = createClient(
      url,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    await expect(workbenchService(anonymous, db).projects()).rejects.toThrow(
      "ARTIFACT_DENIED",
    );
    const unverified = await newUser(false);
    expect(
      (await anonymous.auth.signInWithPassword(unverified)).error,
    ).not.toBeNull();
    const response = await fetch(app + "/api/trpc/workbench.projects", {
      headers: { Authorization: "Bearer forged-token" },
    });
    expect(response.ok).toBe(false);
    expect(
      webCommandSchema.safeParse({
        action: "candidate",
        projectId: projects[0].projectId,
        roundId: rounds[0].roundId,
        requestId: randomUUID(),
        stepId: "step-0",
        body: "injected",
        evidenceIds: [],
      }).success,
    ).toBe(false);
    expect(
      (
        await anonymous.rpc("artifact_query", {
          p_actor_id: actor,
          p_action: "projects",
        })
      ).error,
    ).not.toBeNull();
    expect(
      (await db.from("artifact_projects").select("*")).error,
    ).not.toBeNull();
    await sql.query(
      "update system_settings set value='true' where key='maintenance_mode'",
    );
    expect((await fetch(app + "/api/trpc/workbench.projects")).status).toBe(
      503,
    );
    await sql.query(
      "update system_settings set value='false' where key='maintenance_mode'",
    );
    console.log(
      "real Auth allowed/denied + cross-user + service table grants + maintenance PASS",
    );
  },
  60000,
);
it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "preserves local input across two browser saves, rejects stale confirmation, and keeps late candidates separate",
  async () => {
    if (process.env.V3_WORKBENCH_PHASE === "restore") return;
    const a = await pageFor();
    await quiet(a.page);
    await a.page.getByRole("button", { name: "沿用此方法开启新轮次" }).click();
    await quiet(a.page);
    const b = await pageFor();
    await quiet(b.page);
    const f = fixtures[0],
      title = f.flow.steps[0].title;
    const user = await authenticated(),
      service = workbenchService(user, db),
      project = (await service.projects()).find(
        (p) => p.skillId === f.pack.id,
      )!,
      round = (await service.rounds(project.projectId)).find(
        (r) => r.state === "draft",
      )!;
    const before = await service.read(project.projectId, round.roundId);
    await a.page
      .getByRole("textbox", { name: `${title} 工作稿` })
      .fill("Context A saved text");
    await b.page
      .getByRole("textbox", { name: `${title} 工作稿` })
      .fill("Context B unsaved retained text");
    await a.page
      .getByRole("button", { name: "保存全部编辑", exact: true })
      .click();
    await quiet(a.page);
    await b.page
      .getByRole("button", { name: "保存全部编辑", exact: true })
      .click();
    await quiet(b.page);
    expect(await b.page.locator("main [role=alert]").count()).toBe(1);
    await b.page.getByRole("button", { name: "重新加载服务端状态" }).click();
    await quiet(b.page);
    expect(
      await b.page
        .getByRole("textbox", { name: `${title} 工作稿` })
        .inputValue(),
    ).toBe("Context B unsaved retained text");
    expect(
      await b.page.getByText("Context A saved text", { exact: true }).count(),
    ).toBe(1);
    await expect(
      service.execute({
        action: "confirm",
        projectId: project.projectId,
        roundId: round.roundId,
        requestId: randomUUID(),
        stepId: "step-0",
        expectedVersion: before.steps["step-0"].version,
        expectedReviewVersion: before.steps["step-0"].reviewVersion,
      }),
    ).rejects.toThrow("ARTIFACT_REVIEW_REQUIRED");
    const trusted = databaseArtifactStore({
      userClient: user,
      privateClient: db,
      moduleId: f.moduleId,
      skillId: f.pack.id,
      registrations: {},
    });
    await trusted.execute({
      action: "candidate",
      projectId: project.projectId,
      roundId: round.roundId,
      requestId: randomUUID(),
      stepId: "step-0",
      body: "Synthetic late candidate",
      evidenceIds: [],
    });
    expect(
      (await service.read(project.projectId, round.roundId)).steps["step-0"]
        .body,
    ).toBe("Context A saved text");
    await b.page
      .getByRole("button", { name: "已比较，保留我的输入作为下一版" })
      .click();
    await b.page
      .getByRole("button", { name: "保存全部编辑", exact: true })
      .click();
    await quiet(b.page);
    expect(
      (await service.read(project.projectId, round.roundId)).steps["step-0"]
        .body,
    ).toBe("Context B unsaved retained text");
    await b.page
      .getByRole("button", { name: "发布正式版", exact: true })
      .click();
    await quiet(b.page);
    expect(
      await b.page
        .getByText("编辑已保存。请复核并确认所有待确认步骤，再发布正式版。")
        .count(),
    ).toBe(1);
    await b.page.getByRole("button", { name: "放弃当前草稿" }).click();
    await quiet(b.page);
    expect(
      (await service.projects()).find((p) => p.projectId === project.projectId)
        ?.currentVersion,
    ).toBe(2);
    await a.context.close();
    await b.context.close();
    console.log(
      "two real browser contexts conflict retention + stale confirm + late candidate + publish guard PASS",
    );
  },
  150000,
);
it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "separates historical read from revoked method execution and rechecks export restrictions",
  async () => {
    if (process.env.V3_WORKBENCH_PHASE === "restore") return;
    const user = await authenticated(),
      service = workbenchService(user, db),
      f = fixtures.find((x) => x.flow.kind === "social")!,
      project = (await service.projects()).find(
        (p) => p.skillId === f.pack.id,
      )!,
      history = await service.rounds(project.projectId),
      base = history.find((r) => r.version === 2)!;
    const roundId = randomUUID(),
      scope = { projectId: project.projectId, roundId };
    await service.start({
      ...scope,
      requestId: randomUUID(),
      fromRoundId: base.roundId,
    });
    const trusted = databaseArtifactStore({
      userClient: user,
      privateClient: db,
      moduleId: f.moduleId,
      skillId: f.pack.id,
      registrations: {},
    });
    const e = await trusted.execute({
      action: "userEvidence",
      ...scope,
      requestId: randomUUID(),
      body: "Synthetic cited source",
      observedAt: null,
      supersedes: null,
    });
    let state = await service.read(scope.projectId, roundId);
    expect(Object.values(state.steps).every((s) => s.valid)).toBe(true);
    await service.execute({
      action: "save",
      ...scope,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: state.steps["step-0"].version,
      body: "Cites a new source",
      evidenceIds: [e.evidenceId],
    });
    for (const step of f.flow.steps) {
      state = await service.read(scope.projectId, roundId);
      await service.execute({
        action: "confirm",
        ...scope,
        requestId: randomUUID(),
        stepId: step.id,
        expectedVersion: state.steps[step.id].version,
        expectedReviewVersion: state.steps[step.id].reviewVersion,
      });
    }
    state = await service.read(scope.projectId, roundId);
    const publish = {
      action: "publish" as const,
      ...scope,
      requestId: randomUUID(),
      expectedSteps: Object.fromEntries(
        Object.entries(state.steps).map(([k, v]) => [
          k,
          { version: v.version, reviewVersion: v.reviewVersion },
        ]),
      ),
    };
    await expect(
      service.execute({ ...publish, expectedSteps: {} }),
    ).rejects.toThrow();
    await expect(
      service.execute({
        ...publish,
        expectedSteps: { "step-0": { version: 999, reviewVersion: 999 } },
      }),
    ).rejects.toThrow("ARTIFACT_REVIEW_REQUIRED");
    await service.execute(publish);
    await workbenchService(await authenticated(), db).execute(publish);
    expect(
      (await service.rounds(scope.projectId)).filter((r) => r.version === 3),
    ).toHaveLength(1);
    const cached = await service.export(scope.projectId, roundId);
    expect(cached.markdown).toContain("Cites a new source");
    await service.execute({
      action: "restrictEvidence",
      ...scope,
      requestId: randomUUID(),
      evidenceId: e.evidenceId,
      deleted: true,
      expiresAt: null,
    });
    await expect(service.export(scope.projectId, roundId)).rejects.toThrow(
      "ARTIFACT_EVIDENCE_UNAVAILABLE",
    );
    expect(
      (await service.read(scope.projectId, roundId)).steps["step-0"].body,
    ).toBeNull();
    for (const query of [
      "update modules set active=false where id=$1",
      "update modules set skill_id=null where id=$1",
    ]) {
      await sql.query(query, [f.moduleId]);
      await expect(
        service.start({
          ...scope,
          roundId: randomUUID(),
          requestId: randomUUID(),
          fromRoundId: base.roundId,
        }),
      ).rejects.toThrow();
      expect((await service.read(scope.projectId, base.roundId)).state).toBe(
        "published",
      );
      await sql.query(
        "update modules set active=true,skill_id=$2 where id=$1",
        [f.moduleId, f.pack.id],
      );
    }
    await sql.query(
      "update skills set status='archived',archived_at=now(),archived_by=$2 where id=$1",
      [f.pack.id, owner],
    );
    await expect(
      service.start({
        ...scope,
        roundId: randomUUID(),
        requestId: randomUUID(),
        fromRoundId: base.roundId,
      }),
    ).rejects.toThrow();
    await publishSkillPackage(db, owner, makePackage(f.pack.id, true));
    await db.rpc("revoke_skill_revision", {
      p_revision_id: f.pack.revisionId,
      p_actor_id: owner,
    });
    await expect(
      service.start({
        ...scope,
        roundId: randomUUID(),
        requestId: randomUUID(),
        fromRoundId: base.roundId,
      }),
    ).rejects.toThrow();
    expect((await service.read(scope.projectId, base.roundId)).state).toBe(
      "published",
    );
    console.log(
      "unadopted evidence + dependency adoption + repeat publish + restricted re-export + disable/unbind/archive/revoke PASS",
    );
  },
  60000,
);
it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "requires explicit method upgrade and preserves old flows when steps change",
  async () => {
    const user = await authenticated(),
      service = workbenchService(user, db),
      f = fixtures[0],
      project = (await service.projects()).find(
        (p) => p.skillId === f.pack.id,
      )!,
      base = (await service.rounds(project.projectId)).find(
        (r) => r.version === 2,
      )!;
    const old = await service.read(project.projectId, base.roundId),
      pack = makePackage(f.pack.id, true);
    await publishSkillPackage(db, owner, pack);
    const flow = structuredClone(f.flow);
    flow.version = 2;
    flow.steps = [
      { ...flow.steps[2], dependsOn: ["step-0"] },
      flow.steps[0],
      {
        ...flow.steps[1],
        id: "new-step",
        title: "新增阶段",
        dependsOn: ["step-2"],
      },
    ];
    flow.report.version = 2;
    flow.report.sections = flow.steps.map((s) => ({
      title: s.title,
      stepId: s.id,
    }));
    await sql.query(
      "insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
      [
        "upgrade-local",
        f.moduleId,
        f.pack.id,
        pack.revisionId,
        flow,
        "升级测试方法",
      ],
    );
    const scope = {
      projectId: project.projectId,
      roundId: randomUUID(),
      requestId: randomUUID(),
      fromRoundId: base.roundId,
    };
    await expect(
      service.start({ ...scope, registration: "upgrade-local" }),
    ).rejects.toThrow("ARTIFACT_INVALID_WORKFLOW");
    const { page, context } = await pageFor();
    await quiet(page);
    await page.getByLabel("升级方法").selectOption("upgrade-local");
    await page
      .getByRole("button", { name: "确认以上方法变化并新建轮次" })
      .click();
    await quiet(page);
    const current = (await service.rounds(project.projectId)).find(
        (r) => r.state === "draft",
      )!,
      next = await service.read(project.projectId, current.roundId);
    expect(next.workflow.steps.map((s) => s.id)).toEqual([
      "step-2",
      "step-0",
      "new-step",
    ]);
    expect(next.revisionId).toBe(pack.revisionId);
    expect(next.steps["step-0"].valid).toBe(false);
    expect(await service.read(project.projectId, base.roundId)).toEqual(old);
    await page.getByRole("button", { name: "放弃当前草稿" }).click();
    await quiet(page);
    await context.close();
    await service.start({
      ...scope,
      roundId: randomUUID(),
      requestId: randomUUID(),
    });
    const inherited = (await service.rounds(project.projectId)).find(
      (r) => r.state === "draft",
    )!;
    expect(
      (await service.read(project.projectId, inherited.roundId)).revisionId,
    ).toBe(f.pack.revisionId);
    await service.execute({
      action: "abandon",
      projectId: project.projectId,
      roundId: inherited.roundId,
      requestId: randomUUID(),
    });
    console.log(
      "explicit upgrade + inserted/deleted/reordered steps + unchanged old snapshots + default old revision PASS",
    );
  },
  60000,
);
it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "fails closed on invalid registrations, unavailable service, disabled or deleted identities",
  async () => {
    const user = await authenticated(),
      service = workbenchService(user, db),
      f = fixtures[0];
    await expect(workbenchService(user, null).projects()).rejects.toThrow(
      "ARTIFACT_UNAVAILABLE",
    );
    for (const variant of ["cycle", "resource", "capability"]) {
      const flow = structuredClone(f.flow);
      if (variant === "cycle") flow.steps[0].dependsOn = ["step-2"];
      if (variant === "resource") flow.steps[0].resources = ["missing.md"];
      if (variant === "capability")
        flow.steps[0].requiredCapabilities = ["unsupported" as never];
      await sql.query(
        "insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
        [
          "invalid-local",
          f.moduleId,
          f.pack.id,
          f.pack.revisionId,
          flow,
          "invalid",
        ],
      );
      await expect(service.catalog()).rejects.toThrow("ARTIFACT_UNAVAILABLE");
      await sql.query(
        "delete from artifact_workflows where id='invalid-local'",
      );
    }
    await sql.query("update artifact_workflows set enabled=false");
    expect(await service.catalog()).toEqual([]);
    expect((await service.projects()).length).toBe(fixtures.length);
    await sql.query("update artifact_workflows set enabled=true");
    await sql.query("update profiles set status='disabled' where id=$1", [
      actor,
    ]);
    await expect(service.projects()).rejects.toThrow("ARTIFACT_DENIED");
    await sql.query("update profiles set status='active' where id=$1", [actor]);
    const expired = await newUser(),
      expiredClient = await authenticated(expired);
    await db.auth.admin.deleteUser(expired.id);
    await expect(
      workbenchService(expiredClient, db).projects(),
    ).rejects.toThrow("ARTIFACT_DENIED");
    expect(
      (
        await user.rpc("artifact_query", {
          p_actor_id: actor,
          p_action: "projects",
        })
      ).error,
    ).not.toBeNull();
    console.log(
      "invalid DAG/resource/capability + unconfigured + disabled + invalidated session + ordinary RPC denial PASS",
    );
  },
  60000,
);

async function repairProject() {
  const credentials = await newUser();
  const user = await authenticated(credentials),
    service = workbenchService(user, db);
  const f = fixtures.find((x) => x.flow.steps.length === 4)!;
  const { page, context } = await pageFor(credentials);
  await quiet(page);
  await page
    .getByRole("button", { name: `创建 ${f.label}`, exact: true })
    .click();
  await quiet(page);
  const project = (await service.projects())[0];
  const round = (await service.rounds(project.projectId))[0];
  return {
    credentials,
    user,
    service,
    f,
    page,
    context,
    projectId: project.projectId,
    roundId: round.roundId,
  };
}

it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "retains later input when recovering committed saves and partial multi-step saves",
  async () => {
    const r = await repairProject();
    const choose = async (n: number) => {
      await r.page
        .getByRole("button", {
          name: new RegExp(`^${n + 1}\\. ${r.f.flow.steps[n].title}`),
        })
        .click();
      return r.page.getByRole("textbox", {
        name: `${r.f.flow.steps[n].title} 工作稿`,
      });
    };
    const save = async () => {
      await r.page
        .getByRole("button", { name: "保存全部编辑", exact: true })
        .click();
      await quiet(r.page);
    };
    for (const count of [1, 2]) {
      const before = await r.service.read(r.projectId, r.roundId);
      for (let n = 0; n < count; n++)
        await (await choose(n)).fill(`submitted-A-${count}-${n}`);
      await r.page.route("**/api/trpc/workbench.execute*", async (route) => {
        const response = await route.fetch();
        const body = route.request().postData() ?? "";
        if (body.includes('"save"') && body.includes(`"step-${count - 1}"`))
          await route.abort("failed");
        else await route.fulfill({ response });
      });
      await save();
      expect(await r.page.locator("main [role=alert]").count()).toBe(1);
      const committed = await r.service.read(r.projectId, r.roundId);
      for (let n = 0; n < count; n++) {
        expect(committed.steps[`step-${n}`].body).toBe(
          `submitted-A-${count}-${n}`,
        );
        expect(committed.steps[`step-${n}`].version).toBe(
          before.steps[`step-${n}`].version + 1,
        );
        await (await choose(n)).fill(`later-B-${count}-${n}`);
      }
      await r.page.unroute("**/api/trpc/workbench.execute*");
      await r.page
        .getByRole("button", { name: "重试同一请求", exact: true })
        .click();
      await quiet(r.page);
      for (let n = 0; n < count; n++) {
        expect(await (await choose(n)).inputValue()).toBe(
          `later-B-${count}-${n}`,
        );
        expect(
          await r.page
            .getByRole("button", {
              name: new RegExp(
                `^${n + 1}\\. ${r.f.flow.steps[n].title}.*未保存`,
              ),
            })
            .count(),
        ).toBe(1);
      }
      const replayed = await r.service.read(r.projectId, r.roundId);
      for (let n = 0; n < count; n++)
        expect(replayed.steps[`step-${n}`]).toEqual(
          committed.steps[`step-${n}`],
        );
      await save();
      const saved = await r.service.read(r.projectId, r.roundId);
      for (let n = 0; n < count; n++) {
        expect(saved.steps[`step-${n}`].body).toBe(`later-B-${count}-${n}`);
        expect(saved.steps[`step-${n}`].version).toBe(
          committed.steps[`step-${n}`].version + 1,
        );
      }
    }
    await r.context.close();
    console.log(
      "WB-386-01 real browser: committed response loss + later input + original request replay + partial multi-step retention PASS",
    );
  },
  120000,
);

it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "removes adopted deleted and expired evidence in the browser while old reports remain restricted",
  async () => {
    for (const restriction of ["deleted", "expired"]) {
      const r = await repairProject();
      const evidence = await r.service.execute({
        action: "userEvidence",
        projectId: r.projectId,
        roundId: r.roundId,
        requestId: randomUUID(),
        body: `original-${restriction}`,
        observedAt: null,
        supersedes: null,
      });
      expect(evidence.accepted).toBe(true);
      const e = (await r.service.read(r.projectId, r.roundId)).evidence[0];
      await r.page.getByRole("button", { name: "重新加载服务端状态" }).click();
      await quiet(r.page);
      await r.page.getByLabel(`采用来源 ${e.id}`, { exact: true }).check();
      await fillConfirm(r.page, r.f, "original-restricted");
      await r.page
        .getByRole("button", { name: "发布正式版", exact: true })
        .click();
      await quiet(r.page);
      const published = r.roundId;
      await r.page
        .getByRole("button", { name: "沿用此方法开启新轮次", exact: true })
        .click();
      await quiet(r.page);
      r.roundId = (await r.service.rounds(r.projectId)).find(
        (x) => x.state === "draft",
      )!.roundId;
      await r.page
        .getByRole("button", {
          name: new RegExp(`^1\\. ${r.f.flow.steps[0].title}`),
        })
        .click();
      if (restriction === "deleted") {
        await r.page
          .getByRole("button", { name: "限制此来源访问", exact: true })
          .click();
        await quiet(r.page);
      } else {
        await r.service.execute({
          action: "restrictEvidence",
          projectId: r.projectId,
          roundId: r.roundId,
          requestId: randomUUID(),
          evidenceId: e.id,
          deleted: false,
          expiresAt: new Date(Date.now() + 600).toISOString(),
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        await r.page
          .getByRole("button", { name: "重新加载服务端状态" })
          .click();
        await quiet(r.page);
      }
      const checkbox = r.page.getByLabel(`采用来源 ${e.id}`, { exact: true });
      expect(await checkbox.isChecked()).toBe(true);
      expect(await checkbox.isEnabled()).toBe(true);
      await checkbox.uncheck();
      expect(await checkbox.isDisabled()).toBe(true);
      // Rewrites every affected body and explicitly reconfirms dependency order.
      await fillConfirm(r.page, r.f, `replacement-${restriction}`);
      const repaired = await r.service.read(r.projectId, r.roundId);
      expect(repaired.steps["step-0"].evidenceIds).toEqual([]);
      expect(Object.values(repaired.steps).every((s) => s.valid)).toBe(true);
      expect(
        (await r.service.read(r.projectId, published)).steps["step-0"].body,
      ).toBeNull();
      await expect(r.service.export(r.projectId, published)).rejects.toThrow(
        "ARTIFACT_EVIDENCE_UNAVAILABLE",
      );
      await r.page
        .getByRole("button", { name: "正式 v1", exact: true })
        .click();
      await quiet(r.page);
      await r.page
        .getByRole("button", {
          name: new RegExp(`^1\\. ${r.f.flow.steps[0].title}`),
        })
        .click();
      expect(
        await r.page
          .getByRole("textbox", { name: `${r.f.flow.steps[0].title} 工作稿` })
          .inputValue(),
      ).toBe("");
      await r.page
        .getByRole("button", { name: "重新校验并导出 Markdown", exact: true })
        .click();
      await quiet(r.page);
      expect(await r.page.locator("main [role=alert]").count()).toBe(1);
      await r.context.close();
    }
    console.log(
      "WB-386-02 real browser: deleted/expired adopted source removal + rewrite/reconfirm + historic redaction/re-export denial PASS",
    );
  },
  180000,
);

it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "adopts 64 direct plus 64 inherited candidate sources through the browser without widening direct input",
  async () => {
    const r = await repairProject();
    const trusted = databaseArtifactStore({
      userClient: r.user,
      privateClient: db,
      moduleId: r.f.moduleId,
      skillId: r.f.pack.id,
      registrations: {},
    });
    const ids: string[] = [];
    for (let i = 0; i < 128; i++) {
      const result = (await trusted.execute({
        action: "userEvidence",
        projectId: r.projectId,
        roundId: r.roundId,
        requestId: randomUUID(),
        body: `fictional-source-${i}`,
        observedAt: null,
        supersedes: null,
      })) as { evidenceId: string };
      ids.push(result.evidenceId);
    }
    expect(new Set(ids).size).toBe(128);
    const scope = { projectId: r.projectId, roundId: r.roundId };
    await trusted.execute({
      action: "save",
      ...scope,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: 0,
      body: "upstream 64 sources",
      evidenceIds: ids.slice(0, 64),
    });
    for (const invalid of [ids.slice(0, 65), [ids[0], ids[0]], [randomUUID()]])
      await expect(
        trusted.execute({
          action: "candidate",
          ...scope,
          requestId: randomUUID(),
          stepId: "step-1",
          body: "invalid",
          evidenceIds: invalid,
        }),
      ).rejects.toThrow();
    const foreign = await repairProject();
    const foreignTrusted = databaseArtifactStore({
      userClient: foreign.user,
      privateClient: db,
      moduleId: foreign.f.moduleId,
      skillId: foreign.f.pack.id,
      registrations: {},
    });
    const other = (await foreignTrusted.execute({
      action: "userEvidence",
      projectId: foreign.projectId,
      roundId: foreign.roundId,
      requestId: randomUUID(),
      body: "foreign",
      observedAt: null,
      supersedes: null,
    })) as { evidenceId: string };
    await expect(
      trusted.execute({
        action: "candidate",
        ...scope,
        requestId: randomUUID(),
        stepId: "step-1",
        body: "cross-project",
        evidenceIds: [other.evidenceId],
      }),
    ).rejects.toThrow();
    await foreign.context.close();
    const created = (await trusted.execute({
      action: "candidate",
      ...scope,
      requestId: randomUUID(),
      stepId: "step-1",
      body: "candidate with 128 complete sources",
      evidenceIds: ids.slice(64),
    })) as { candidateId: string };
    const adoption = {
      action: "saveCandidate" as const,
      ...scope,
      requestId: randomUUID(),
      stepId: "step-1",
      expectedVersion: 0,
      body: "candidate with 128 complete sources",
      candidateId: created.candidateId,
    };
    await expect(foreign.service.execute(adoption)).rejects.toThrow(
      "ARTIFACT_DENIED",
    );
    expect(
      (
        await r.user.rpc("artifact_save_candidate", {
          p_actor_id: r.credentials.id,
          p_module_id: r.f.moduleId,
          p_skill_id: r.f.pack.id,
          p_project_id: r.projectId,
          p_round_id: r.roundId,
          p_request_id: randomUUID(),
          p_step_id: "step-1",
          p_candidate_id: created.candidateId,
          p_expected_version: 0,
          p_body: "denied",
        })
      ).error,
    ).not.toBeNull();
    await trusted.execute({
      action: "save",
      ...scope,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: 1,
      body: "changed dependency",
      evidenceIds: [],
    });
    await expect(r.service.execute(adoption)).rejects.toThrow(
      "ARTIFACT_REVIEW_REQUIRED",
    );
    expect(
      (await r.service.read(r.projectId, r.roundId)).steps["step-1"].version,
    ).toBe(0);
    await trusted.execute({
      action: "save",
      ...scope,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: 2,
      body: "upstream 64 sources",
      evidenceIds: ids.slice(0, 64),
    });
    const snapshot = await r.service.read(r.projectId, r.roundId),
      candidate = snapshot.candidates.find(
        (x) => x.id === created.candidateId,
      )!;
    expect(candidate.evidenceIds).toHaveLength(128);
    expect(candidate.directEvidenceIds).toEqual(ids.slice(64));
    await r.page.getByRole("button", { name: "重新加载服务端状态" }).click();
    await quiet(r.page);
    await r.page
      .getByRole("button", { name: "确认当前工作稿", exact: true })
      .click();
    await quiet(r.page);
    await r.page
      .getByRole("button", {
        name: new RegExp(`^2\\. ${r.f.flow.steps[1].title}`),
      })
      .click();
    await r.page.getByText("此步骤确认历史与候选", { exact: true }).click();
    await r.page
      .getByRole("button", { name: "采用到本地工作稿", exact: true })
      .click();
    await r.page.route("**/api/trpc/workbench.execute*", async (route) => {
      const response = await route.fetch();
      if (route.request().postData()?.includes("saveCandidate"))
        await route.abort("failed");
      else await route.fulfill({ response });
    });
    await r.page
      .getByRole("button", { name: "保存全部编辑", exact: true })
      .click();
    await quiet(r.page);
    expect(await r.page.locator("main [role=alert]").count()).toBe(1);
    await r.page.unroute("**/api/trpc/workbench.execute*");
    await r.page
      .getByRole("button", { name: "重试同一请求", exact: true })
      .click();
    await quiet(r.page);
    expect(await r.page.locator("main [role=alert]").count()).toBe(0);
    const adopted = await r.service.read(r.projectId, r.roundId);
    expect(adopted.steps["step-1"].version).toBe(1);
    expect(adopted.steps["step-1"].evidenceIds).toEqual(ids.slice(64));
    expect(adopted.steps["step-1"].provenanceIds).toHaveLength(128);
    await r.page
      .getByRole("button", { name: "确认当前工作稿", exact: true })
      .click();
    await quiet(r.page);
    for (const n of [2, 3]) {
      await r.page
        .getByRole("button", {
          name: new RegExp(`^${n + 1}\\. ${r.f.flow.steps[n].title}`),
        })
        .click();
      await r.page
        .getByRole("textbox", { name: `${r.f.flow.steps[n].title} 工作稿` })
        .fill(`independent output ${n}`);
      await r.page
        .getByRole("button", { name: "保存全部编辑", exact: true })
        .click();
      await quiet(r.page);
      await r.page
        .getByRole("button", { name: "确认当前工作稿", exact: true })
        .click();
      await quiet(r.page);
    }
    await r.page
      .getByRole("button", { name: "发布正式版", exact: true })
      .click();
    await quiet(r.page);
    expect(await r.page.locator("main [role=alert]").count()).toBe(0);
    const report = await r.service.report(r.projectId, r.roundId);
    expect(report.report!.sources).toHaveLength(128);
    expect(new Set(report.report!.sources.map((x) => x.id))).toEqual(
      new Set(ids),
    );
    await r.page
      .getByRole("button", { name: "查看正式报告", exact: true })
      .click();
    await quiet(r.page);
    expect(
      await r.page
        .getByText(`${r.f.flow.report.title} · v1`, { exact: true })
        .count(),
    ).toBe(1);
    const download = r.page.waitForEvent("download");
    await r.page
      .getByRole("button", { name: "重新校验并导出 Markdown", exact: true })
      .click();
    await (await download).saveAs(output + "/candidate-128.md");
    const markdown = readFileSync(output + "/candidate-128.md", "utf8");
    for (const evidenceId of ids) expect(markdown).toContain(evidenceId);
    await r.context.close();
    console.log(
      "WB-386-03 real browser: 64 direct + 64 inherited candidate adoption/save/confirm/report/export retains 128 unique sources; invalid/duplicate/foreign rejected PASS",
    );
  },
  180000,
);
