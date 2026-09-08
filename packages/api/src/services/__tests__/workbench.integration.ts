/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
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
  package?: ReturnType<typeof makePackage>;
  workflow: ReturnType<typeof makeWorkflow>;
}) {
  const pack = config.package ?? makePackage(),
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
async function pageFor(c = credentials, requests?: string[]) {
  const context = await browser.newContext();
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/trpc") || path.startsWith("/api/ai/stream"))
      requests?.push(path);
  });
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
  // Wait for the login page's client query before filling controlled fields.
  // The initial server HTML can be visible before hydration attaches handlers.
  const loginReady = page.waitForResponse((response) =>
    response.url().includes("/api/trpc/settings.getSystemSettings") && response.ok(),
  );
  await page.goto(app + "/login?redirect=/workbench");
  await loginReady;
  await page.getByPlaceholder("name@example.com").fill(c.email);
  await page.getByPlaceholder("输入你的密码").fill(c.password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  // A suffix glob also matches /login?redirect=/workbench before login succeeds.
  await page.waitForURL((url) => url.pathname === "/workbench", { timeout: 90000 });
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
    const state = existsSync(output + "/restore.json") ? JSON.parse(readFileSync(output + "/restore.json", "utf8")) : { credentials, fixtures, actor, owner };
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
  console.log("isolated cleanup: closing browser");
  await browser?.close();
  console.log("isolated cleanup: closing SQL connection");
  await sql.end();
  console.log("isolated cleanup complete");
}, 60000);
it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "ignores late parallel refresh and creation reads after a real catalog failure",
  async () => {
    for (const scenario of ["project", "round", "start"] as const) {
      const r = await repairProject();
      const creation = scenario === "start" ? await fixture({ id: "parallel-created-local", label: "独立创建恢复", methodText: "Fictional isolated creation recovery method.", workflow: makeWorkflow(3) }) : null;
      const other = fixtures.find((f) => f.flow.kind === "document" && f.moduleId !== r.f.moduleId)!;
      let targetProject = r.projectId, targetRound = r.roundId, targetFlow = r.f.flow;
      if (scenario === "round") {
        await r.page.getByRole("button", { name: "放弃当前草稿", exact: true }).click();
        await quiet(r.page);
        await r.page.getByRole("button", { name: "沿用此方法开启新轮次", exact: true }).click();
        await quiet(r.page);
        targetRound = (await r.service.rounds(r.projectId)).find((x) => x.state === "draft")!.roundId;
        await r.page.getByRole("button", { name: "轮次 1 · 已放弃", exact: true }).click();
      } else {
        await r.page.getByRole("button", { name: `创建 ${other.label}`, exact: true }).click();
        await quiet(r.page);
        targetProject = (await r.service.projects()).find((p) => p.skillId === other.pack.id)!.projectId;
        targetRound = (await r.service.rounds(targetProject))[0].roundId;
        targetFlow = other.flow;
        await r.page.getByRole("button", { name: new RegExp(`^${r.f.label}`) }).click();
      }
      await quiet(r.page);
      const baseline = await r.service.read(targetProject, targetRound);
      const original = await r.service.read(r.projectId, r.roundId);
      const initialProjects = (await r.service.projects()).length;
      let failCatalog = true, holdRead = true, lateUrl = "", catalogRejected = false;
      let release!: () => void, readReady!: () => void, readFailed!: (error: unknown) => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve, reject) => { readReady = resolve; readFailed = reject; });
      const invalidId = `parallel-failure-${scenario}`;
      const invalid = structuredClone(r.f.flow);
      invalid.steps[0].dependsOn = [r.f.flow.steps.at(-1)!.id];
      await r.page.route("**/api/trpc/**", async (route) => {
        try {
        const calls = new URL(route.request().url()).pathname.split("/api/trpc/")[1].split(",");
        if (failCatalog && calls.includes("workbench.catalog")) {
          failCatalog = false;
          // Only catalog fails in the real Next/SQL batch. Projects/rounds
          // succeed, allowing the separate real read to remain in flight.
          await sql.query("insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
            [invalidId, r.f.moduleId, r.f.pack.id, r.f.pack.revisionId, invalid, "invalid isolated catalog",]);
          try {
            const response = await route.fetch();
            const body = await response.json();
            const entries = Array.isArray(body) ? body : [body];
            expect(entries[calls.indexOf("workbench.catalog")].error.data.code).toBe("SERVICE_UNAVAILABLE");
            for (const call of ["workbench.projects", "workbench.rounds"]) {
              const index = calls.indexOf(call);
              if (index >= 0) expect(entries[index].result).toBeDefined();
            }
            catalogRejected = true;
            await route.fulfill({ response });
          } finally {
            await sql.query("delete from artifact_workflows where id=$1", [invalidId]);
          }
        } else if (holdRead && calls.includes("workbench.read")) {
          holdRead = false;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          lateUrl = route.request().url();
          readReady();
          await blocked;
          await route.fulfill({ response });
        } else await route.continue();
        } catch (error) {
          readFailed(error);
          await route.abort().catch(() => undefined);
        }
      });
      try {
        if (scenario === "start")
          await r.page.getByRole("button", { name: `创建 ${creation!.label}`, exact: true }).click();
        else await r.page.getByRole("button", { name: "重新加载服务端状态", exact: true }).click();
        await ready;
        await quiet(r.page);
        expect(catalogRejected).toBe(true);
        expect(await r.page.locator("main [role=alert]").innerText()).toContain("工作台服务未配置或暂时不可用");
        if (scenario === "start") {
          const oldInput = r.page.getByRole("textbox", { name: `${r.f.flow.steps[0].title} 工作稿` });
          await oldInput.fill("LATER-OLD-PROJECT-INPUT");
          const retry = r.page.getByRole("button", { name: "重试同一请求", exact: true });
          expect(await retry.isDisabled()).toBe(true);
          await retry.evaluate((button: HTMLButtonElement) => button.click());
          expect(await oldInput.inputValue()).toBe("LATER-OLD-PROJECT-INPUT");
          expect(await r.service.read(r.projectId, r.roundId)).toEqual(original);
          expect((await r.service.projects()).length).toBe(initialProjects + 1);
          await r.page.getByRole("button", { name: "放弃此步骤本地编辑", exact: true }).click();
        }
        if (scenario === "round")
          await r.page.getByRole("button", { name: "轮次 2 · 草稿", exact: true }).click();
        else await r.page.getByRole("button", { name: new RegExp(`^${other.label}`) }).click();
        await quiet(r.page);
        const input = r.page.getByRole("textbox", { name: `${targetFlow.steps[0].title} 工作稿` });
        const marker = `UNSAVED-${scenario}-AFTER-FAILURE`;
        await input.fill(marker);
        const roundButtons = r.page.getByRole("button", { name: /^(轮次 \d+ ·|正式 v\d+)/ });
        const shownRounds = await roundButtons.allTextContents();
        const late = r.page.waitForResponse((response) => response.url() === lateUrl);
        release();
        await (await late).finished();
        await r.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await input.inputValue()).toBe(marker);
        expect(await roundButtons.allTextContents()).toEqual(shownRounds);
        expect(await r.page.getByText("有未保存编辑。发布会先保存，随后检查全部确认。", { exact: true }).count()).toBe(1);
        expect(await r.service.read(targetProject, targetRound)).toEqual(baseline);
        await r.page.getByRole("button", { name: "保存全部编辑", exact: true }).click();
        await quiet(r.page);
        expect((await r.service.read(targetProject, targetRound)).steps["step-0"].body).toBe(marker);
        expect(await r.service.read(r.projectId, r.roundId)).toEqual(original);
        await r.page.getByRole("button", { name: "重新加载服务端状态", exact: true }).click();
        await quiet(r.page);
        expect(await input.inputValue()).toBe(marker);
        expect(await r.page.locator("main [role=alert]").count()).toBe(0);
        expect((await r.service.projects()).length).toBe(initialProjects + (scenario === "start" ? 1 : 0));
        if (scenario === "start") {
          await r.page.getByRole("button", { name: new RegExp(`^${creation!.label}`) }).click();
          await quiet(r.page);
          expect(await r.page.locator("main [role=alert]").count()).toBe(0);
          expect((await r.service.projects()).length).toBe(initialProjects + 1);
          expect(await r.page.getByRole("button", { name: `创建 ${creation!.label}`, exact: true }).count()).toBe(0);
        }
      } finally {
        release();
        await r.page.unroute("**/api/trpc/**");
        await sql.query("delete from artifact_workflows where id=$1", [invalidId]);
        await r.context.close();
        if (creation) await sql.query("delete from artifact_workflows where id=$1", [creation.registration]);
      }
    }
    console.log("WB-386-05 real catalog-only business failure + delayed real read: project/round/start late responses cannot replace current scope, rounds or unsaved body; only explicit save changes SQL; normal refresh/start recover PASS");
  },
  180000,
);

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
  "rechecks later edits before retrying an uncommitted publication and reads committed results",
  async () => {
    for (const committed of [false, true]) {
      const r = await repairProject();
      await fillConfirm(r.page, r.f, "publish-A");
      const step = r.f.flow.steps.at(-1)!;
      const input = r.page.getByRole("textbox", { name: `${step.title} 工作稿` });
      const before = await r.service.read(r.projectId, r.roundId);
      const requests: string[] = [];
      await r.page.route("**/api/trpc/workbench.execute*", async (route) => {
        requests.push(route.request().postData() ?? "");
        if (committed) expect((await route.fetch()).ok()).toBe(true);
        await route.abort("failed");
      });
      await r.page.getByRole("button", { name: "发布正式版", exact: true }).click();
      await quiet(r.page);
      expect(requests.length).toBe(1);
      expect(requests[0]).toContain('"publish"');
      expect(await r.page.getByRole("button", { name: "重试同一请求", exact: true }).count()).toBe(1);
      await input.fill("later-unsaved-B");
      await r.page.unroute("**/api/trpc/workbench.execute*");
      // Any retry write is a failure: changed editor state permits only a read
      // of an existing result, never a fresh publication with stale input.
      await r.page.route("**/api/trpc/workbench.execute*", async (route) => {
        requests.push(route.request().postData() ?? "");
        await route.continue();
      });
      await r.page.getByRole("button", { name: "重试同一请求", exact: true }).click();
      await quiet(r.page);
      expect(requests.length).toBe(1);
      expect(await input.inputValue()).toBe("later-unsaved-B");
      expect(await r.page.getByRole("button", { name: "重试同一请求", exact: true }).count()).toBe(0);
      const after = await r.service.read(r.projectId, r.roundId);
      expect(after.steps).toEqual(before.steps);
      expect(after.state).toBe(committed ? "published" : "draft");
      expect((await r.service.projects())[0].currentVersion).toBe(committed ? 1 : 0);
      if (committed) {
        expect(await input.getAttribute("readonly")).not.toBeNull();
        const report = await r.service.report(r.projectId, r.roundId);
        expect(report.available).toBe(true);
        expect(report.version).toBe(1);
        expect(report.report).toBeDefined();
        expect(JSON.stringify(report)).not.toContain("later-unsaved-B");
      } else {
        expect(await input.isEditable()).toBe(true);
        expect(await r.service.report(r.projectId, r.roundId)).toEqual({
          available: false,
          reason: "NOT_PUBLISHED",
        });
        await r.page.getByRole("button", { name: "保存全部编辑", exact: true }).click();
        await quiet(r.page);
        const saved = await r.service.read(r.projectId, r.roundId);
        expect(saved.steps[step.id].body).toBe("later-unsaved-B");
        expect(saved.steps[step.id].valid).toBe(false);
        expect(saved.state).toBe("draft");
      }
      await r.context.close();
    }
    console.log("WB-386-04 real browser: pre-commit publish retry with later B performs no write; committed response loss reads existing v1 without duplicate publication; B preserved and never auto-confirmed PASS");
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

it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "never resurrects a discarded write after unrelated read or export failure",
  async () => {
    for (const cancellation of ["discard", "reload", "project", "round"]) {
      const r = await repairProject();
      const input = r.page.getByRole("textbox", {
        name: `${r.f.flow.steps[0].title} 工作稿`,
      });
      await input.fill(`uncommitted-and-cancelled-${cancellation}`);
      // Unlike WB01, no request reaches Next or SQL. Replaying this stale callback
      // later would create a write which the user explicitly stopped pursuing.
      await r.page.route("**/api/trpc/workbench.execute*", (route) =>
        route.abort("failed"),
      );
      await r.page
        .getByRole("button", { name: "保存全部编辑", exact: true })
        .click();
      await quiet(r.page);
      await r.page.unroute("**/api/trpc/workbench.execute*");
      expect(
        await r.page
          .getByRole("button", { name: "重试同一请求", exact: true })
          .count(),
      ).toBe(1);
      if (cancellation !== "reload") {
        await r.page
          .getByRole("button", { name: "放弃此步骤本地编辑", exact: true })
          .click();
        expect(await input.inputValue()).toBe("");
      } else {
        await r.page
          .getByRole("button", { name: "重新加载服务端状态", exact: true })
          .click();
        await quiet(r.page);
        expect(await input.inputValue()).toBe(
          `uncommitted-and-cancelled-${cancellation}`,
        );
      }
      expect(
        await r.page
          .getByRole("button", { name: "重试同一请求", exact: true })
          .count(),
      ).toBe(0);
      if (cancellation === "project") {
        const other = fixtures.find((f) => f.flow.kind === "document" && f.moduleId !== r.f.moduleId)!;
        await r.page.getByRole("button", { name: `创建 ${other.label}`, exact: true }).click();
        await quiet(r.page);
        expect((await r.service.projects()).length).toBe(2);
      } else if (cancellation === "round") {
        await r.page.getByRole("button", { name: "放弃当前草稿", exact: true }).click();
        await quiet(r.page);
        await r.page.getByRole("button", { name: "沿用此方法开启新轮次", exact: true }).click();
        await quiet(r.page);
        expect((await r.service.rounds(r.projectId)).length).toBe(2);
      }
      // A missing report is a successful null response. Temporarily disable this
      // isolated test identity so the subsequent real HTTP read/export is denied.
      await sql.query("update profiles set status='disabled' where id=$1", [
        r.credentials.id,
      ]);
      await r.page
        .getByRole("button", {
          name:
            cancellation === "discard"
              ? "查看正式报告"
              : "重新校验并导出 Markdown",
          exact: true,
        })
        .click();
      await quiet(r.page);
      expect(await r.page.locator("main [role=alert]").count()).toBe(1);
      expect(
        await r.page
          .getByRole("button", { name: "重试同一请求", exact: true })
          .count(),
      ).toBe(0);
      await sql.query("update profiles set status='active' where id=$1", [
        r.credentials.id,
      ]);
      const state = await r.service.read(r.projectId, r.roundId);
      expect(state.steps["step-0"].version).toBe(0);
      expect(state.steps["step-0"].body).toBe("");
      if (cancellation === "reload")
        await r.page
          .getByRole("button", { name: "放弃此步骤本地编辑", exact: true })
          .click();
      await r.context.close();
    }
    console.log(
      "GitHub P2 real browser: pre-commit failure + discard/reload/project/round switch + unrelated report/export failure never exposes or executes stale write PASS",
    );
  },
  150000,
);

it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "completes an eight-step workflow within the existing API request budget",
  async () => {
    const credentials = await newUser();
    const f = fixtures.find((f) => f.flow.steps.length === 8)!;
    const requests: string[] = [];
    const { page, context } = await pageFor(credentials, requests);
    await quiet(page);
    await page.getByRole("button", { name: `创建 ${f.label}`, exact: true }).click();
    await quiet(page);
    await fillConfirm(page, f, "request-budget");
    await page.getByRole("button", { name: "发布正式版", exact: true }).click();
    await quiet(page);
    await page.getByRole("button", { name: "查看正式报告", exact: true }).click();
    await quiet(page);
    expect(await page.getByText(`${f.flow.report.title} · v1`, { exact: true }).count()).toBe(1);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "重新校验并导出 Markdown", exact: true }).click();
    await download;
    await quiet(page);
    expect(await page.locator("main [role=alert]").count()).toBe(0);
    // Count actual proxy-limited HTTP requests including login, creation,
    // individual saves/confirms, publication/report/export. The ENTIRE chain
    // fits below60, so every60-second subset does too. This does not claim a
    // remote Upstash execution; the production limiter and its threshold stay unchanged.
    expect(requests.length).toBeLessThanOrEqual(50);
    console.log(`real8-step workflow limited HTTP request count=${requests.length}; existing proxy threshold60/minute unchanged PASS`);
    await context.close();
  },
  120000,
);

it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "keeps source text and revision selection scoped to each project and round",
  async () => {
    const r = await repairProject();
    const source = r.page.getByRole("textbox", { name: "用户来源补充" });
    const revision = r.page.getByLabel("修订来源", { exact: true });
    const saveSource = r.page.getByRole("button", { name: "保存来源补充", exact: true });
    const unloadProtected = () => r.page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    await expect.poll(unloadProtected).toBe(false);
    await source.fill("saved-source-A");
    await expect.poll(unloadProtected).toBe(true);
    const dialog = r.page.waitForEvent("dialog");
    const reload = r.page.reload().catch(() => null);
    const warning = await dialog;
    expect(warning.type()).toBe("beforeunload");
    await warning.dismiss();
    await reload;
    expect(await source.inputValue()).toBe("saved-source-A");
    await r.page.route("**/api/trpc/workbench.execute**", async (route) => {
      await route.fetch(); // Commit A, then lose only its response.
      await route.abort("failed");
    });
    await saveSource.click();
    await quiet(r.page);
    await r.page.unroute("**/api/trpc/workbench.execute**");
    expect(await source.inputValue()).toBe("saved-source-A");
    await expect.poll(unloadProtected).toBe(true);
    await source.fill("later-unsaved-source");
    await r.page.getByRole("button", { name: "重试同一请求", exact: true }).click();
    await quiet(r.page);
    expect(await source.inputValue()).toBe("later-unsaved-source");
    await expect.poll(unloadProtected).toBe(true);
    expect((await r.service.read(r.projectId, r.roundId)).evidence).toHaveLength(1);
    await source.fill("");
    await expect.poll(unloadProtected).toBe(false);
    const idA = (await r.service.read(r.projectId, r.roundId)).evidence[0].id;
    await revision.selectOption(idA);
    await expect.poll(unloadProtected).toBe(true);
    await source.fill("unsaved-source-A");
    const other = fixtures.find((f) => f.flow.kind === "document" && f.moduleId !== r.f.moduleId)!;
    await r.page.getByRole("button", { name: `创建 ${other.label}`, exact: true }).click();
    await quiet(r.page);
    expect(await source.inputValue()).toBe("");
    expect(await revision.inputValue()).toBe("");
    expect(await saveSource.isDisabled()).toBe(true);
    await expect.poll(unloadProtected).toBe(true); // Hidden A still needs protection.
    await source.fill("saved-source-B");
    await saveSource.click();
    await quiet(r.page);
    expect(await source.inputValue()).toBe("");
    expect(await revision.inputValue()).toBe("");
    await expect.poll(unloadProtected).toBe(true); // B is saved, A remains unsaved.
    const projectB = (await r.service.projects()).find((p) => p.skillId === other.pack.id)!;
    const roundB = (await r.service.rounds(projectB.projectId))[0];
    const stateB = await r.service.read(projectB.projectId, roundB.roundId);
    expect(stateB.evidence).toHaveLength(1);
    expect(JSON.stringify(stateB.evidence)).toContain("saved-source-B");
    expect(JSON.stringify(stateB.evidence)).not.toContain("source-A");
    await r.page.getByRole("button", { name: new RegExp(`^${r.f.label}`) }).click();
    await quiet(r.page);
    expect(await source.inputValue()).toBe("unsaved-source-A");
    expect(await revision.inputValue()).toBe(idA);
    expect((await r.service.read(r.projectId, r.roundId)).evidence).toHaveLength(1);
    await source.fill("");
    await revision.selectOption("");
    await expect.poll(unloadProtected).toBe(false);
    await r.page.getByRole("button", { name: "放弃当前草稿", exact: true }).click();
    await quiet(r.page);
    await r.page.getByRole("button", { name: "沿用此方法开启新轮次", exact: true }).click();
    await quiet(r.page);
    expect(await source.inputValue()).toBe("");
    expect(await revision.inputValue()).toBe("");
    expect(await saveSource.isDisabled()).toBe(true);
    await r.context.close();
    console.log("real source draft isolation/unload: native reload warning preserves source-only input; response-loss retry preserves later input; saved form clears, hidden unsaved scopes remain protected; project/round isolation and SQL contents PASS");
  },
  90000,
);

it.skipIf(process.env.V3_WORKBENCH_PHASE === "restore")(
  "revokes new social rounds atomically while retaining historical access",
  async () => {
    const credentials = await newUser();
    const user = await authenticated(credentials), service = workbenchService(user, db);
    const f = await fixture({ id: "account-binding-local", label: "账号解绑验证", methodText: "Fictional isolated account authorization method.", workflow: makeWorkflow(6, true) });
    const account = "synthetic:revocation-test";
    const binding = [credentials.id, f.moduleId, f.pack.id, account];
    await sql.query("insert into artifact_accounts values($1,$2,$3,$4)", binding);
    const { page, context } = await pageFor(credentials);
    await quiet(page);
    await page.getByRole("button", { name: `创建 ${f.label}`, exact: true }).click();
    await quiet(page);
    await fillConfirm(page, f, "authorized-account");
    await page.getByRole("button", { name: "发布正式版", exact: true }).click();
    await quiet(page);
    const project = (await service.projects())[0];
    const original = (await service.rounds(project.projectId))[0];
    const history = await service.read(project.projectId, original.roundId);
    const flow = structuredClone(f.flow);
    flow.version = 2;
    flow.report.version = 2;
    await sql.query("insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
      ["account-upgrade-local", f.moduleId, f.pack.id, f.pack.revisionId, flow, "账号权限升级测试"]);
    await sql.query("delete from artifact_accounts where actor_id=$1 and module_id=$2 and skill_id=$3 and account=$4", binding);
    await page.getByRole("button", { name: "沿用此方法开启新轮次", exact: true }).click();
    await quiet(page);
    expect(await page.locator("main [role=alert]").innerText()).toContain("无权访问或项目不可用。");
    expect((await service.rounds(project.projectId)).length).toBe(1);
    expect(await service.read(project.projectId, original.roundId)).toEqual(history);
    expect((await service.report(project.projectId, original.roundId)).available).toBe(true);
    await page.getByRole("button", { name: "重新加载服务端状态", exact: true }).click();
    await quiet(page);
    await page.getByLabel("升级方法", { exact: true }).selectOption("account-upgrade-local");
    await page.getByRole("button", { name: "确认以上方法变化并新建轮次", exact: true }).click();
    await quiet(page);
    expect(await page.locator("main [role=alert]").innerText()).toContain("无权访问或项目不可用。");
    expect((await service.rounds(project.projectId)).length).toBe(1);
    const direct = databaseArtifactStore({ userClient: user, privateClient: db,
      moduleId: f.moduleId, skillId: f.pack.id,
      registrations: { fixed: { revisionId: f.pack.revisionId, workflow: f.flow } } });
    await expect(direct.start({ projectId: project.projectId, roundId: randomUUID(), requestId: randomUUID(), registration: "fixed", account, fromRoundId: original.roundId })).rejects.toThrow("ARTIFACT_DENIED");
    // Rebinding permits the exact denied upgrade request; the failed transaction
    // left no round/request receipt which could masquerade as a successful start.
    await sql.query("insert into artifact_accounts values($1,$2,$3,$4)", binding);
    await page.getByRole("button", { name: "重试同一请求", exact: true }).click();
    await quiet(page);
    expect(await page.locator("main [role=alert]").count()).toBe(0);
    const rounds = await service.rounds(project.projectId);
    expect(rounds.length).toBe(2);
    const created = rounds.find((r) => r.state === "draft")!;
    expect((await service.read(project.projectId, created.roundId)).workflow.version).toBe(2);
    expect(await service.read(project.projectId, original.roundId)).toEqual(history);

    // Concurrent revocation holds the mapping row. A new transaction must wait
    // for that decision and deny after delete commits, not use a stale check.
    const concurrentAccount = "synthetic:concurrent-revocation";
    const concurrentBinding = [credentials.id, f.moduleId, f.pack.id, concurrentAccount];
    await sql.query("insert into artifact_accounts values($1,$2,$3,$4)", concurrentBinding);
    const revoker = new pg.Client({ connectionString: process.env.V3_LOCAL_DB });
    await revoker.connect();
    try {
      await revoker.query("begin");
      await revoker.query("delete from artifact_accounts where actor_id=$1 and module_id=$2 and skill_id=$3 and account=$4", concurrentBinding);
      const projectId = randomUUID();
      const attempt = direct.start({ projectId, roundId: randomUUID(), requestId: randomUUID(), registration: "fixed", account: concurrentAccount })
        .then(() => "unexpected success", (e: Error) => e.message);
      await expect.poll(async () => Number((await sql.query("select count(*) as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%artifact_transition%'" )).rows[0].n), { timeout: 5000 }).toBeGreaterThan(0);
      await revoker.query("commit");
      expect(await attempt).toBe("ARTIFACT_DENIED");
      expect((await sql.query("select id from artifact_projects where id=$1", [projectId])).rowCount).toBe(0);
    } finally {
      await revoker.query("rollback");
      await revoker.end();
    }
    await context.close();
    await sql.query("delete from artifact_workflows where id in ('account-upgrade-local','account-binding-local')");
    console.log("real social account guard: same-method/upgrade/direct RPC denied after unbind; history retained; exact denied retry succeeds after rebind; concurrent delete blocks and rolls back new project/round PASS");
  },
  150000,
);

// AI transport is explicitly injected here. SQL, Auth, Skill reads, pricing and
// the existing credit RPCs are real local services; no provider request is made.
const localModel = randomUUID();
async function generationFixture(n = 3, methodText = 'Synthetic generation method.', options: {workflow?: ReturnType<typeof makeWorkflow>; package?: ReturnType<typeof makePackage>} = {}) {
  const { workbenchGeneration } = await import('../artifacts/generation');
  const flow = options.workflow ?? makeWorkflow(n, n === 6); flow.report.title = `本地 AI ${randomUUID()}`;
  const f = await fixture({ id: `ai-${randomUUID()}`, label: flow.report.title, methodText, workflow: flow, package: options.package });
  await sql.query("insert into ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost) values($1,'openai/gpt-4o-mini-2024-07-18','Local fixture','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',150000,600000) on conflict(id) do nothing", [localModel]);
  await sql.query('update modules set model_id=$1 where id=$2', [localModel, f.moduleId]);
  await sql.query("insert into system_settings(key,value) values('v3_workbench_ai','true') on conflict(key) do update set value='true'");
  await sql.query('update profiles set credits=100000 where id=$1', [actor]);
  const user = await authenticated(), service = workbenchService(user, db);
  const scope = { projectId: randomUUID(), roundId: randomUUID() };
  const account = n === 6 ? `synthetic:${randomUUID()}` : undefined;
  if (account) await sql.query('insert into artifact_accounts values($1,$2,$3,$4)', [actor, f.moduleId, f.pack.id, account]);
  await service.start({ ...scope, requestId: randomUUID(), registration: f.registration, account });
  let calls = 0;
  const captured: string[] = [];
  const ai = workbenchGeneration(user, db, async req => { calls++; captured.push(JSON.stringify(req.messages)); return { body: 'Synthetic AI candidate text.', inputTokens: 800, outputTokens: 30 }; });
  async function input(client = ai, stepId = 'step-0') {
    const s = await service.read(scope.projectId, scope.roundId);
    const v = { ...scope, stepId, instruction: 'Generate a fictional strategy.', expectedSteps: Object.fromEntries(Object.entries(s.steps).map(([k, x]) => [k, { version: x.version, reviewVersion: x.reviewVersion }])) };
    const quote = await client.quote(v);
    return { ...v, ...quote, budgetCredits: quote.reservedCredits, requestId: randomUUID() };
  }
  // Public input deliberately contains no actor, model, price, resource or key.
  async function request(client = ai, stepId = 'step-0') {
    const { reservedCredits: _reserved, ...v } = await input(client, stepId); return v;
  }
  return { f, user, service, scope, ai, request, captured, calls: () => calls, workbenchGeneration };
}
const aiTest = it.skipIf(process.env.V3_WORKBENCH_PHASE === 'restore');
aiTest('AI: exact request replay associates one real credit settlement and one private-method candidate', async () => {
  const t = await generationFixture(), v = await t.request();
  const before = await t.service.read(v.projectId, v.roundId);
  const result = await t.ai.generate(v);
  expect(result.state).toBe('succeeded');
  expect(await t.ai.generate(v)).toEqual(result);
  expect(t.calls()).toBe(1);
  expect(t.captured[0]).toContain('METHOD_CANARY');
  expect(t.captured[0]).toContain('references/step-0.md');
  expect(t.captured[0]).not.toContain('references/step-1.md');
  const after = await t.service.read(v.projectId, v.roundId);
  expect(after.steps).toEqual(before.steps);
  expect(after.candidates).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('METHOD_CANARY');
  const rows = (await sql.query("select operation_type,amount from billing_history where user_id=$1 order by created_at", [actor])).rows;
  expect(rows.filter(r => r.operation_type === 'pre_deduct')).toHaveLength(1);
  expect(rows.filter(r => r.operation_type === 'settle')).toHaveLength(1);
  const billingMetadata = JSON.stringify((await sql.query('select metadata from billing_history where user_id=$1', [actor])).rows);
  expect(billingMetadata).not.toContain('references/step-');
  expect(billingMetadata).not.toContain('METHOD_CANARY');
  expect((await sql.query('select credits from profiles where id=$1', [actor])).rows[0].credits).toBe(100000 - result.chargedCredits!);
  await expect(t.ai.generate({ ...v, instruction: 'changed' })).rejects.toThrow('GENERATION_CONFLICT');
  console.log('AI local real SQL billing + injected model: single deduction/settlement, private closure, idempotent replay PASS');
}, 30000);
aiTest('AI: concurrent duplicate does not dispatch twice; late output preserves edits and cannot adopt stale basis', async () => {
  const t = await generationFixture(); let release!: () => void, arrived!: () => void; let calls = 0;
  const started = new Promise<void>(r => { arrived = r; }), wait = new Promise<void>(r => { release = r; });
  const ai = t.workbenchGeneration(t.user, db, async () => { calls++; arrived(); await wait; return { body: 'Late synthetic candidate', inputTokens: 700, outputTokens: 20 }; });
  const v = await t.request(ai), running = ai.generate(v);
  await started;
  expect((await ai.generate(v)).state).toBe('dispatched');
  await t.service.execute({ ...t.scope, action: 'save', requestId: randomUUID(), stepId: 'step-0', expectedVersion: 0, body: 'User edited while AI was running.', evidenceIds: [] });
  release(); const result = await running;
  expect(calls).toBe(1); expect(result.state).toBe('succeeded');
  const snapshot = await t.service.read(v.projectId, v.roundId);
  expect(snapshot.steps['step-0'].body).toBe('User edited while AI was running.');
  expect(snapshot.candidates[0].body).toBe('Late synthetic candidate');
  await expect(t.service.execute({ ...t.scope, action: 'saveCandidate', requestId: randomUUID(), stepId: 'step-0', candidateId: result.candidateId!, expectedVersion: 1, body: 'Late synthetic candidate' })).rejects.toThrow();
}, 30000);
aiTest('AI: unknown provider outcome holds the reservation and prevents blind resend or replacement', async () => {
  const t = await generationFixture(); let calls = 0;
  const ai = t.workbenchGeneration(t.user, db, async () => { calls++; throw new Error('synthetic provider timeout'); });
  const v = await t.request(ai), result = await ai.generate(v);
  expect(result.state).toBe('unknown'); expect(result.chargedCredits).toBeNull();
  expect((await ai.generate(v)).state).toBe('unknown');
  await expect(ai.generate({ ...v, requestId: randomUUID() })).rejects.toThrow();
  expect(calls).toBe(1);
  await expect(ai.cancel({ ...t.scope, requestId: v.requestId })).rejects.toThrow();
  expect((await t.service.read(v.projectId, v.roundId)).candidates).toHaveLength(0);
}, 30000);
aiTest('AI: saved receipt survives failed billing commit and recovers atomically without another model call', async () => {
  const t = await generationFixture(), v = await t.request();
  await sql.query("create function local_fail_ai_settle() returns trigger language plpgsql as $$ begin if NEW.operation_type='settle' then raise exception 'local injected settle failure'; end if; return NEW; end $$; create trigger local_fail_ai_settle before insert on billing_history for each row execute function local_fail_ai_settle()");
  try { expect((await t.ai.generate(v)).recoveryReceipt).toBeTruthy(); }
  finally { await sql.query('drop trigger local_fail_ai_settle on billing_history; drop function local_fail_ai_settle()'); }
  expect((await t.ai.list(t.scope))[0].state).toBe('responded');
  expect((await t.service.read(v.projectId, v.roundId)).candidates).toHaveLength(0);
  const done = await t.ai.recover({ ...t.scope, requestId: v.requestId });
  expect(done.state).toBe('succeeded');
  expect(await t.ai.recover({ ...t.scope, requestId: v.requestId })).toEqual(done);
  expect(t.calls()).toBe(1);
  expect((await t.service.read(v.projectId, v.roundId)).candidates).toHaveLength(1);
}, 30000);
aiTest('AI: disabled, model capacity, insufficient credits, unavailable dependencies and forged actor all fail before model effects', async () => {
  const t = await generationFixture(), v = await t.request();
  const count = async () => Number((await sql.query('select count(*) from billing_history')).rows[0].count);
  const before = await count();
  await sql.query("update system_settings set value='false' where key='v3_workbench_ai'");
  await expect(t.ai.generate(v)).rejects.toThrow('GENERATION_DISABLED');
  await sql.query("update system_settings set value='true' where key='v3_workbench_ai'");
  await sql.query('update ai_models set input_limit=100 where id=$1', [localModel]);
  await expect(t.ai.generate(v)).rejects.toThrow('GENERATION_CAPACITY');
  await sql.query('update ai_models set input_limit=128000 where id=$1', [localModel]);
  await sql.query('update profiles set credits=0 where id=$1', [actor]);
  await expect(t.ai.generate(v)).rejects.toThrow();
  await sql.query('update profiles set credits=100000 where id=$1', [actor]);
  await expect(t.request(t.ai, 'step-1')).rejects.toThrow('GENERATION_INPUT_UNAVAILABLE');
  const stranger = await newUser(), foreign = t.workbenchGeneration(await authenticated(stranger), db, async () => { throw new Error('must not call'); });
  await expect(foreign.list(t.scope)).rejects.toThrow('ARTIFACT_DENIED');
  await sql.query('update modules set active=false where id=$1', [t.f.moduleId]);
  await expect(t.ai.generate(v)).rejects.toThrow();
  await sql.query('update modules set active=true where id=$1', [t.f.moduleId]);
  expect(await count()).toBe(before); expect(t.calls()).toBe(0);
  const denied = await t.user.rpc('artifact_generation', { p_actor_id: actor, p_project_id: v.projectId, p_round_id: v.roundId, p_action: 'list' });
  expect(denied.error).not.toBeNull();
  const deniedTable = await t.user.from('artifact_generations').select('*');
  expect(deniedTable.error).not.toBeNull();
}, 30000);
aiTest.each([3, 6, 8])('AI: same host generates for a %i-step configuration without a research call', async n => {
  const t = await generationFixture(n), v = await t.request();
  expect((await t.ai.generate(v)).state).toBe('succeeded');
  expect(t.calls()).toBe(1);
  expect(t.captured[0]).not.toContain('agentkey');
}, 30000);
aiTest('AI: prepared cancellation restores actual credits once, and dispatch failure refunds only an unsent reservation', async () => {
  const t = await generationFixture(), v = await t.request();
  const reserve = await db.rpc('artifact_generation', { p_actor_id: actor, p_project_id: v.projectId, p_round_id: v.roundId, p_request_id: v.requestId, p_action: 'prepare', p_payload: { input: v, quote: { modelId: localModel, reservedCredits: v.budgetCredits } } });
  expect(reserve.error).toBeNull();
  expect((await t.ai.cancel({ ...t.scope, requestId: v.requestId })).state).toBe('refunded');
  expect((await t.ai.cancel({ ...t.scope, requestId: v.requestId })).state).toBe('refunded');
  expect((await sql.query('select credits from profiles where id=$1', [actor])).rows[0].credits).toBe(100000);
  const fault = new Proxy(db, { get(target, key) {
    if (key === 'rpc') return (name: string, args: Record<string, unknown>) => args.p_action === 'dispatch'
      ? { abortSignal: async () => ({ data: null, error: { code: 'P0001', message: 'synthetic before dispatch failure' } }) }
      : target.rpc(name, args);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const ai = t.workbenchGeneration(t.user, fault, async () => { throw new Error('must not dispatch'); });
  await expect(ai.generate({ ...v, requestId: randomUUID() })).rejects.toThrow();
  expect((await ai.list(t.scope)).every(r => r.state === 'refunded')).toBe(true);
  expect((await sql.query('select credits from profiles where id=$1', [actor])).rows[0].credits).toBe(100000);
}, 30000);
aiTest('AI: browser quote → real local HTTP generation → candidate → adopt/save, with late edit and reload protection', async () => {
  const t = await generationFixture();
  const { page, context } = await pageFor();
  await page.getByRole('button', { name: new RegExp(`^${t.f.label}`) }).click(); await quiet(page);
  const panel = page.getByRole('region', { name: 'AI 候选生成' });
  await page.getByRole('button', { name: '查看生成费用', exact: true }).click();
  const generate = page.getByRole('button', { name: /^生成候选（最多/ }); await generate.waitFor();
  const dispatched = page.waitForRequest(req => req.url().includes('/api/trpc/workbench.generate'));
  await generate.click(); await dispatched;
  const editor = page.getByRole('textbox', { name: 'Synthetic step 1 工作稿' });
  await editor.fill('User typing during delayed synthetic model response.');
  await expect.poll(async () => (await panel.innerText()).includes('候选已保存'), { timeout: 30000 }).toBe(true);
  expect(await editor.inputValue()).toBe('User typing during delayed synthetic model response.');
  expect((await t.service.read(t.scope.projectId, t.scope.roundId)).steps['step-0'].body).toBe('');
  await page.getByText('此步骤确认历史与候选', { exact: true }).click();
  await page.getByRole('button', { name: '采用到本地工作稿', exact: true }).click();
  expect(await editor.inputValue()).toBe('Synthetic local HTTP candidate');
  await page.getByRole('button', { name: '保存全部编辑', exact: true }).click(); await quiet(page);
  expect((await t.service.read(t.scope.projectId, t.scope.roundId)).steps['step-0'].body).toBe('Synthetic local HTTP candidate');
  await page.reload(); await quiet(page);
  await page.getByRole('button', { name: new RegExp(`^${t.f.label}`) }).click(); await quiet(page);
  expect(await page.getByRole('region', { name: 'AI 候选生成' }).innerText()).toContain('候选已保存');
  const count = await (await fetch(url + '/__workbench_model_calls')).json(); expect(count.calls).toBe(1);
  await page.screenshot({ path: output + '/ai-candidate-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + '/ai-candidate-mobile.png', fullPage: true });
  await expect.poll(async () => await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), { timeout: 3000 }).toBe(true);
  await context.close();
}, 90000);
aiTest('AI: existing monthly grant consumption follows the original pre-deduct and settlement rules', async () => {
  const t = await generationFixture(), v = await t.request();
  const grant = randomUUID(), subscription = `sub_${randomUUID()}`, plan = randomUUID(), invoice = `in_${randomUUID()}`;
  const start = new Date(Date.now() - 86400000).toISOString(), end = new Date(Date.now() + 86400000).toISOString();
  await sql.query("insert into user_subscriptions(user_id,stripe_subscription_id,membership_plan_id,billing_cycle,current_period_start,current_period_end) values($1,$2,$3,'monthly',$4,$5)", [actor, subscription, plan, start, end]);
  await sql.query("insert into subscription_credit_grants(id,user_id,stripe_subscription_id,membership_plan_id,billing_cycle,grant_type,grant_period_key,period_start,period_end,total_periods,stripe_invoice_id,credits_granted) values($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,100000)", [grant, actor, subscription, plan, `invoice:${invoice}`, start, end, invoice]);
  try {
    const result = await t.ai.generate(v); expect(result.state).toBe('succeeded');
    expect((await sql.query('select consumed_amount from subscription_credit_grants where id=$1', [grant])).rows[0].consumed_amount).toBe(result.chargedCredits);
    expect((await sql.query('select credits from profiles where id=$1', [actor])).rows[0].credits).toBe(100000 - result.chargedCredits!);
  } finally {
    await sql.query('delete from subscription_credit_grants where id=$1', [grant]);
    await sql.query('delete from user_subscriptions where stripe_subscription_id=$1', [subscription]);
  }
}, 30000);
aiTest('AI: adopted source restriction and fixed revision revocation reject execution before charging', async () => {
  const t = await generationFixture();
  await t.service.execute({ ...t.scope, action: 'userEvidence', requestId: randomUUID(), body: 'Fictional observed source', observedAt: new Date().toISOString(), supersedes: null });
  const source = (await t.service.read(t.scope.projectId, t.scope.roundId)).evidence[0];
  await t.service.execute({ ...t.scope, action: 'save', requestId: randomUUID(), stepId: 'step-0', expectedVersion: 0, body: 'Draft using fictional evidence.', evidenceIds: [source.id] });
  const v = await t.request();
  const before = Number((await sql.query('select count(*) from billing_history')).rows[0].count);
  await t.service.execute({ ...t.scope, action: 'restrictEvidence', requestId: randomUUID(), evidenceId: source.id, deleted: true, expiresAt: null });
  await expect(t.ai.generate(v)).rejects.toThrow();
  const revoked = await db.rpc('revoke_skill_revision', { p_revision_id: t.f.pack.revisionId, p_actor_id: owner }); expect(revoked.error).toBeNull();
  await expect(t.ai.generate(v)).rejects.toThrow();
  expect(Number((await sql.query('select count(*) from billing_history')).rows[0].count)).toBe(before);
  expect(t.calls()).toBe(0);
}, 30000);

aiTest('AI: private method echo is never persisted as a candidate or receipt', async () => {
  const t = await generationFixture();
  const ai = t.workbenchGeneration(t.user, db, async () => ({ body: 'M E T H O D _ C A N A R Y', inputTokens: 800, outputTokens: 30 }));
  const v = await t.request(ai), result = await ai.generate(v);
  expect(result.state).toBe('unknown'); expect(result.recoveryReceipt).toBeUndefined();
  expect((await t.service.read(v.projectId, v.roundId)).candidates).toHaveLength(0);
  expect((await sql.query('select result from artifact_generations where request_id=$1',[v.requestId])).rows[0].result).toBeNull();
}, 30000);
aiTest('AI: receipt write outage returns encrypted recovery across service recreation, denies tampering and settles once', async () => {
  const t = await generationFixture(); let calls = 0;
  const fault = new Proxy(db, { get(target, key) {
    if (key === 'rpc') return (name: string, args: Record<string, unknown>) => args.p_action === 'receipt'
      ? { abortSignal: async () => ({ data: null, error: { code: 'P0001' } }) } : target.rpc(name, args);
    const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const ai = t.workbenchGeneration(t.user, fault, async () => { calls++; return { body: 'Known synthetic result retained across DB failure.', inputTokens: 800, outputTokens: 30 }; });
  const v = await t.request(ai), result = await ai.generate(v);
  expect(result.recoveryReceipt).toBeTruthy(); expect(result.state).toBe('dispatched');
  expect(result.recoveryReceipt).not.toContain('Known synthetic');
  expect((await t.service.read(v.projectId,v.roundId)).candidates).toHaveLength(0);
  const restarted = t.workbenchGeneration(t.user, db, async () => { throw new Error('must not resend'); });
  const recovery = { ...t.scope, requestId: v.requestId, recoveryReceipt: result.recoveryReceipt! };
  const bytes=Buffer.from(recovery.recoveryReceipt,'base64url'); bytes[35]^=1;
  await expect(restarted.recover({...recovery,recoveryReceipt:bytes.toString('base64url')})).rejects.toThrow();
  const done = await restarted.recover(recovery); expect(done.state).toBe('succeeded');
  expect(await restarted.recover(recovery)).toEqual(done); expect(calls).toBe(1);
  expect((await t.service.read(v.projectId,v.roundId)).candidates).toHaveLength(1);
  expect((await sql.query("select count(*)::int as n from billing_history b join artifact_generations g on b.metadata->>'preDeductId'=g.pre_deduct_id::text where b.operation_type='settle' and g.request_id=$1",[v.requestId])).rows[0].n).toBe(1);
}, 30000);
aiTest('AI: abandoning a rejected quote tombstones delayed original delivery and permits a fresh quote', async () => {
  const t = await generationFixture(), v = await t.request();
  await t.service.execute({ ...t.scope, action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Changed after quote',evidenceIds:[] });
  await expect(t.ai.generate(v)).rejects.toThrow();
  expect(await t.ai.abandon({...t.scope,requestId:v.requestId})).toEqual({abandoned:true});
  const fresh=await t.request();
  await expect(t.ai.generate({...fresh,requestId:v.requestId})).rejects.toThrow();
  expect((await t.ai.generate(fresh)).state).toBe('succeeded');
  expect(await t.ai.abandon({...t.scope,requestId:fresh.requestId})).toEqual({abandoned:false});
  expect(t.calls()).toBe(1);
}, 30000);
aiTest('AI: browser rejected quote can requote, and sealed response survives reload during receipt outage', async () => {
  const t = await generationFixture(), {page,context}=await pageFor();
  await page.getByRole('button',{name:new RegExp(`^${t.f.label}`)}).click(); await quiet(page);
  const quote=page.getByRole('button',{name:'查看生成费用',exact:true});
  await quote.click(); await page.getByRole('button',{name:/^生成候选（最多/}).waitFor();
  await sql.query('update ai_models set output_token_cost=output_token_cost+100000 where id=$1',[localModel]);
  await page.getByRole('button',{name:/^生成候选（最多/}).click();
  await expect.poll(()=>quote.isEnabled(),{timeout:10000}).toBe(true);
  expect((await t.ai.list(t.scope))).toHaveLength(0);
  await quote.click(); await page.getByRole('button',{name:/^生成候选（最多/}).waitFor();
  await sql.query("create function local_fail_ai_receipt() returns trigger language plpgsql as $$ begin if NEW.state='responded' then raise exception 'local receipt unavailable'; end if; return NEW; end $$; create trigger local_fail_ai_receipt before update on artifact_generations for each row execute function local_fail_ai_receipt()");
  try {
    await page.getByRole('button',{name:/^生成候选（最多/}).click();
    await expect.poll(async()=> (await page.getByRole('region',{name:'AI 候选生成'}).innerText()).includes('已收到结果，待恢复保存'),{timeout:30000}).toBe(true);
    await page.reload(); await quiet(page);
    await page.getByRole('button',{name:new RegExp(`^${t.f.label}`)}).click(); await quiet(page);
    // The restored receipt is loaded by a React effect after project selection.
    await expect.poll(async()=> (await page.getByRole('region',{name:'AI 候选生成'}).innerText()).includes('已收到结果，待恢复保存'),{timeout:10000}).toBe(true);
  } finally { await sql.query('drop trigger local_fail_ai_receipt on artifact_generations; drop function local_fail_ai_receipt()'); }
  await page.getByRole('button',{name:'恢复已保存结果',exact:true}).click();
  await expect.poll(async()=> (await page.getByRole('region',{name:'AI 候选生成'}).innerText()).includes('候选已保存'),{timeout:10000}).toBe(true);
  expect((await t.service.read(t.scope.projectId,t.scope.roundId)).candidates).toHaveLength(1);
  expect((await t.ai.list(t.scope))).toHaveLength(1);
  await context.close();
},90000);

aiTest('AI: duplicated provider model names use the selected UUID pricing and reject changed price before dispatch', async () => {
  const t=await generationFixture(), duplicate=randomUUID();
  await sql.query("insert into ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost) values($1,'openai/gpt-4o-mini-2024-07-18','Other selected row','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',9000000,12000000)",[duplicate]);
  try {
    const v=await t.request(); expect(v.budgetCredits).toBeGreaterThan(0);
    await sql.query('update modules set model_id=$1 where id=$2',[duplicate,t.f.moduleId]);
    await expect(t.ai.generate(v)).rejects.toThrow('GENERATION_QUOTE_CHANGED'); expect(t.calls()).toBe(0);
    const replacement=await t.request(); expect(replacement.budgetCredits).toBeGreaterThan(v.budgetCredits);
    const result=await t.ai.generate(replacement); expect(result.state).toBe('succeeded');
    const q=(await sql.query('select quote from artifact_generations where request_id=$1',[replacement.requestId])).rows[0].quote;
    expect(q.modelId).toBe(duplicate); expect(q.pricing.inputPer1M).toBe(9); expect(q.pricing.outputPer1M).toBe(12);
    expect(t.calls()).toBe(1);
  } finally { await sql.query('update modules set model_id=$1 where id=$2',[localModel,t.f.moduleId]); await sql.query('delete from ai_models where id=$1',[duplicate]); }
},30000);

aiTest('AI: valid markdown delimiters produce exactly one candidate and settlement on replay', async () => {
  const t=await generationFixture(3,'\n--------------------\n____________________\nNormal fictional method.');
  const v=await t.request(), done=await t.ai.generate(v);
  expect(done.state).toBe('succeeded'); expect(await t.ai.generate(v)).toEqual(done); expect(t.calls()).toBe(1);
  expect((await t.service.read(v.projectId,v.roundId)).candidates).toHaveLength(1);
  expect((await sql.query("select count(*)::int as n from billing_history b join artifact_generations g on b.metadata->>'preDeductId'=g.pre_deduct_id::text where b.operation_type='settle' and g.request_id=$1",[v.requestId])).rows[0].n).toBe(1);
},30000);
aiTest('AI: stale saved-text provenance cannot disappear through generation after dependency rewrite', async () => {
  const t=await generationFixture();
  const save=async(stepId:string,body:string,evidenceIds:string[])=>{const s=await t.service.read(t.scope.projectId,t.scope.roundId);await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId,expectedVersion:s.steps[stepId].version,body,evidenceIds});};
  const confirm=async(stepId:string)=>{const s=await t.service.read(t.scope.projectId,t.scope.roundId);await t.service.execute({...t.scope,action:'confirm',requestId:randomUUID(),stepId,expectedVersion:s.steps[stepId].version,expectedReviewVersion:s.steps[stepId].reviewVersion});};
  await t.service.execute({...t.scope,action:'userEvidence',requestId:randomUUID(),body:'Historical fictional source A',observedAt:new Date().toISOString(),supersedes:null});
  const source=(await t.service.read(t.scope.projectId,t.scope.roundId)).evidence[0];
  await save('step-0','Draft grounded in source A',[source.id]);await confirm('step-0');
  await save('step-1','Old working text derived from source A',[]);
  const previous=await t.request(t.ai,'step-1');
  await save('step-0','Rewritten upstream without source A',[]);await confirm('step-0');
  const changed=await t.service.read(t.scope.projectId,t.scope.roundId);
  expect(changed.steps['step-1'].provenanceIds).toContain(source.id);
  await expect(t.request(t.ai,'step-1')).rejects.toThrow('GENERATION_INPUT_UNAVAILABLE');
  const expectedSteps=Object.fromEntries(Object.entries(changed.steps).map(([k,x])=>[k,{version:x.version,reviewVersion:x.reviewVersion}]));
  const bypass=await db.rpc('artifact_generation',{p_actor_id:actor,p_project_id:t.scope.projectId,p_round_id:t.scope.roundId,p_action:'prepare',p_request_id:randomUUID(),p_payload:{input:{...previous,expectedSteps},quote:{modelId:localModel,reservedCredits:previous.budgetCredits}}});
  expect(bypass.error).not.toBeNull();expect(t.calls()).toBe(0);expect(await t.ai.list(t.scope)).toHaveLength(0);
  await save('step-1','Explicit new working draft after reviewing changed sources',[]);
  expect((await t.ai.generate(await t.request(t.ai,'step-1'))).state).toBe('succeeded');expect(t.calls()).toBe(1);
},30000);
aiTest('AI: candidate, original settlement, spend ledger and canonical usage records roll back and reconcile together', async () => {
  const t=await generationFixture(),v=await t.request();
  await sql.query("create function local_fail_usage() returns trigger language plpgsql as $$ begin raise exception 'local usage storage unavailable'; end $$; create trigger local_fail_usage before insert on token_stats for each row execute function local_fail_usage()");
  try { expect((await t.ai.generate(v)).state).toBe('responded'); }
  finally {await sql.query('drop trigger local_fail_usage on token_stats; drop function local_fail_usage()');}
  const g=(await sql.query('select id,pre_deduct_id from artifact_generations where request_id=$1',[v.requestId])).rows[0];
  expect((await sql.query("select count(*)::int as n from billing_history where operation_type='settle' and metadata->>'preDeductId'=$1",[g.pre_deduct_id])).rows[0].n).toBe(0);
  expect((await sql.query('select count(*)::int as n from credit_transactions where source_id=$1',[g.id])).rows[0].n).toBe(0);
  expect((await t.service.read(v.projectId,v.roundId)).candidates).toHaveLength(0);
  const done=await t.ai.recover({...t.scope,requestId:v.requestId});expect(done.state).toBe('succeeded');
  expect(await t.ai.recover({...t.scope,requestId:v.requestId})).toEqual(done);expect(t.calls()).toBe(1);
  for(const table of ['token_stats','ai_usage_logs']) expect((await sql.query(`select count(*)::int as n from ${table} where artifact_generation_id=$1`,[g.id])).rows[0].n).toBe(1);
  expect((await sql.query('select amount,counts_as_spend from credit_transactions where source_id=$1',[g.id])).rows).toEqual([{amount:-done.chargedCredits!,counts_as_spend:true}]);
  const {runDailyBillingReconciliation}=await import('../billingReconciliation');
  const tomorrow=new Date();tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  const reconciled=await runDailyBillingReconciliation(db,tomorrow,new Date('2000-01-01T00:00:00Z'));
  expect(reconciled.mismatches).toEqual([]);expect(reconciled.success).toBe(true);
  expect(reconciled.summary.settledCredits).toBe(reconciled.summary.tokenStatsCredits);
  // Existing conversation-bound writes remain valid; unscoped stats do not.
  const conversation=randomUUID();await sql.query('insert into conversations(id) values($1)',[conversation]);
  await sql.query("insert into token_stats(conversation_id,user_id,model_used,input_tokens,output_tokens,total_cost_usd,total_credits) values($1,$2,'legacy-fixture',0,0,0,0)",[conversation,actor]);
  await expect(sql.query("insert into token_stats(user_id,model_used,input_tokens,output_tokens,total_cost_usd,total_credits) values($1,'unscoped',0,0,0,0)",[actor])).rejects.toThrow();
},30000);

aiTest('AI: prepared retry rechecks consumption limits without requiring a second reservation balance',async()=>{
  const t=await generationFixture(),v=await t.request();
  const stopped=new Proxy(db,{get(target,key){
    if(key==='rpc') return (name:string,args:Record<string,unknown>)=>args.p_action==='prepare'
      ? {abortSignal:async()=>{const saved=await target.rpc(name,args);if(saved.error)throw saved.error;throw new Error('local stopped after reserve');}}
      : target.rpc(name,args);
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(t.workbenchGeneration(t.user,stopped,async()=>{throw new Error('must not send');}).generate(v)).rejects.toThrow('local stopped after reserve');
  expect((await t.ai.list(t.scope))[0].state).toBe('prepared');
  const marker=randomUUID();
  await sql.query("insert into billing_history(id,user_id,operation_type,amount,metadata) values($1,$2,'settle',-10000,'{}')",[marker,actor]);
  try { await expect(t.ai.generate(v)).rejects.toThrow('每小时消费已达上限'); expect(t.calls()).toBe(0);expect((await t.ai.list(t.scope))[0].state).toBe('prepared'); }
  finally {await sql.query('delete from billing_history where id=$1',[marker]);}
  await sql.query('update profiles set credits=0 where id=$1',[actor]);
  expect((await t.ai.generate(v)).state).toBe('succeeded');expect(t.calls()).toBe(1);
  expect((await sql.query("select count(*)::int as n from billing_history b join artifact_generations g on b.id=g.pre_deduct_id where g.request_id=$1",[v.requestId])).rows[0].n).toBe(1);
},30000);
aiTest('AI: ordinary domain phrase shared with a private method still produces a candidate',async()=>{
  const t=await generationFixture(3,'Use competitive analysis and entrepreneurship to reason about fictional markets.');
  const ai=t.workbenchGeneration(t.user,db,async()=>({body:'Competitive analysis helps entrepreneurship.',inputTokens:800,outputTokens:30}));
  const v=await t.request(ai);expect((await ai.generate(v)).state).toBe('succeeded');
  expect((await t.service.read(v.projectId,v.roundId)).candidates).toHaveLength(1);
},30000);

aiTest('AI: independent edits preserve candidates while contributing ancestor edits invalidate them',async()=>{
  const flow=makeWorkflow(3);flow.steps[2].dependsOn=[];
  const t=await generationFixture(3,'Branching fictional method.',{workflow:flow});
  const save=async(stepId:string,body:string)=>{const s=await t.service.read(t.scope.projectId,t.scope.roundId);await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId,expectedVersion:s.steps[stepId].version,body,evidenceIds:[]});};
  await save('step-0','Confirmed ancestor');
  const s=await t.service.read(t.scope.projectId,t.scope.roundId);
  await t.service.execute({...t.scope,action:'confirm',requestId:randomUUID(),stepId:'step-0',expectedVersion:s.steps['step-0'].version,expectedReviewVersion:s.steps['step-0'].reviewVersion});
  const v=await t.request(t.ai,'step-1');await save('step-2','Unrelated before dispatch');
  const done=await t.ai.generate(v);expect(done.state).toBe('succeeded');
  await save('step-2','Unrelated after generation');
  await t.service.execute({...t.scope,action:'saveCandidate',requestId:randomUUID(),stepId:'step-1',candidateId:done.candidateId!,expectedVersion:0,body:'Adopted unaffected candidate'});
  const basis=(await sql.query('select basis from artifact_generations where request_id=$1',[v.requestId])).rows[0].basis;
  expect(Object.keys(basis).sort()).toEqual(['step-0','step-1']);
  const newer=await t.ai.generate(await t.request(t.ai,'step-1'));
  await save('step-0','Changed contributing ancestor');
  await expect(t.service.execute({...t.scope,action:'saveCandidate',requestId:randomUUID(),stepId:'step-1',candidateId:newer.candidateId!,expectedVersion:1,body:'Must not adopt stale candidate'})).rejects.toThrow();
},30000);
aiTest('AI: 64 long-path resources remain complete while quote identity fits durable storage',async()=>{
  const pack=makePackage();pack.files=pack.files.slice(0,1);pack.descriptor.files=pack.descriptor.files.slice(0,1);
  for(let i=0;i<63;i++) {
    const path=`references/${'x'.repeat(195)}-${i}.md`,body=`Private fictional resource ${i}.`;
    pack.files.push({path,base64:Buffer.from(body).toString('base64')});
    pack.descriptor.files.push({path,bytes:Buffer.byteLength(body),sha256:sha256(body),mediaType:'text/markdown',requires:[]});
  }
  pack.descriptor.packageHash=packageHash(pack.descriptor);
  const flow=makeWorkflow(1);flow.steps[0].resources=pack.files.slice(1).map(f=>f.path);
  const t=await generationFixture(1,'',{workflow:flow,package:pack}),v=await t.request();
  expect((await t.ai.generate(v)).state).toBe('succeeded');
  for(const file of pack.files)expect(t.captured[0]).toContain(file.path);
  const stored=(await sql.query('select quote,octet_length(quote::text) as bytes from artifact_generations where request_id=$1',[v.requestId])).rows[0];
  expect(stored.bytes).toBeLessThan(16384);expect(stored.quote.resourcesHash).toMatch(/^[a-f0-9]{64}$/);expect(stored.quote.resources).toBeUndefined();
},30000);

// Chat linkage uses the same real local Auth/PostgREST/credit transaction fixture.
aiTest('CHAT: durable multi-turn linkage, dependency-limited history, single settlement and denied identities',async()=>{
 const {skillChatService}=await import('../artifacts/chat');
 const flow=makeWorkflow(3);flow.steps[1].dependsOn=['step-0'];flow.steps[2].dependsOn=[];
 const t=await generationFixture(3,'Synthetic chat method.',{workflow:flow});
 const chat=skillChatService(t.user,db);
 const binding=await chat.enter({...t.scope,requestId:randomUUID()});
 expect(await chat.enter({...t.scope,requestId:randomUUID()})).toEqual(binding);
 expect(await chat.mode(t.f.moduleId)).toEqual({guided:true});
 async function send(stepId:string,body:string){
  const requestId=randomUUID();const submitted=await db.rpc('artifact_chat',{p_actor_id:actor,p_action:'submit',p_conversation_id:binding.conversationId,p_payload:{requestId,stepId,body}});expect(submitted.error).toBeNull();await chat.submit({conversationId:binding.conversationId,stepId,body,requestId});
  const snapshot=await t.service.read(t.scope.projectId,t.scope.roundId);
  const input={...t.scope,conversationId:binding.conversationId,turnId:requestId,stepId,instruction:body,expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
  const q=await t.ai.quote(input),request={...input,requestId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits};
  const result=await t.ai.generate(request);expect(result.state).toBe('succeeded');expect((await t.ai.generate(request)).candidateId).toBe(result.candidateId);
  return {requestId,result};
 }
 const first=await send('step-0','FIRST_CHAT_REQUIREMENT');
 await send('step-0','SECOND_CHAT_REVISION');
 expect(t.captured.at(-1)).toContain('FIRST_CHAT_REQUIREMENT');expect(t.captured.at(-1)).toContain('SECOND_CHAT_REVISION');
 expect(t.captured.at(-1)).toContain('Synthetic AI candidate text.');
 await send('step-2','UNRELATED_BRANCH_DISCUSSION');
 expect(t.captured.at(-1)).not.toContain('FIRST_CHAT_REQUIREMENT');
 await t.service.execute({...t.scope,requestId:randomUUID(),action:'saveCandidate',stepId:'step-0',expectedVersion:0,body:'Confirmed basis',candidateId:first.result.candidateId!});
 const saved=(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'];
 await t.service.execute({...t.scope,requestId:randomUUID(),action:'confirm',stepId:'step-0',expectedVersion:saved.version,expectedReviewVersion:saved.reviewVersion});
 await send('step-1','DEPENDENT_DISCUSSION');
 expect(t.captured.at(-1)).toContain('FIRST_CHAT_REQUIREMENT');expect(t.captured.at(-1)).not.toContain('UNRELATED_BRANCH_DISCUSSION');
 const restored=await skillChatService(await authenticated(),db).read({conversationId:binding.conversationId});
 expect(restored.binding.stepId).toBe('step-1');expect(restored.turns).toHaveLength(4);expect(t.calls()).toBe(4);expect((await chat.stats()).find(s=>s.conversationId===binding.conversationId)?.messageCount).toBe(8);
 const row=(await sql.query('select count(*)::int as n from messages where conversation_id=$1',[binding.conversationId])).rows[0];expect(row.n).toBe(0);
 const usage=(await sql.query('select count(*)::int as n from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1)',[t.scope.projectId])).rows[0];expect(usage.n).toBe(4);
 const foreign=await newUser();await expect(skillChatService(await authenticated(foreign),db).read({conversationId:binding.conversationId})).rejects.toThrow('ARTIFACT_DENIED');
 expect((await t.user.from('artifact_chat_turns').select('*')).error).toBeTruthy();
 await sql.query("update skills set status='draft' where id=$1",[t.f.pack.id]);
 expect((await chat.read({conversationId:binding.conversationId})).turns.length).toBeGreaterThan(0);
 await expect(chat.submit({conversationId:binding.conversationId,requestId:randomUUID(),stepId:'step-0',body:'denied new execution'})).rejects.toThrow();
 console.log('CHAT real SQL/Auth: durable scoped history, explicit artifact adoption, exact replay and denied user/revoked Skill PASS');
},60000);

aiTest('CHAT: homepage entry, real HTTP multi-turn, adoption, confirmation, history restore and narrow layout',async()=>{
 const poll=<T>(fn:()=>Promise<T>)=>expect.poll(fn,{timeout:30000});
 const t=await generationFixture(),requests:string[]=[];
 await sql.query("insert into system_settings(key,value) values('home_show_onboarding','true') on conflict(key) do update set value='true'");
 const {page,context}=await pageFor(credentials,requests);
 await page.goto(app+'/');await page.getByRole('button',{name:'开始分析',exact:true}).click();
 await page.waitForURL(u=>u.pathname==='/marketplace');
 expect(await page.getByRole('link',{name:'Skill 引导',exact:true}).count()).toBe(0);
 await page.getByRole('heading',{name:t.f.label,exact:true}).first().click();
 await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();
 await page.getByLabel('给当前步骤发消息').waitFor();
 await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 const conversationId=new URL(page.url()).searchParams.get('conversation')!;
 async function send(body:string){await page.getByLabel('给当前步骤发消息').fill(body);await page.getByRole('button',{name:'发送',exact:true}).click();await poll(async()=>await page.getByLabel('给当前步骤发消息').inputValue()).toBe('');}
 await send('BROWSER_FIRST_REQUIREMENT');await send('BROWSER_SECOND_REVISION');
 await poll(async()=>await page.locator('[data-message-role="assistant"]').count()).toBe(2);
 await poll(async()=> (await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body).toBe('Synthetic local HTTP candidate');
 expect(await page.getByRole('button',{name:'保存工作稿',exact:true}).count()).toBe(0);
 await poll(async()=>await page.getByRole('button',{name:'确认并进入下一步',exact:true}).isEnabled()).toBe(true);
 await page.getByRole('button',{name:'确认并进入下一步',exact:true}).click();
 await poll(async()=> (await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].valid).toBe(true);
 await page.getByRole('button',{name:new RegExp('^2\\. '+t.f.flow.steps[1].title)}).click();
 await poll(async()=>await page.locator('[data-message-role="user"]').count()).toBe(0);
 await page.getByRole('button',{name:'新建对话',exact:true}).click();
 await poll(async()=>await page.getByLabel('Skill 步骤与成果').count()).toBe(0);
 await page.getByText(t.f.label,{exact:true}).last().click();
 await page.waitForURL(u=>u.searchParams.get('conversation')===conversationId);await page.reload();
 await poll(async()=>await page.getByRole('button',{name:new RegExp('^2\\. '+t.f.flow.steps[1].title)}).getAttribute('aria-current')).toBe('step');
 await page.setViewportSize({width:390,height:844});await page.reload();await page.getByLabel('给当前步骤发消息').waitFor();
 expect(await page.getByLabel('Skill 步骤与成果').count()).toBe(0);
 await page.getByRole('button',{name:'步骤与成果',exact:true}).click();await page.getByRole('button',{name:'收起',exact:true}).click();
 const width=await page.getByLabel('给当前步骤发消息').boundingBox();expect(width!.width).toBeGreaterThan(260);
 expect(requests.filter(p=>p.startsWith('/api/ai/stream'))).toHaveLength(0);
 await page.screenshot({path:output+'/chat-narrow.png'});await page.setViewportSize({width:1440,height:1000});await page.reload();await page.getByLabel('Skill 步骤与成果').waitFor();await page.screenshot({path:output+'/chat-desktop.png'});
 await context.close();console.log('CHAT real homepage/browser/HTTP: two turns, explicit adoption/confirmation, history refresh, no ordinary generation and narrow drawer PASS');
},150000);

aiTest.each([3,6,8,4])('CHAT: %i configured steps share durable linkage and generation',async(n)=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(n),chat=skillChatService(t.user,db);
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Manual topic: pet action photography',evidenceIds:[]});
 const binding=await chat.enter({...t.scope,requestId:randomUUID()}),requestId=randomUUID(),body='Synthetic configured conversation';
 await chat.submit({conversationId:binding.conversationId,requestId,stepId:'step-0',body});
 const v={...await t.request(),conversationId:binding.conversationId,turnId:requestId,requestId,instruction:body};
 const q=await t.ai.quote({projectId:v.projectId,roundId:v.roundId,stepId:v.stepId,conversationId:v.conversationId,turnId:v.turnId,instruction:body,expectedSteps:v.expectedSteps});
 expect((await t.ai.generate({...v,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits})).state).toBe('succeeded');
 const sent=JSON.parse(t.captured.at(-1)!);
 expect(JSON.parse(sent[1].content).currentStepResult).toEqual({body:'Manual topic: pet action photography',version:1});
 expect((await chat.read({conversationId:binding.conversationId})).turns).toHaveLength(1);
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).workflow.steps).toHaveLength(n);
},30000);
aiTest('CHAT: source revocation hides historic turns and rejects reuse before new credit effects',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db);
 await t.service.execute({...t.scope,action:'userEvidence',requestId:randomUUID(),body:'SENSITIVE_CONTEXT_CANARY',observedAt:null,supersedes:null});
 const evidence=(await t.service.read(t.scope.projectId,t.scope.roundId)).evidence[0];
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Source-backed draft',evidenceIds:[evidence.id]});
 const binding=await chat.enter({...t.scope,requestId:randomUUID()}),requestId=randomUUID(),body='SENSITIVE_CONTEXT_CANARY follow up';
 await chat.submit({conversationId:binding.conversationId,requestId,stepId:'step-0',body});
 const snapshot=await t.service.read(t.scope.projectId,t.scope.roundId),value={...t.scope,conversationId:binding.conversationId,turnId:requestId,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const q=await t.ai.quote(value);await t.ai.generate({...value,requestId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits});
 const before=(await sql.query('select count(*)::int n from billing_history')).rows[0].n;
 await t.service.execute({...t.scope,action:'restrictEvidence',requestId:randomUUID(),evidenceId:evidence.id,deleted:true,expiresAt:null});
 const read=await chat.read({conversationId:binding.conversationId});expect(JSON.stringify(read)).not.toContain('SENSITIVE_CONTEXT_CANARY');expect(read.turns[0]).toMatchObject({available:false,body:null,answer:null});
 await expect(chat.submit({conversationId:binding.conversationId,requestId:randomUUID(),stepId:'step-0',body:'Continue'})).rejects.toThrow();
 expect((await sql.query('select count(*)::int n from billing_history')).rows[0].n).toBe(before);
 const plain=await t.user.from('messages').insert({conversation_id:binding.conversationId,role:'user',content:'Must not use ordinary messages'});expect(plain.error?.code).toBe('42501');
},30000);

aiTest('CHAT: module Use selects guided mode; free and ordinary document history survive unrelated catalog failure',async()=>{
 const poll=<T>(fn:()=>Promise<T>)=>expect.poll(fn,{timeout:30000});
 const t=await generationFixture(),requests:string[]=[];const {page,context}=await pageFor(credentials,requests);
 await page.goto(app+'/marketplace?module='+t.f.moduleId);await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();
 await page.getByLabel('给当前步骤发消息').waitFor();await page.getByLabel('Skill 步骤与成果').waitFor();
 const bound=new URL(page.url()).searchParams.get('conversation');expect(bound).toBeTruthy();
 const skillId=randomUUID(),moduleId=randomUUID();
 await sql.query("insert into skills(id,skill_key,draft_content) values($1,$2,'Private document method')",[skillId,skillId]);
 await sql.query("insert into modules(id,title,skill_id,active) values($1,'Ordinary document',$2,true)",[moduleId,skillId]);
 expect((await db.rpc('atomic_publish_skill',{p_skill_id:skillId,p_published_by:owner})).error).toBeNull();
 const conversationId=randomUUID();expect((await t.user.from('conversations').insert({id:conversationId,user_id:actor,title:'Saved document conversation',module_id:moduleId})).error).toBeNull();
 expect((await t.user.from('messages').insert({conversation_id:conversationId,role:'user',content:'Ordinary saved message'})).error).toBeNull();
 const invalidId='chat-invalid-'+randomUUID(),invalid=structuredClone(t.f.flow);invalid.steps[0].dependsOn=[invalid.steps.at(-1)!.id];
 await sql.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',[invalidId,t.f.moduleId,t.f.pack.id,t.f.pack.revisionId,invalid,'Invalid local catalog']);
 try {
  requests.length=0;await page.goto(app+'/');await page.getByRole('link',{name:'自由对话',exact:true}).click();
  await poll(async()=>page.getByLabel('Skill 步骤与成果').count()).toBe(0);
  await page.goto(app+'/marketplace?module='+moduleId);await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/chat'&&u.searchParams.get('module')===moduleId);
  await page.getByTestId('chat-input').waitFor();expect(await page.getByLabel('Skill 步骤与成果').count()).toBe(0);
  await page.getByText('Saved document conversation',{exact:true}).click();await page.getByText('Ordinary saved message',{exact:true}).waitFor();await page.reload();await page.getByText('Ordinary saved message',{exact:true}).waitFor();
  expect(requests.some(p=>p.includes('workbench.catalog'))).toBe(false);expect(requests.some(p=>p.startsWith('/api/ai/stream'))).toBe(false);
 } finally {await sql.query('delete from artifact_workflows where id=$1',[invalidId]);await context.close();}
},150000);

aiTest('CHAT: late response preserves later input and draft; rejected quotes and sealed receipts recover without another dispatch',async()=>{
 const poll=<T>(fn:()=>Promise<T>)=>expect.poll(fn,{timeout:30000});
 const t=await generationFixture(),{page,context}=await pageFor();
 await page.goto(app+'/marketplace?module='+t.f.moduleId);await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();await page.getByLabel('给当前步骤发消息').waitFor();
 const composer=page.getByLabel('给当前步骤发消息'),draft=page.getByLabel('当前步骤工作稿');
 await composer.fill('ORIGINAL_SENT_MESSAGE');
 let arrived!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>arrived=r),hold=new Promise<void>(r=>release=r);
 await page.route('**/api/trpc/workbench.generate*',async route=>{const response=await route.fetch();arrived();await hold;await route.fulfill({response});});
 await page.getByRole('button',{name:'发送',exact:true}).click();await seen;
 await composer.fill('LATER_UNSENT_MESSAGE');await draft.fill('LATER_LOCAL_DRAFT');release();
 await poll(async()=>page.locator('[data-message-role="assistant"]').count()).toBe(1);
 expect(await composer.inputValue()).toBe('LATER_UNSENT_MESSAGE');expect(await draft.inputValue()).toBe('LATER_LOCAL_DRAFT');

 await composer.fill('');await poll(async()=> (await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body).toBe('LATER_LOCAL_DRAFT');await page.unroute('**/api/trpc/workbench.generate*');
 await page.route('**/api/trpc/workbench.generationQuote*',async route=>{
  const response=await route.fetch();await sql.query('update ai_models set output_token_cost=output_token_cost+100000 where id=$1',[localModel]);await route.fulfill({response});
 });
 await composer.fill('REQUOTE_MESSAGE');await page.getByRole('button',{name:'发送',exact:true}).click();
 await poll(async()=>page.getByRole('button',{name:'发送',exact:true}).isEnabled()).toBe(true);
 await page.unroute('**/api/trpc/workbench.generationQuote*');
 await sql.query("create function local_chat_receipt_fault() returns trigger language plpgsql as $$ begin if NEW.state='responded' then raise exception 'local receipt unavailable'; end if; return NEW; end $$; create trigger local_chat_receipt_fault before update on artifact_generations for each row execute function local_chat_receipt_fault()");
 try {await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('已收到结果，待恢复保存',{exact:false}).waitFor();await page.reload();await page.getByText('已收到结果，待恢复保存',{exact:false}).waitFor();}
 finally {await sql.query('drop trigger local_chat_receipt_fault on artifact_generations; drop function local_chat_receipt_fault()');}
 await sql.query("update skills set status='draft' where id=$1",[t.f.pack.id]);
 await page.reload();await page.getByRole('button',{name:'恢复已知结果',exact:true}).waitFor();
 await page.getByRole('button',{name:'恢复已知结果',exact:true}).click();await poll(async()=>page.locator('[data-message-role="assistant"]').count()).toBe(2);
 expect((await t.ai.list(t.scope))).toHaveLength(2);expect((await t.service.read(t.scope.projectId,t.scope.roundId)).candidates).toHaveLength(2);
 expect((await sql.query("select count(*)::int n from artifact_requests where project_id=$1 and action='generation_abandoned'",[t.scope.projectId])).rows[0].n).toBe(1);
 await context.close();console.log('CHAT late UI input/draft, no dirty navigation, quote tombstone and encrypted reload recovery PASS');
},150000);

aiTest('CHAT: prepared replay keeps its original context and reservation while rechecking consumption',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()}),requestId=randomUUID(),body='Resume original contextual turn';
 await chat.submit({conversationId:binding.conversationId,requestId,stepId:'step-0',body});const snapshot=await t.service.read(t.scope.projectId,t.scope.roundId);
 const value={...t.scope,conversationId:binding.conversationId,turnId:requestId,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))},q=await t.ai.quote(value),v={...value,requestId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits};
 const stopped=new Proxy(db,{get(target,key){if(key==='rpc')return (name:string,args:Record<string,unknown>)=>args.p_action==='prepare'?{abortSignal:async()=>{const result=await target.rpc(name,args);if(result.error)throw result.error;throw new Error('local stopped after reserve');}}:target.rpc(name,args);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await expect(t.workbenchGeneration(t.user,stopped,async()=>{throw new Error('must not dispatch');}).generate(v)).rejects.toThrow('local stopped after reserve');
 expect((await t.ai.quote(value)).quoteHash).toBe(q.quoteHash);
 const marker=randomUUID();await sql.query("insert into billing_history(id,user_id,operation_type,amount,metadata) values($1,$2,'settle',-10000,'{}')",[marker,actor]);
 try{await expect(t.ai.generate(v)).rejects.toThrow('每小时消费已达上限');expect(t.calls()).toBe(0);}finally{await sql.query('delete from billing_history where id=$1',[marker]);}
 await sql.query('update profiles set credits=0 where id=$1',[actor]);expect((await t.ai.generate(v)).state).toBe('succeeded');expect(t.calls()).toBe(1);
},30000);

aiTest('CHAT: legacy workbench entry preserves old candidate and fixed-round conversation across relogin',async()=>{
 const t=await generationFixture();await t.ai.generate(await t.request());
 const before=await t.service.read(t.scope.projectId,t.scope.roundId);
 const {page,context}=await pageFor();
 await page.getByRole('button',{name:new RegExp(t.f.label)}).first().click();await quiet(page);
 await page.getByRole('button',{name:'在聊天中继续此轮次',exact:true}).click();
 await page.getByLabel('给当前步骤发消息').waitFor();const target=page.url();
 const conversationId=new URL(target).searchParams.get('conversation')!;
 const {skillChatService}=await import('../artifacts/chat');
 const restored=await skillChatService(t.user,db).read({conversationId});
 expect(restored.binding.roundId).toBe(t.scope.roundId);
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).candidates.map(c=>c.id)).toEqual(before.candidates.map(c=>c.id));
 await page.getByText('此步骤的历史回复（只读）',{exact:true}).click();
 expect(await page.getByRole('button',{name:'采用历史候选',exact:true}).count()).toBe(0);
 await context.close();
 const again=await pageFor();await again.page.goto(target);await again.page.getByLabel('给当前步骤发消息').waitFor();
 expect(new URL(again.page.url()).searchParams.get('conversation')).toBe(conversationId);await again.context.close();
},90000);

aiTest('CHAT: a late preceding result cannot enter a submitted turn without its sources',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 await t.service.execute({...t.scope,action:'userEvidence',requestId:randomUUID(),body:'SOURCE_E_RESTRICTABLE',observedAt:null,supersedes:null});
 let snap=await t.service.read(t.scope.projectId,t.scope.roundId);const evidenceId=snap.evidence[0].id;
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:snap.steps['step-0'].version,body:'A draft using E',evidenceIds:[evidenceId]});
 const a=randomUUID(),b=randomUUID();
 async function value(requestId:string,body:string){const s=await t.service.read(t.scope.projectId,t.scope.roundId);return {...t.scope,conversationId:binding.conversationId,turnId:requestId,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(s.steps).map(([k,x])=>[k,{version:x.version,reviewVersion:x.reviewVersion}]))};}
 await chat.submit({conversationId:binding.conversationId,requestId:a,stepId:'step-0',body:'A earlier turn'});
 let release!:()=>void,arrived!:()=>void;const hold=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>arrived=r);
 const slow=t.workbenchGeneration(t.user,db,async()=>{arrived();await hold;return {body:'LATE_A_ANSWER_WITH_SOURCE_E',inputTokens:800,outputTokens:30};});
 const av=await value(a,'A earlier turn'),aq=await slow.quote(av),running=slow.generate({...av,requestId:a,quoteHash:aq.quoteHash,budgetCredits:aq.reservedCredits});
 await seen;
 try {
  snap=await t.service.read(t.scope.projectId,t.scope.roundId);
  await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:snap.steps['step-0'].version,body:'Rewritten independent draft',evidenceIds:[]});
  await chat.submit({conversationId:binding.conversationId,requestId:b,stepId:'step-0',body:'B submitted before A result'});
 } finally {release();await running;}
 const bv=await value(b,'B submitted before A result'),bq=await t.ai.quote(bv);await t.ai.generate({...bv,requestId:b,quoteHash:bq.quoteHash,budgetCredits:bq.reservedCredits});
 expect(t.captured.at(-1)).not.toContain('LATE_A_ANSWER_WITH_SOURCE_E');expect(t.captured.at(-1)).not.toContain('A earlier turn');
 const fixed=(await sql.query('select context_turn_ids,evidence_ids from artifact_chat_turns where request_id=$1',[b])).rows[0];expect(fixed.context_turn_ids).toEqual([]);expect(fixed.evidence_ids).toEqual([]);
 await t.service.execute({...t.scope,action:'restrictEvidence',requestId:randomUUID(),evidenceId,deleted:true,expiresAt:null});
 const history=await chat.read({conversationId:binding.conversationId});expect(history.turns.find(x=>x.requestId===a)?.answer).toBeNull();expect(history.turns.find(x=>x.requestId===b)?.available).toBe(true);
},45000);

aiTest('CHAT: a delayed quote for edited input cannot offer or dispatch the old message',async()=>{
 const t=await generationFixture(),{page,context}=await pageFor();await page.goto(app+'/marketplace?module='+t.f.moduleId);await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();await page.getByLabel('给当前步骤发消息').waitFor();
 let release!:()=>void,arrived!:()=>void;const hold=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>arrived=r);
 await page.route('**/api/trpc/workbench.generationQuote*',async route=>{const response=await route.fetch();arrived();await hold;await route.fulfill({response});});
 await page.getByLabel('给当前步骤发消息').fill('QUOTED_A');await page.getByRole('button',{name:'发送',exact:true}).click();await seen;
 await page.getByLabel('给当前步骤发消息').fill('CURRENT_B');release();
 await expect.poll(async()=>await page.getByRole('button',{name:'发送',exact:true}).isEnabled(),{timeout:30000}).toBe(true);
 expect(await page.getByRole('button',{name:/积分/}).count()).toBe(0);expect(await t.ai.list(t.scope)).toHaveLength(0);expect(await page.getByLabel('给当前步骤发消息').inputValue()).toBe('CURRENT_B');await context.close();
},90000);

aiTest('CHAT: free and document UI send through ordinary streaming and restore the durable URL',async()=>{
 const t=await generationFixture();
 await sql.query("insert into system_settings(key,value) values('primary_model_id',$1),('assistant_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(localModel)]);
 const skillId=randomUUID(),moduleId=randomUUID();
 await sql.query("insert into skills(id,skill_key,draft_content) values($1,$2,'METHOD_CANARY_DOCUMENT_STREAM Private document instruction')",[skillId,skillId]);
 await sql.query("insert into modules(id,title,skill_id,model_id,active) values($1,'Document streaming fixture',$2,$3,true)",[moduleId,skillId,localModel]);
 expect((await db.rpc('atomic_publish_skill',{p_skill_id:skillId,p_published_by:owner})).error).toBeNull();
 const requests:string[]=[],{page,context}=await pageFor(credentials,requests);
 for(const module of [null,moduleId]) {
  if(module){await page.goto(app+'/marketplace?module='+module);await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();}
  else {await page.goto(app+'/');await page.getByRole('link',{name:'自由对话',exact:true}).click();}
  await page.getByTestId('chat-input').fill(module?'DOCUMENT_SEND':'FREE_SEND');
  const sent=page.waitForResponse(response=>response.url().includes('/api/ai/stream'));
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const response=await sent,responseText=await response.text();expect(response.status(),responseText).toBe(200);expect(responseText).not.toContain('METHOD_CANARY');
  await page.getByText('Synthetic local free/document reply',{exact:true}).waitFor({timeout:45000});
  await page.waitForURL(u=>u.pathname==='/chat'&&!!u.searchParams.get('conversation'),{timeout:30000});
  const conversationId=new URL(page.url()).searchParams.get('conversation');
  const row=(await t.user.from('conversations').select('module_id,skill_mode').eq('id',conversationId).single()).data;
  expect(row).toMatchObject({module_id:module,skill_mode:false});
  await page.reload();await page.getByText('Synthetic local free/document reply',{exact:true}).waitFor();expect(await page.getByLabel('Skill 步骤与成果').count()).toBe(0);
 }
 expect(requests.filter(path=>path.startsWith('/api/ai/stream'))).toHaveLength(2);
 expect((await sql.query('select count(*)::int n from artifact_generations where project_id=$1',[t.scope.projectId])).rows[0].n).toBe(0);
 await context.close();
},150000);

aiTest('CHAT: module rebinding enters the current Skill while preserving the former Skill history',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const old=await generationFixture(),chat=skillChatService(old.user,db);
 const previous=await chat.enter({moduleId:old.f.moduleId,requestId:randomUUID()});
 await sql.query('update artifact_workflows set enabled=false where id=$1',[old.f.registration]);
 expect(await chat.mode(old.f.moduleId)).toEqual({guided:true});
 await expect(chat.enter({moduleId:old.f.moduleId,requestId:randomUUID()})).rejects.toThrow('ARTIFACT_INVALID_WORKFLOW');
 await sql.query('update artifact_workflows set enabled=true where id=$1',[old.f.registration]);
 const newer={f:await fixture({id:'new-binding-'+randomUUID(),label:'Rebound Skill fixture',methodText:'Synthetic rebound method',workflow:makeWorkflow(3)})};await sql.query('update modules set skill_id=$1 where id=$2',[newer.f.pack.id,old.f.moduleId]);
 await sql.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',['rebind-'+randomUUID(),old.f.moduleId,newer.f.pack.id,newer.f.pack.revisionId,newer.f.flow,'Rebound current Skill']);
 expect((await old.service.projects()).filter(p=>p.skillId===newer.f.pack.id)).toHaveLength(0);
 const current=await chat.enter({moduleId:old.f.moduleId,requestId:randomUUID()});
 expect(current.skillId).toBe(newer.f.pack.id);expect(current.projectId).not.toBe(previous.projectId);
 expect((await chat.read({conversationId:previous.conversationId})).binding.skillId).toBe(old.f.pack.id);
 await expect(chat.submit({conversationId:previous.conversationId,requestId:randomUUID(),stepId:'step-0',body:'Old Skill new execution must fail'})).rejects.toThrow();
 expect((await chat.enter({moduleId:old.f.moduleId,requestId:randomUUID()})).projectId).toBe(current.projectId);
 const documentId=randomUUID();await sql.query("insert into skills(id,skill_key,draft_content) values($1,$2,'Rebound ordinary document')",[documentId,documentId]);
 expect((await db.rpc('atomic_publish_skill',{p_skill_id:documentId,p_published_by:owner})).error).toBeNull();
 await sql.query('update modules set skill_id=$1 where id=$2',[documentId,old.f.moduleId]);
 expect(await chat.mode(old.f.moduleId)).toEqual({guided:false});
},30000);


aiTest('CHAT: social rebind preserves the single-account project and explicitly refuses a replacement',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const old=await generationFixture(6),chat=skillChatService(old.user,db);
 const account=(await old.service.projects()).find(p=>p.projectId===old.scope.projectId)!.account!;
 const previous=await chat.enter({moduleId:old.f.moduleId,account,requestId:randomUUID()});
 const newer=await fixture({id:'social-rebind-'+randomUUID(),label:'New social method',methodText:'Synthetic new social method',workflow:makeWorkflow(6,true)});
 await sql.query('update modules set skill_id=$1 where id=$2',[newer.pack.id,old.f.moduleId]);
 const registration='social-rebound-'+randomUUID();
 await sql.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',[registration,old.f.moduleId,newer.pack.id,newer.pack.revisionId,newer.flow,'New social method']);
 await sql.query('insert into artifact_accounts values($1,$2,$3,$4)',[actor,old.f.moduleId,newer.pack.id,account]);
 await expect(chat.enter({moduleId:old.f.moduleId,account,requestId:randomUUID()})).rejects.toThrow('ARTIFACT_ACCOUNT_CONFLICT');
 // Direct start simulates another creator winning after the preflight read.
 await expect(old.service.start({projectId:randomUUID(),roundId:randomUUID(),requestId:randomUUID(),registration,account})).rejects.toThrow('ARTIFACT_ACCOUNT_CONFLICT');
 expect((await sql.query('select count(*)::int n from artifact_projects where actor_id=$1 and account=$2',[actor,account])).rows[0].n).toBe(1);
 expect((await chat.read({conversationId:previous.conversationId})).binding.skillId).toBe(old.f.pack.id);
 await expect(chat.submit({conversationId:previous.conversationId,requestId:randomUUID(),stepId:'step-0',body:'No execution under former binding'})).rejects.toThrow();
 const {page,context}=await pageFor();await page.goto(app+'/marketplace?module='+old.f.moduleId);await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();
 await page.getByRole('button',{name:'使用 · '+account,exact:true}).click();
 await page.getByText('此账号已有另一功能的项目，暂不能在新功能中开始。请从已有项目查看历史，原成果不会被修改。',{exact:true}).waitFor();
 expect(await page.getByRole('link',{name:'找回已有项目与正式报告',exact:true}).getAttribute('href')).toBe('/workbench');await context.close();
},90000);

aiTest('CHAT: ordinary init persists the URL without remounting; abort and error retain free/document identity',async()=>{
 const t=await generationFixture(),requests:string[]=[];
 await sql.query("insert into system_settings(key,value) values('primary_model_id',$1),('assistant_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(localModel)]);
 const skillId=randomUUID(),moduleId=randomUUID();await sql.query("insert into skills(id,skill_key,draft_content) values($1,$2,'Synthetic ordinary interrupted method')",[skillId,skillId]);
 expect((await db.rpc('atomic_publish_skill',{p_skill_id:skillId,p_published_by:owner})).error).toBeNull();
 await sql.query("insert into modules(id,title,skill_id,model_id,active) values($1,'Interrupted document',$2,$3,true)",[moduleId,skillId,localModel]);
 const {page,context}=await pageFor(credentials,requests);
 for(const mode of ['ORDINARY_ABORT','ORDINARY_ERROR']){
  await page.goto(mode==='ORDINARY_ABORT'?app+'/chat':app+'/chat?module='+moduleId);
  await page.getByTestId('chat-input').fill(mode);await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForURL(u=>!!u.searchParams.get('conversation'));
  await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 const conversationId=new URL(page.url()).searchParams.get('conversation')!;
  // Provider output is buffered for server-side checks, so stop while init is
  // visible and the provider is still pending rather than waiting for final text.
  await page.getByRole('button',{name:'停止',exact:true}).waitFor();
  expect(await page.getByTestId('chat-input').isDisabled()).toBe(true);
  if(mode==='ORDINARY_ABORT')await page.getByRole('button',{name:'停止',exact:true}).click();
  await expect.poll(async()=>await page.getByTestId('chat-input').isEnabled(),{timeout:30000}).toBe(true);
  if(mode==='ORDINARY_ABORT') {
 // Header navigation bypasses the sidebar's navigate callback; it must still reset scope.
 await page.getByRole('link',{name:'对话',exact:true}).click();await page.waitForURL(u=>u.pathname==='/chat'&&!u.search);
 expect(await page.getByTestId('chat-message').count()).toBe(0);
 await page.getByTestId('chat-input').fill('AFTER_HEADER_NEW_CHAT');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 const freshId=new URL(page.url()).searchParams.get('conversation')!;
 const fresh=(await t.user.from('conversations').select('module_id').eq('id',freshId).single()).data;expect(fresh?.module_id).toBeNull();
 await page.getByText('Synthetic local free/document reply',{exact:true}).waitFor();
  expect(freshId).not.toBe(conversationId);
  await page.goto(app+'/chat?conversation='+conversationId);
  }
  if(mode==='ORDINARY_ERROR') {
   await page.getByText('AI 响应生成失败，请稍后重试',{exact:true}).waitFor();
   expect((await sql.query("select status from ai_usage_logs where conversation_id=$1",[conversationId])).rows).toEqual([{status:'failed'}]);
   expect((await sql.query('select id from messages where conversation_id=$1',[conversationId])).rows).toHaveLength(0);
  }
  // Ordinary failure preserves conversation identity and failure usage, not unsaved input.
  await page.reload();await page.getByRole('heading',{name:mode,exact:true}).waitFor();
  expect(new URL(page.url()).searchParams.get('conversation')).toBe(conversationId);
  const row=(await t.user.from('conversations').select('module_id,skill_mode').eq('id',conversationId).single()).data;
  expect(row).toMatchObject({module_id:mode==='ORDINARY_ERROR'?moduleId:null,skill_mode:false});
 }
 expect(requests.filter(p=>p.startsWith('/api/ai/stream'))).toHaveLength(3);
 await context.close();
},150000);


aiTest('CHAT: removing prior evidence permits new context and safe same-text retry after a stale quote',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 await t.service.execute({...t.scope,action:'userEvidence',requestId:randomUUID(),body:'REMOVED_SOURCE_CANARY',observedAt:null,supersedes:null});
 let snap=await t.service.read(t.scope.projectId,t.scope.roundId);const evidenceId=snap.evidence[0].id;
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:snap.steps['step-0'].version,body:'Draft using original evidence',evidenceIds:[evidenceId]});
 async function value(requestId:string,body:string){const s=await t.service.read(t.scope.projectId,t.scope.roundId);return {...t.scope,conversationId:binding.conversationId,turnId:requestId,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(s.steps).map(([k,x])=>[k,{version:x.version,reviewVersion:x.reviewVersion}]))};}
 async function generate(requestId:string,body:string){await chat.submit({conversationId:binding.conversationId,requestId,stepId:'step-0',body});const v=await value(requestId,body),q=await t.ai.quote(v);return t.ai.generate({...v,requestId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits});}
 const a=randomUUID();expect((await generate(a,'OLD_TURN_WITH_REMOVED_SOURCE')).state).toBe('succeeded');
 const staleId=randomUUID(),retryBody='Continue with the independent rewritten draft';
 await chat.submit({conversationId:binding.conversationId,requestId:staleId,stepId:'step-0',body:retryBody});
 const staleValue=await value(staleId,retryBody),staleQuote=await t.ai.quote(staleValue);
 const {page,context}=await pageFor();await page.goto(app+'/chat?conversation='+binding.conversationId);
 await page.getByText('参考资料（可选）',{exact:true}).click();await page.getByRole('checkbox',{name:'关联到本步骤',exact:true}).uncheck();
 await page.getByLabel('当前步骤工作稿').fill('Independent rewritten draft');
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].evidenceIds,{timeout:30000}).toEqual([]);
 const b=randomUUID();expect((await generate(b,'NEW_INDEPENDENT_TURN')).state).toBe('succeeded');
 expect(t.captured.at(-1)).not.toContain('OLD_TURN_WITH_REMOVED_SOURCE');expect(t.captured.at(-1)).not.toContain('REMOVED_SOURCE_CANARY');
 const fixed=(await sql.query('select context_turn_ids,evidence_ids from artifact_chat_turns where request_id=$1',[b])).rows[0];expect(fixed).toEqual({context_turn_ids:[],evidence_ids:[]});
 expect((await chat.read({conversationId:binding.conversationId})).turns.find(x=>x.requestId===a)?.available).toBe(true);
 await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByLabel('给当前步骤发消息').fill(retryBody);await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect.poll(async()=>(await chat.read({conversationId:binding.conversationId})).turns.find(x=>x.requestId===staleId)?.abandoned,{timeout:30000}).toBe(true);
 await expect(t.ai.generate({...staleValue,requestId:staleId,quoteHash:staleQuote.quoteHash,budgetCredits:staleQuote.reservedCredits})).rejects.toThrow();expect(t.calls()).toBe(2);
 await expect.poll(async()=>page.getByRole('button',{name:'发送',exact:true}).isEnabled(),{timeout:30000}).toBe(true);
 expect(await page.getByRole('button',{name:'恢复原操作',exact:true}).count()).toBe(0);
 await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByLabel('当前步骤讨论').getByText('Synthetic local HTTP candidate',{exact:true}).waitFor();
 const turns=(await chat.read({conversationId:binding.conversationId})).turns,newTurn=turns.find(x=>x.body===retryBody&&x.requestId!==staleId)!;expect(newTurn.generationState).toBe('succeeded');
 expect((await sql.query('select context_turn_ids,evidence_ids from artifact_chat_turns where request_id=$1',[newTurn.requestId])).rows[0]).toEqual({context_turn_ids:[b],evidence_ids:[]});
 await t.service.execute({...t.scope,action:'restrictEvidence',requestId:randomUUID(),evidenceId,deleted:true,expiresAt:null});
 const history=await chat.read({conversationId:binding.conversationId});expect(history.turns.find(x=>x.requestId===a)?.available).toBe(false);expect(history.turns.find(x=>x.requestId===b)?.available).toBe(true);expect(history.turns.find(x=>x.requestId===newTurn.requestId)?.available).toBe(true);
 await context.close();
},90000);

aiTest('CHAT: autosave acknowledges a candidate while preserving edits made during its save', async()=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 let arrived!:()=>void,release!:()=>void,finished!:()=>void;const seen=new Promise<void>(r=>arrived=r),hold=new Promise<void>(r=>release=r),handled=new Promise<void>(r=>finished=r);
 await page.route('**/api/trpc/workbench.execute*',async route=>{const response=await route.fetch();arrived();await hold;await route.fulfill({response});finished();});
 await page.getByLabel('给当前步骤发消息').fill('First complete result');await page.getByRole('button',{name:'发送',exact:true}).click();await seen;
 await page.getByLabel('当前步骤工作稿').fill('User refinement during candidate save');release();await handled;await page.unroute('**/api/trpc/workbench.execute*');
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('User refinement during candidate save');
 const step=(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'];expect(step.version).toBe(2);expect(step.valid).toBe(false);
 await context.close();
},90000);

aiTest.each(['retry','reload'])('CHAT: autosave replays frozen save after lost acknowledgement via %s before newer edits',async(recovery)=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 let arrived!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>arrived=r),hold=new Promise<void>(r=>release=r);
 await page.route('**/api/trpc/workbench.execute*',async route=>{await route.fetch();arrived();await hold;await route.abort('failed');});
 await page.getByLabel('当前步骤工作稿').fill('Saved A with missing acknowledgement');await seen;
 await page.getByLabel('当前步骤工作稿').fill('Newer B must survive');release();
 await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();await page.unroute('**/api/trpc/workbench.execute*');
 expect(await page.getByRole('button',{name:'放弃本地编辑并载入已保存内容',exact:true}).isDisabled()).toBe(true);
 if(recovery==='reload') await page.reload(); else await page.getByRole('button',{name:'重试保存',exact:true}).click();
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('Newer B must survive');
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].version).toBe(2);
 await context.close();
},90000);

aiTest('CHAT: immediate browser back restores the unsaved draft and composer for the same authenticated conversation',async()=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 await page.goto(app+'/marketplace');await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 const url=page.url();await page.getByLabel('当前步骤工作稿').fill('Recover after immediate browser back');
 await page.getByLabel('给当前步骤发消息').fill('Unsent discussion survives');
 await page.goBack();await page.goto(url);
 await expect.poll(async()=>page.getByLabel('当前步骤工作稿').inputValue(),{timeout:30000}).toBe('Recover after immediate browser back');
 expect(await page.getByLabel('给当前步骤发消息').inputValue()).toBe('Unsent discussion survives');
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('Recover after immediate browser back');
 await context.close();
},90000);

aiTest('CHAT: a definite external save conflict releases the frozen attempt and permits explicit rebase',async()=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 await page.getByLabel('当前步骤工作稿').waitFor();
 await t.service.execute({...t.scope,action:'save',stepId:'step-0',requestId:randomUUID(),expectedVersion:0,body:'External version one',evidenceIds:[]});
 await page.getByLabel('当前步骤工作稿').fill('Local revision after external change');
 await page.getByText('保存版本已变化；本地输入已保留，请加载服务端版本并比较。',{exact:true}).waitFor();
 await expect.poll(async()=>page.getByRole('button',{name:'放弃本地编辑并载入已保存内容',exact:true}).isEnabled(),{timeout:30000}).toBe(true);
 await page.getByRole('button',{name:'保留本地内容，采用最新保存版本',exact:true}).click();
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('Local revision after external change');
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].version).toBe(2);
 await context.close();
},90000);

aiTest.each(['candidate','saved'])('CHAT: revoked inherited sources hide %s local drafts and frozen saves after browser restoration',async(kind)=>{
 const t=await generationFixture();
 await t.service.execute({...t.scope,action:'userEvidence',requestId:randomUUID(),body:'Inherited source E',observedAt:null,supersedes:null});
 const evidenceId=(await t.service.read(t.scope.projectId,t.scope.roundId)).evidence[0].id;
 await t.service.execute({...t.scope,action:'save',stepId:'step-0',requestId:randomUUID(),expectedVersion:0,body:'Basis from E',evidenceIds:[evidenceId]});
 let snap=await t.service.read(t.scope.projectId,t.scope.roundId);
 await t.service.execute({...t.scope,action:'confirm',stepId:'step-0',requestId:randomUUID(),expectedVersion:snap.steps['step-0'].version,expectedReviewVersion:snap.steps['step-0'].reviewVersion});
 if(kind==='saved')await t.service.execute({...t.scope,action:'save',stepId:'step-1',requestId:randomUUID(),expectedVersion:0,body:'Persisted descendant from E',evidenceIds:[]});
 const {page,context}=await pageFor(credentials,[]);
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));const chatUrl=page.url();
 await page.getByRole('button',{name:new RegExp('^2\\. '+t.f.flow.steps[1].title)}).click();
 await expect.poll(async()=>page.getByRole('button',{name:new RegExp('^2\\. '+t.f.flow.steps[1].title)}).getAttribute('aria-current'),{timeout:30000}).toBe('step');
 await page.route('**/api/trpc/workbench.execute*',route=>route.abort('failed'));
 if(kind==='candidate'){
  await page.getByLabel('给当前步骤发消息').fill('Draft a descendant result');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
 }
 await page.getByLabel('当前步骤工作稿').fill('REVOKED_LOCAL_DRAFT_CANARY');
 await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
 await page.getByRole('button',{name:'新建对话',exact:true}).click();await page.waitForURL(u=>!u.searchParams.has('conversation'));
 await page.unroute('**/api/trpc/workbench.execute*');
 await t.service.execute({...t.scope,action:'save',stepId:'step-0',requestId:randomUUID(),expectedVersion:1,body:'Independent rewritten ancestor',evidenceIds:[]});
 if(kind==='saved')await t.service.execute({...t.scope,action:'save',stepId:'step-1',requestId:randomUUID(),expectedVersion:1,body:'Independent rewritten descendant',evidenceIds:[]});
 await t.service.execute({...t.scope,action:'restrictEvidence',requestId:randomUUID(),evidenceId,deleted:true,expiresAt:null});
 const replayed:string[]=[];page.on('request',request=>{if(request.url().includes('workbench.execute'))replayed.push(request.postData()??'');});
 await page.goto(chatUrl);await expect.poll(async()=>page.getByLabel('当前步骤工作稿').isEnabled(),{timeout:30000}).toBe(true);
 expect(await page.getByLabel('当前步骤工作稿').inputValue()).not.toContain('REVOKED_LOCAL_DRAFT_CANARY');
 await page.waitForTimeout(1000);
 expect(replayed).toHaveLength(0);
 expect(await page.getByRole('button',{name:'恢复此版本到成果',exact:true}).count()).toBe(0);
 await context.close();
},120000);
