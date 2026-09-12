/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { saveModuleSkill, type ModuleSkillInput } from '../skills/modulePublication';
import { publishSkillPackage } from "../skills/publication";
import { makePackage, makeWorkflow } from "./fixtures/artifacts";
import { packageHash, packageHashPayload, sha256 } from "../skills/loader";
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
  if (!process.env.V3_REAL_SKILL_INPUT) for (const file of readdirSync(
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
    const prior = existsSync(output + "/restore.json") ? JSON.parse(readFileSync(output + "/restore.json", "utf8")) : null;
    const state = prior?.actor === actor ? prior : { credentials, fixtures, actor, owner };
    const service = workbenchService(await authenticated(), db);
    state.expectedSnapshots = [];
    state.expectedProjects = await service.projects();
    const catalogDiagnostic=await db.rpc('artifact_query',{p_actor_id:actor,p_action:'catalog'});
    console.log('WORKBENCH_PRE_RESTART_CATALOG',JSON.stringify({enabledWorkflows:Number((await sql.query('select count(*) n from artifact_workflows where enabled')).rows[0].n),error:catalogDiagnostic.error?.message??null,projects:state.expectedProjects.length}));
    for (const p of state.expectedProjects) {
      const rounds = await service.rounds(p.projectId);
      const current =
        rounds.find((r) => r.state === "draft") ??
        rounds
          .filter((r) => r.state === "published")
          .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? rounds[0];
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
    const catalogCheck=await db.rpc('artifact_query',{p_actor_id:actor,p_action:'catalog'});
    expect(catalogCheck.error, 'restore catalog must be readable').toBeNull();
    const saved = JSON.parse(readFileSync(output + "/restore.json", "utf8"));
    for (const f of fixtures) {
      const expected = saved.expectedSnapshots.find(
        (s: { skillId: string }) => s.skillId === f.pack.id,
      );
      const savedProject=saved.expectedProjects.find((p:{skillId:string})=>p.skillId===f.pack.id);
      const projectButton=page.getByRole("button", { name: new RegExp(`^${f.label}`) }).first();
      await expect.poll(async()=>projectButton.innerText(),{timeout:20000}).toContain('正式 v'+savedProject.currentVersion);
      await projectButton.click();
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
      "ARTIFACT_CANDIDATE_INVALIDATED",
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
const localSummaryModel = randomUUID();
async function generationFixture(n = 3, methodText = 'Synthetic generation method.', options: {workflow?: ReturnType<typeof makeWorkflow>; package?: ReturnType<typeof makePackage>} = {}) {
  const { workbenchGeneration } = await import('../artifacts/generation');
  const flow = options.workflow ?? makeWorkflow(n, n === 6); flow.report.title = `本地 AI ${randomUUID()}`;
  const f = await fixture({ id: `ai-${randomUUID()}`, label: flow.report.title, methodText, workflow: flow, package: options.package });
  await sql.query("insert into ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost) values($1,'openai/gpt-4o-mini-2024-07-18','Local fixture','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',150000,600000) on conflict(id) do nothing", [localModel]);
  await sql.query('update modules set model_id=$1 where id=$2', [localModel, f.moduleId]);
  await sql.query("insert into ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost) values($1,'openai/gpt-4o-2024-08-06','Summary fixture','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',150000,600000) on conflict(id) do nothing", [localSummaryModel]);
  await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(localSummaryModel)]);
  await sql.query("insert into system_settings(key,value) values('v3_workbench_ai','true') on conflict(key) do update set value='true'");
  await sql.query('update profiles set credits=100000 where id=$1', [actor]);
  const user = await authenticated(), service = workbenchService(user, db);
  const scope = { projectId: randomUUID(), roundId: randomUUID() };
  const account = n === 6 ? `synthetic:${randomUUID()}` : undefined;
  if (account) await sql.query('insert into artifact_accounts values($1,$2,$3,$4)', [actor, f.moduleId, f.pack.id, account]);
  await service.start({ ...scope, requestId: randomUUID(), registration: f.registration, account },f.moduleId);
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
aiTest('AI: verified provider refusal refunds once under concurrent replay and keeps dispatch authority private', async () => {
  const { ProviderRateLimited } = await import('../artifacts/generation');
  const t = await generationFixture(); let calls = 0;
  const ai = t.workbenchGeneration(t.user, db, async () => { calls++; throw new ProviderRateLimited(); });
  const v = await t.request(ai), result = await ai.generate(v);
  expect(result).toMatchObject({state:'refunded',chargedCredits:0,candidateId:null,failureCode:'provider_rate_limited'});
  const row=(await sql.query('select dispatch_token,pre_deduct_id from artifact_generations where request_id=$1',[v.requestId])).rows[0];
  const args={p_actor_id:actor,p_project_id:v.projectId,p_round_id:v.roundId,p_request_id:v.requestId,p_token:row.dispatch_token};
  const replays=await Promise.all(Array.from({length:4},()=>db.rpc('artifact_reject_generation',args)));
  for(const r of replays){expect(r.error).toBeNull();expect(r.data).toEqual(result);}
  expect(await ai.generate(v)).toEqual(result);expect(calls).toBe(1);
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100000);
  expect((await sql.query("select id from billing_history where operation_type='refund' and metadata->>'preDeductId'=$1",[row.pre_deduct_id])).rows).toHaveLength(1);
  expect((await t.service.read(v.projectId,v.roundId)).candidates).toHaveLength(0);
  for(const extra of [{p_actor_id:randomUUID()},{p_project_id:randomUUID()},{p_round_id:randomUUID()},{p_request_id:randomUUID()},{p_token:randomUUID()}])
    expect((await db.rpc('artifact_reject_generation',{...args,...extra})).error).not.toBeNull();
  expect((await t.user.rpc('artifact_reject_generation',args)).error).not.toBeNull();
  expect((await sql.query("select has_function_privilege('anon','public.artifact_reject_generation(uuid,uuid,uuid,uuid,uuid)','execute') as allowed")).rows[0].allowed).toBe(false);
  await sql.query("update profiles set status='banned' where id=$1",[actor]);
  try{expect((await db.rpc('artifact_reject_generation',args)).error).not.toBeNull();}
  finally{await sql.query("update profiles set status='active' where id=$1",[actor]);}
  const next=await t.request();expect((await t.ai.generate(next)).state).toBe('succeeded');
  const completed=(await sql.query('select dispatch_token from artifact_generations where request_id=$1',[next.requestId])).rows[0];
  expect((await db.rpc('artifact_reject_generation',{...args,p_request_id:next.requestId,p_token:completed.dispatch_token})).error).not.toBeNull();
  console.log('AI refusal: real SQL/Auth refund exactly once, scope/token/profile/anon denied, explicit retry and succeeded guard PASS');
},60000);
aiTest('AI: failed refund rolls back credit and status together; unknown requests cannot use refusal recovery',async()=>{
  const { ProviderRateLimited }=await import('../artifacts/generation');const t=await generationFixture();
  const ai=t.workbenchGeneration(t.user,db,async()=>{throw new ProviderRateLimited();}),v=await t.request(ai);
  await sql.query("create function local_fail_refusal() returns trigger language plpgsql as $$ begin if NEW.operation_type='refund' then raise exception 'local refund unavailable'; end if; return NEW; end $$; create trigger local_fail_refusal before insert on billing_history for each row execute function local_fail_refusal()");
  let result;
  try{result=await ai.generate(v);}finally{await sql.query('drop trigger local_fail_refusal on billing_history; drop function local_fail_refusal()');}
  expect(result!.state).toBe('unknown');
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100000-result!.reservedCredits);
  const row=(await sql.query('select dispatch_token,pre_deduct_id,failure_code from artifact_generations where request_id=$1',[v.requestId])).rows[0];
  expect(row.failure_code).toBeNull();
  expect((await db.rpc('artifact_reject_generation',{p_actor_id:actor,p_project_id:v.projectId,p_round_id:v.roundId,p_request_id:v.requestId,p_token:row.dispatch_token})).error).not.toBeNull();
  expect((await sql.query("select id from billing_history where operation_type='refund' and metadata->>'preDeductId'=$1",[row.pre_deduct_id])).rows).toHaveLength(0);
},30000);
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
  // Model policy rejects an impossible configured capacity before tokenization.
  try { await expect(t.ai.generate(v)).rejects.toThrow('GENERATION_UNSUPPORTED_MODEL'); }
  finally { await sql.query('update ai_models set input_limit=128000 where id=$1', [localModel]); }
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

aiTest('AI: research uses canonical credits and recovers settlement without fetching again',async()=>{
 const {databaseResearchStore}=await import('../research/store'),research=databaseResearchStore(db,actor);
 await sql.query('update profiles set credits=100 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 const planId=randomUUID(),operationId=randomUUID();await research.create(planId,1100000,[{operationId,identityHash:'a'.repeat(64),maxQuoteUnits:1100000}]);
 const r=await research.reserve(planId,operationId,'a'.repeat(64),1100000);
 const charge=async(action:string)=>{const r=await db.rpc('research_user_charge',{p_actor_id:actor,p_plan_id:planId,p_operation_id:operationId,p_action:action});if(r.error)throw r.error;};
 await Promise.all([charge('reserve'),charge('reserve')]);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(95);
 await charge('admit');await research.dispatch(planId,operationId,r.token!);
 await research.finish(planId,operationId,r.token!,'succeeded',{source:'agentkey',fixture:true,canonicalTool:'Tavily/post_search',objects:[],fetchedAt:new Date().toISOString(),pagination:{complete:true,nextCursor:null},error:null,cost:{unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'}});
 await sql.query("create function research_test_reject_spend() returns trigger language plpgsql as $$begin raise exception 'test settlement unavailable'; end$$; create trigger research_test_spend before insert on credit_transactions for each row execute function research_test_reject_spend()");
 try {await expect(charge('settle')).rejects.toBeTruthy();expect((await research.get(planId,operationId))?.state).toBe('succeeded');expect((await sql.query('select charged_credits from research_operations where id=$1',[operationId])).rows[0].charged_credits).toBeNull();}
 finally {await sql.query('drop trigger research_test_spend on credit_transactions; drop function research_test_reject_spend()');}
 await Promise.all([charge('settle'),charge('settle')]);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(95);
 expect((await sql.query('select count(*)::int n from credit_transactions where source_id=$1',[operationId])).rows[0].n).toBe(1);
 expect((await sql.query('select charged_credits from research_operations where id=$1',[operationId])).rows[0].charged_credits).toBe(5);
 const denied=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
 expect((await denied.rpc('research_user_charge',{p_actor_id:actor,p_plan_id:planId,p_operation_id:operationId,p_action:'settle'})).error).not.toBeNull();
 const chargedAt=(await sql.query('select charged_at from research_operations where id=$1',[operationId])).rows[0].charged_at;
 const start=new Date(chargedAt).toISOString(),end=new Date(new Date(chargedAt).getTime()+1000).toISOString();
 const totals=await db.rpc('research_billing_summary',{p_start:start,p_end:end});
 expect(totals.error).toBeNull();expect(totals.data).toEqual({count:1,credits:5});
 const excluded=await db.rpc('research_billing_summary',{p_start:start,p_end:start});
 expect(excluded.error).toBeNull();expect(excluded.data).toEqual({count:0,credits:0});
 expect((await denied.rpc('research_billing_summary',{p_start:start,p_end:end})).error).not.toBeNull();
 expect((await db.rpc('research_billing_summary',{p_start:end,p_end:start})).error).not.toBeNull();

},30000);

aiTest('AI: research refunds only a cancelled unsent reservation',async()=>{
 const {databaseResearchStore}=await import('../research/store'),research=databaseResearchStore(db,actor);
 await sql.query('update profiles set credits=100 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 for(const dispatched of [false,true]){
  const planId=randomUUID(),operationId=randomUUID();await research.create(planId,1100000,[{operationId,identityHash:'b'.repeat(64),maxQuoteUnits:1100000}]);const r=await research.reserve(planId,operationId,'b'.repeat(64),1100000);
  const charge=async(action:string)=>{const r=await db.rpc('research_user_charge',{p_actor_id:actor,p_plan_id:planId,p_operation_id:operationId,p_action:action});if(r.error)throw r.error;};
  await charge('reserve');if(dispatched)await research.dispatch(planId,operationId,r.token!);
  await research.cancel(planId);
  if(dispatched)await expect(charge('refund')).rejects.toBeTruthy();else await Promise.all([charge('refund'),charge('refund')]);
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(dispatched?95:100);
 }
},30000);

aiTest('AI: research billed store recovers cancellation across recreation and rejects missing price',async()=>{
 const {databaseBilledResearchStore}=await import('../research/store');let research=databaseBilledResearchStore(db,actor);
 await sql.query('update profiles set credits=100 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 const planId=randomUUID(),operations=[0,1].map(()=>({operationId:randomUUID(),identityHash:'c'.repeat(64),maxQuoteUnits:1100000}));
 await research.create(planId,2200000,operations);for(const op of operations)await research.reserve(planId,op.operationId,op.identityHash,1100000);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(90);
 research=databaseBilledResearchStore(db,actor);await research.cancel(planId);await research.cancel(planId);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100);
 const p=randomUUID(),o=randomUUID();await research.create(p,1100000,[{operationId:o,identityHash:'d'.repeat(64),maxQuoteUnits:1100000}]);
 await sql.query("update system_settings set value='0' where key='search_surcharge_credits'");
 await expect(research.reserve(p,o,'d'.repeat(64),1100000)).rejects.toThrow('RESEARCH_BILLING_UNAVAILABLE');
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100);
 await expect(research.dispatch(p,o,randomUUID())).rejects.toThrow('RESEARCH_BILLING_UNAVAILABLE');
 await sql.query("update system_settings set value='5' where key='search_surcharge_credits'");
 const r=await research.reserve(p,o,'d'.repeat(64),1100000);await research.dispatch(p,o,r.token!);
 await research.finish(p,o,r.token!,'succeeded',{source:'agentkey',fixture:true,canonicalTool:'Tavily/post_search',objects:[],fetchedAt:new Date().toISOString(),pagination:{complete:true,nextCursor:null},error:null,cost:{unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'}});
 await databaseBilledResearchStore(db,actor).get(p,o);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(95);
},30000);

aiTest('AI: research adoption waits for canonical settlement and preserves evidence restrictions',async()=>{
 const {databaseBilledResearchStore,databaseResearchStore}=await import('../research/store');
 const t=await generationFixture(),service=t.service,scope=t.scope;
 await sql.query('update profiles set credits=100 where id=$1',[actor]);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 const {researchIdentity}=await import('../research/agentKey'),{tavilyCapabilities,tavilyParameters}=await import('../research/tavilyContract');
 const query='Fixture query',stepId='step-0',identityHash=researchIdentity(tavilyCapabilities[0],tavilyParameters(query),{...scope,stepId});
 const billed=databaseBilledResearchStore(db,actor),raw=databaseResearchStore(db,actor),planId=randomUUID(),operationId=randomUUID();
 await billed.create(planId,1100000,[{operationId,identityHash,maxQuoteUnits:1100000}]);
 const reservation=await billed.reserve(planId,operationId,identityHash,1100000);
 await billed.dispatch(planId,operationId,reservation.token!);
 await raw.finish(planId,operationId,reservation.token!,'succeeded',{source:'agentkey',fixture:true,canonicalTool:'Tavily/post_search',objects:[],fetchedAt:new Date().toISOString(),pagination:{complete:true,nextCursor:null},error:null,cost:{unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'}});
 const command={action:'researchEvidence' as const,...scope,stepId,query,requestId:randomUUID(),planId,operationId};
 await sql.query("create function research_test_adopt_spend() returns trigger language plpgsql as $$begin raise exception 'test settlement unavailable'; end$$; create trigger research_test_adopt before insert on credit_transactions for each row execute function research_test_adopt_spend()");
 try {
  await expect(service.execute(command)).rejects.toThrow('RESEARCH_BILLING_UNAVAILABLE');
  expect((await service.read(scope.projectId,scope.roundId)).evidence).toHaveLength(0);
 } finally {await sql.query('drop trigger research_test_adopt on credit_transactions; drop function research_test_adopt_spend()');}
 const otherFixture=await fixture({id:'search-other-'+randomUUID(),label:'Other search project',methodText:'Synthetic other method',workflow:makeWorkflow(3)});
 const otherScope={projectId:randomUUID(),roundId:randomUUID()};await service.start({...otherScope,requestId:randomUUID(),registration:otherFixture.registration},otherFixture.moduleId);
 await expect(service.execute({...command,...otherScope})).rejects.toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
 await expect(service.execute({...command,stepId:'step-1'})).rejects.toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
 await service.execute(command);await service.execute(command);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(95);
 const saved=await service.read(scope.projectId,scope.roundId);expect(saved.evidence).toHaveLength(1);
 const foreign=await newUser(),foreignService=workbenchService(await authenticated(foreign),db);
 await expect(foreignService.execute({...command,requestId:randomUUID()})).rejects.toThrow();
 await service.execute({action:'restrictEvidence',...scope,requestId:randomUUID(),evidenceId:saved.evidence[0].id,deleted:true,expiresAt:null});
 await expect(service.execute({...command,requestId:randomUUID()})).rejects.toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
 expect((await sql.query('select count(*)::int n from credit_transactions where source_id=$1',[operationId])).rows[0].n).toBe(1);
},30000);

aiTest('AI: research host dispatches only explicit query and recovers without reconnecting',async()=>{
 const t=await generationFixture(),{workbenchSearch}=await import('../research/workbenchSearch');
 const {localMcpFixture}=await import('./fixtures/agentKeyServer'),{databaseBilledResearchStore}=await import('../research/store'),{tavilySchema}=await import('../research/tavilySchema');
 const name='Tavily/post_search',query='Fictional public exhibition planning';
 const wire={discovery:{tools:[{name}]},description:{name,category:'Search',provider:'Tavily',params:tavilySchema,cost:{credits_per_call:1.1},health:{healthy:true},execute_as:{name,params:{query:'<The search query to execute with Tavily.>'}}},result:{category:'search',provider:'Tavily',took_ms:10,data:{query,answer:null,follow_up_questions:null,images:[],response_time:0.01,results:[{id:'fixture-web-1',title:'Fictional guide',url:'https://example.test/guide',content:'Public fictional reference.',score:0.8,raw_content:null}],usage:{credits:1}}}};
 const fixture=await localMcpFixture(databaseBilledResearchStore(db,actor),'json',wire);let connections=0;
 const host=workbenchSearch(t.user,db,options=>{connections++;return fixture.connect(options);});
 const input={...t.scope,requestId:randomUUID(),stepId:'step-0',query};
 try {
  await sql.query("insert into system_settings(key,value) values('v3_web_search','false'),('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
  await expect(host.search(input)).rejects.toThrow('RESEARCH_DISABLED');expect(connections).toBe(0);
  await sql.query("update system_settings set value='true' where key='v3_web_search'");
  const before=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
  const result=await host.search(input);expect(result.state).toBe('succeeded');expect(result.result?.objects[0].fields.content).toBe('Public fictional reference.');
  expect(JSON.stringify(result)).not.toContain('quoted');expect(JSON.stringify(result)).not.toContain('agentkey-credit');
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(before-5);
  await sql.query("update system_settings set value='false' where key='v3_web_search'");
  expect(await host.search(input)).toEqual(result);expect(connections).toBe(1);expect(fixture.events.filter(e=>e==='execute')).toHaveLength(1);
  expect(fixture.executedParams).toEqual([{query,search_depth:'basic',max_results:3,auto_parameters:false,include_answer:false,include_raw_content:false,include_images:false,include_usage:true,topic:'general'}]);
  await expect(host.search({...input,query:'Changed query'})).rejects.toThrow();expect(connections).toBe(1);
  await expect(host.search({...input,actorId:actor} as never)).rejects.toThrow();
  const other=await generationFixture();
  await expect(host.search({...input,...other.scope})).rejects.toThrow();expect(connections).toBe(1);
  await sql.query("update system_settings set value='true' where key='v3_web_search'");
  const interrupted={...input,requestId:randomUUID()};
  await sql.query("create function research_host_reject_spend() returns trigger language plpgsql as $$begin raise exception 'test settlement unavailable'; end$$; create trigger research_host_spend before insert on credit_transactions for each row execute function research_host_reject_spend()");
  try {await expect(host.search(interrupted)).rejects.toThrow('RESEARCH_BILLING_UNAVAILABLE');}
  finally {await sql.query('drop trigger research_host_spend on credit_transactions; drop function research_host_reject_spend()');}
  expect((await sql.query('select state,charged_credits from research_operations where id=$1',[interrupted.requestId])).rows[0]).toEqual({state:'succeeded',charged_credits:null});
  await sql.query('update modules set active=false where id=$1',[t.f.moduleId]);
  try {
   expect((await host.search(interrupted)).state).toBe('succeeded');
   expect((await host.search(interrupted)).state).toBe('succeeded');
   await expect(host.search({...input,requestId:randomUUID()})).rejects.toThrow();
   expect(connections).toBe(2);expect(fixture.events.filter(e=>e==='execute')).toHaveLength(2);
   expect((await sql.query('select count(*)::int n from credit_transactions where source_id=$1',[interrupted.requestId])).rows[0].n).toBe(1);
  } finally {await sql.query('update modules set active=true where id=$1',[t.f.moduleId]);}
  const {getRateLimiter}=await import('../rateLimiter');
  try {
  for(let i=0;i<61;i++)getRateLimiter().check(actor,'ai');
  expect((await host.search(interrupted)).state).toBe('succeeded');
  const blocked={...input,requestId:randomUUID()};
  await expect(host.search(blocked)).rejects.toThrow('请求过于频繁');
  expect((await sql.query('select id from research_plans where id=$1',[blocked.requestId])).rows).toHaveLength(0);
  expect(connections).toBe(2);
  } finally {getRateLimiter().close();}
 } finally {await fixture.stop();}
},60000);
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
  const input={...t.scope,conversationId:binding.conversationId,turnId:requestId,purpose:'reply' as const,stepId,instruction:body,expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
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
 const summaryBinding=await chat.summary({conversationId:binding.conversationId,requestId:first.requestId});
 const summarySnapshot=await t.service.read(t.scope.projectId,t.scope.roundId);
 const summaryInput={...t.scope,conversationId:binding.conversationId,turnId:first.requestId,purpose:'summary' as const,stepId:'step-0',instruction:'FIRST_CHAT_REQUIREMENT',expectedSteps:Object.fromEntries(Object.entries(summarySnapshot.steps).map(([k,x])=>[k,{version:x.version,reviewVersion:x.reviewVersion}]))};
 const summaryQuote=await t.ai.quote(summaryInput),summaryResult=await t.ai.generate({...summaryInput,requestId:summaryBinding.requestId,quoteHash:summaryQuote.quoteHash,budgetCredits:summaryQuote.reservedCredits});
 await t.service.execute({...t.scope,requestId:randomUUID(),action:'saveCandidate',stepId:'step-0',expectedVersion:0,body:'Confirmed basis',candidateId:summaryResult.candidateId!});
 const saved=(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'];
 await t.service.execute({...t.scope,requestId:randomUUID(),action:'confirm',stepId:'step-0',expectedVersion:saved.version,expectedReviewVersion:saved.reviewVersion});
 await send('step-1','DEPENDENT_DISCUSSION');
 expect(t.captured.at(-1)).toContain('FIRST_CHAT_REQUIREMENT');expect(t.captured.at(-1)).not.toContain('UNRELATED_BRANCH_DISCUSSION');
 const restored=await skillChatService(await authenticated(),db).read({conversationId:binding.conversationId});
 expect(restored.binding.stepId).toBe('step-1');expect(restored.turns).toHaveLength(4);expect(t.calls()).toBe(5);expect((await chat.stats()).find(s=>s.conversationId===binding.conversationId)?.messageCount).toBe(8);
 const row=(await sql.query('select count(*)::int as n from messages where conversation_id=$1',[binding.conversationId])).rows[0];expect(row.n).toBe(0);
 const usage=(await sql.query('select count(*)::int as n from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1)',[t.scope.projectId])).rows[0];expect(usage.n).toBe(5);
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

aiTest('CHAT: HTTP 429 preserves the message and refunds; explicit retry receives a real local HTTP reply',async()=>{
 const t=await generationFixture(),requests:string[]=[];
 const {skillChatService}=await import('../artifacts/chat');
 const binding=await skillChatService(t.user,db).enter({...t.scope,requestId:randomUUID()});
 const {page,context}=await pageFor(credentials,requests);
 let releaseHistory!:()=>void;
 const heldHistory=new Promise<void>(r=>{releaseHistory=r;});
 await page.route('**/api/trpc/**',async route=>{
  if(route.request().url().includes('chat.getConversations'))await heldHistory;
  await route.continue();
 });
 try{
  await page.goto(app+'/chat?conversation='+binding.conversationId);
  const input=page.getByLabel('给当前步骤发消息'),send=page.getByRole('button',{name:'发送',exact:true});
  // Typing becomes available even when the entire sidebar statistics request is held.
  await input.fill('LOCAL_RATE_LIMIT_ONCE');releaseHistory();
  const stranger=await newUser(),foreign=await authenticated(stranger);
  const foreignId=randomUUID();
  await sql.query("insert into conversations(id,user_id,title,is_deleted,skill_mode) values($1,$2,'foreign','false',false)",[foreignId,(await foreign.auth.getUser()).data.user!.id]);
  for(const route of ['chatLocate','chatOpen']){
   const denied=await page.request.get(app+'/api/trpc/workbench.'+route,{params:{input:JSON.stringify({conversationId:foreignId})}});
   expect(denied.status()).toBe(403);expect(await denied.text()).not.toContain(foreignId);
   expect((await fetch(app+'/api/trpc/workbench.'+route+'?input='+encodeURIComponent(JSON.stringify({conversationId:binding.conversationId})))).status).toBe(401);
  }
  await send.click();
  await page.getByRole('status').filter({hasText:'AI 正在生成回复…'}).waitFor();
  await page.getByText('模型服务繁忙，本次未生成回复，预留积分已退还。消息已保留，请稍后重新发送。',{exact:true}).waitFor();
  expect(await input.inputValue()).toBe('LOCAL_RATE_LIMIT_ONCE');
  await expect.poll(()=>send.isEnabled(),{timeout:30000}).toBe(true);
  const list=await t.ai.list(t.scope);expect(list).toHaveLength(1);expect(list[0]).toMatchObject({state:'refunded',chargedCredits:0});
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100000);
  expect(await page.locator('[data-message-role="assistant"]').count()).toBe(0);
  expect(requests.some(p=>p.includes('workbench.chatOpen'))).toBe(true);
  expect(requests.some(p=>p.includes('workbench.chatRead'))).toBe(false);
  // Reproduce an older client that closed before clearing its delivery journal.
  await page.evaluate(({scope,conversationId,requestId})=>sessionStorage.setItem(`workbench-receipts:${scope.projectId}:${scope.roundId}:pending`,JSON.stringify({...scope,conversationId,requestId})),{scope:t.scope,conversationId:binding.conversationId,requestId:list[0].requestId});
  await page.reload();await expect.poll(()=>send.isEnabled(),{timeout:30000}).toBe(true);
  expect(await input.inputValue()).toBe('LOCAL_RATE_LIMIT_ONCE');
  expect(await page.getByRole('button',{name:'恢复原发送状态',exact:true}).count()).toBe(0);
  await send.click();
  await expect.poll(()=>page.locator('[data-message-role="assistant"]').count(),{timeout:30000}).toBe(1);
  await expect.poll(()=>input.inputValue(),{timeout:30000}).toBe('');
  await expect.poll(async()=> (await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('Synthetic local HTTP candidate');
  await page.screenshot({path:output+'/chat-rate-limit-retry.png'});
 }finally{releaseHistory();await context.close();}
 console.log('CHAT local browser HTTP 429: one refund, retained input, manual retry and reply plus saved summary PASS');
},90000);

aiTest('CHAT: summary HTTP 429 keeps the paid reply and retries only the summary',async()=>{
 const t=await generationFixture();const {skillChatService}=await import('../artifacts/chat');
 const binding=await skillChatService(t.user,db).enter({...t.scope,requestId:randomUUID()});
 const {page,context}=await pageFor();
 try{
  await page.goto(app+'/chat?conversation='+binding.conversationId);
  const input=page.getByLabel('给当前步骤发消息');await input.fill('LOCAL_SUMMARY_RATE_LIMIT_ONCE');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('成果整理服务繁忙，整理预留积分已退还。已有回复保留，请稍后点击“继续整理成果”。',{exact:true}).waitFor();
  expect(await input.inputValue()).toBe('');
  expect(await page.locator('[data-message-role="assistant"]').count()).toBe(1);
  const before=await t.ai.list(t.scope);expect(before).toHaveLength(2);
  const reply=before.find(g=>g.state==='succeeded')!;expect(reply.chargedCredits).toBeGreaterThan(0);
  expect(before.find(g=>g.state==='refunded')).toMatchObject({chargedCredits:0,failureCode:'provider_rate_limited'});
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100000-reply.chargedCredits!);
  const retry=page.getByRole('button',{name:'继续整理成果',exact:true});
  await expect.poll(()=>retry.isEnabled(),{timeout:30000}).toBe(true);await retry.click();
  await expect.poll(async()=> (await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('Synthetic local HTTP candidate');
  expect(await page.locator('[data-message-role="assistant"]').count()).toBe(1);
  const rows=(await sql.query("select input->>'purpose' as purpose,state from artifact_generations where project_id=$1",[t.scope.projectId])).rows;
  expect(rows.filter(g=>g.purpose==='reply')).toEqual([{purpose:'reply',state:'succeeded'}]);
  expect(rows.filter(g=>g.purpose==='summary').map(g=>g.state).sort()).toEqual(['refunded','succeeded']);
  expect((await t.ai.list(t.scope)).find(g=>g.requestId===reply.requestId)).toEqual(reply);
 }finally{await context.close();}
 console.log('CHAT summary 429: reply retained and charged once; only summary reservation refunded and retried PASS');
},90000);

aiTest('CHAT: late initial read cannot overwrite a newer explicit refresh',async()=>{
 const t=await generationFixture();const {skillChatService}=await import('../artifacts/chat');
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'EARLIER_DRAFT',evidenceIds:[]});
 const binding=await skillChatService(t.user,db).enter({...t.scope,requestId:randomUUID()});
 const {page,context}=await pageFor();let first=true,release!:()=>void,arrived!:()=>void;
 const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{arrived=r;});
 await page.route('**/api/trpc/workbench.chatOpen*',async route=>{
  if(!first){await route.continue();return;}first=false;
  const response=await route.fetch();arrived();await held;await route.fulfill({response});
 });
 try{
  await page.goto(app+'/chat?conversation='+binding.conversationId);await ready;
  await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:1,body:'LATEST_AUTHORITATIVE_DRAFT',evidenceIds:[]});
  await page.getByRole('button',{name:'刷新状态',exact:true}).click();
  const draft=page.getByLabel('当前步骤工作稿');
  await expect.poll(()=>draft.inputValue(),{timeout:30000}).toBe('LATEST_AUTHORITATIVE_DRAFT');
  const late=page.waitForResponse(r=>r.url().includes('/workbench.chatOpen'));release();await late;
  await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  expect(await draft.inputValue()).toBe('LATEST_AUTHORITATIVE_DRAFT');
 }finally{release();await context.close();}
 console.log('CHAT late initial read: newer authoritative refresh remains visible PASS');
},60000);

aiTest.each([3,6,8,4])('CHAT: %i configured steps share durable linkage and generation',async(n)=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(n),chat=skillChatService(t.user,db);
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Manual topic: pet action photography',evidenceIds:[]});
 const binding=await chat.enter({...t.scope,requestId:randomUUID()}),requestId=randomUUID(),body='Synthetic configured conversation';
 await chat.submit({conversationId:binding.conversationId,requestId,stepId:'step-0',body});
 const v={...await t.request(),conversationId:binding.conversationId,turnId:requestId,purpose:'reply' as const,requestId,instruction:body};
 const q=await t.ai.quote({projectId:v.projectId,roundId:v.roundId,stepId:v.stepId,conversationId:v.conversationId,turnId:v.turnId,purpose:'reply' as const,instruction:body,expectedSteps:v.expectedSteps});
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
 const snapshot=await t.service.read(t.scope.projectId,t.scope.roundId),value={...t.scope,conversationId:binding.conversationId,turnId:requestId,purpose:'reply' as const,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const q=await t.ai.quote(value);await t.ai.generate({...value,requestId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits});
 const before=(await sql.query('select count(*)::int n from billing_history')).rows[0].n;
 await t.service.execute({...t.scope,action:'restrictEvidence',requestId:randomUUID(),evidenceId:evidence.id,deleted:true,expiresAt:null});
 const read=await chat.read({conversationId:binding.conversationId});expect(JSON.stringify(read)).not.toContain('SENSITIVE_CONTEXT_CANARY');expect(read.turns[0]).toMatchObject({available:false,body:null,answer:null});
 await expect(chat.submit({conversationId:binding.conversationId,requestId:randomUUID(),stepId:'step-0',body:'Continue'})).rejects.toThrow();
 expect((await sql.query('select count(*)::int n from billing_history')).rows[0].n).toBe(before);
 const plain=await t.user.from('messages').insert({conversation_id:binding.conversationId,role:'user',content:'Must not use ordinary messages'});expect(plain.error?.code).toBe('42501');
},30000);

aiTest('CHAT: module Use selects guided mode; free and ordinary document history survive unrelated catalog failure',async()=>{
 await sql.query("insert into system_settings(key,value) values('home_show_onboarding','true') on conflict(key) do update set value='true'");
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
 const value={...t.scope,conversationId:binding.conversationId,turnId:requestId,purpose:'reply' as const,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))},q=await t.ai.quote(value),v={...value,requestId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits};
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
 async function value(requestId:string,body:string){const s=await t.service.read(t.scope.projectId,t.scope.roundId);return {...t.scope,conversationId:binding.conversationId,turnId:requestId,purpose:'reply' as const,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(s.steps).map(([k,x])=>[k,{version:x.version,reviewVersion:x.reviewVersion}]))};}
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
 await sql.query("insert into system_settings(key,value) values('home_show_onboarding','true') on conflict(key) do update set value='true'");
 const t=await generationFixture();
 await sql.query("update ai_models set enable_web_search='true' where id=$1",[localModel]);
 await sql.query("insert into system_settings(key,value) values('enable_smart_search_decision','true') on conflict(key) do update set value='true'");
 await sql.query("insert into system_settings(key,value) values('primary_model_id',$1),('assistant_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(localModel)]);
 const skillId=randomUUID(),moduleId=randomUUID();
 await sql.query("insert into skills(id,skill_key,draft_content) values($1,$2,'METHOD_CANARY_DOCUMENT_STREAM Private document instruction')",[skillId,skillId]);
 await sql.query("insert into modules(id,title,skill_id,model_id,active) values($1,'Document streaming fixture',$2,$3,true)",[moduleId,skillId,localModel]);
 expect((await db.rpc('atomic_publish_skill',{p_skill_id:skillId,p_published_by:owner})).error).toBeNull();
 const requests:string[]=[],{page,context}=await pageFor(credentials,requests);
 for(const module of [null,moduleId]) {
  if(module){await page.goto(app+'/marketplace?module='+module);await page.getByRole('dialog').getByRole('button',{name:'立即使用',exact:true}).click();}
  else {await page.goto(app+'/');await page.getByRole('link',{name:'自由对话',exact:true}).click();}
  await page.getByTestId('chat-input').fill(module?'搜索最新资料后总结：DOCUMENT_SEND':'FREE_SEND');
  const sent=page.waitForResponse(response=>response.url().includes('/api/ai/stream'));
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const response=await sent;expect(response.status()).toBe(200);
  // The durable URL navigation can release Chromium's old SSE body handle.
  // Verify rendered and persisted public output rather than that CDP handle.
  expect(await page.locator('body').textContent()).not.toContain('METHOD_CANARY');
  await page.getByText('Synthetic local free/document reply',{exact:true}).waitFor({timeout:45000});
  await page.waitForURL(u=>u.pathname==='/chat'&&!!u.searchParams.get('conversation'),{timeout:30000});
  const conversationId=new URL(page.url()).searchParams.get('conversation');
  const row=(await t.user.from('conversations').select('module_id,skill_mode').eq('id',conversationId).single()).data;
  expect(row).toMatchObject({module_id:module,skill_mode:false});
  await page.reload();await page.getByText('Synthetic local free/document reply',{exact:true}).waitFor();expect(await page.getByLabel('Skill 步骤与成果').count()).toBe(0);
 }
 expect(requests.filter(path=>path.startsWith('/api/ai/stream'))).toHaveLength(2);
 const providerCalls=await (await fetch(url+'/__document_model_calls')).json();
 expect(providerCalls).toHaveLength(2);
 for(const call of providerCalls)expect(call).toMatchObject({plugins:[{id:'web',enabled:false}],tools:[],tool_choice:'none',performedQueries:0});
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
  await page.getByRole('button',{name:'停止等待',exact:true}).waitFor();
  expect(await page.getByTestId('chat-input').isDisabled()).toBe(true);
  if(mode==='ORDINARY_ABORT')await page.getByRole('button',{name:'停止等待',exact:true}).click();
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
   await expect.poll(async()=>(await sql.query('select state from ordinary_chat_requests where conversation_id=$1',[conversationId])).rows[0]?.state,{timeout:30000}).toBe('unknown');
   expect((await sql.query("select id from billing_history where operation_type IN ('refund','settle') AND metadata->>'preDeductId'=(select pre_deduct_id::text from ordinary_chat_requests where conversation_id=$1)",[conversationId])).rows).toHaveLength(0);
   expect((await sql.query('select id from messages where conversation_id=$1',[conversationId])).rows).toHaveLength(0);
  }
  // Unknown delivery retains identity and reservation; it is not a failure refund.
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
 async function value(requestId:string,body:string){const s=await t.service.read(t.scope.projectId,t.scope.roundId);return {...t.scope,conversationId:binding.conversationId,turnId:requestId,purpose:'reply' as const,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(s.steps).map(([k,x])=>[k,{version:x.version,reviewVersion:x.reviewVersion}]))};}
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

aiTest.each(['openai','qwen','luna'])('CHAT: dual model stages persist separate usage and only summary becomes a result with %s',async(provider)=>{
 const {skillChatService}=await import('../artifacts/chat');
 const flow=makeWorkflow(3);flow.steps[0].maxLength=100;
 const dialogue='Let us refine the event together. '.repeat(5);
 const t=await generationFixture(3,'Synthetic generation method.',{workflow:flow}),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 const primaryId=provider==='qwen'?randomUUID():localModel;
 if(provider==='qwen'){
  await sql.query("insert into ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost,tokenizer_family) values($1,'qwen/qwen3.8-flash','Qwen fixture','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',150000,470000,'openai')",[primaryId]);
  await sql.query('update modules set model_id=$1 where id=$2',[primaryId,t.f.moduleId]);
 }
 const summaryId=randomUUID();
 await sql.query("insert into ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost) values($1,$2,'Separate summary fixture','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',200000,1200000)",[summaryId,provider==='luna'?'openai/gpt-5.6-luna':'openai/gpt-4o-2024-08-06']);
 await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(summaryId)]);
 const seen:string[]=[];
 const ai=t.workbenchGeneration(t.user,db,async request=>{
  seen.push(request.model.id);
  return {body:request.model.id===summaryId?'Combined result: family audience, budget 1200.':dialogue,inputTokens:800,outputTokens:30};
 });
 const turnId=randomUUID(),body='Plan a family event';
 await chat.submit({conversationId:binding.conversationId,requestId:turnId,stepId:'step-0',body});
 const expectedSteps=Object.fromEntries(Object.entries((await t.service.read(t.scope.projectId,t.scope.roundId)).steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]));
 const input={...t.scope,conversationId:binding.conversationId,turnId,stepId:'step-0',instruction:body,expectedSteps,purpose:'reply' as const};
 const quote=await ai.quote(input),replyRequest={...input,requestId:turnId,quoteHash:quote.quoteHash,budgetCredits:quote.reservedCredits};
 const reply=await ai.generate(replyRequest);expect(reply.state).toBe('succeeded');
 await expect(t.service.execute({...t.scope,action:'saveCandidate',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Must not save dialogue',candidateId:reply.candidateId!})).rejects.toThrow();
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body).toBe('');
 const summaryBinding=await chat.summary({conversationId:binding.conversationId,requestId:turnId});
 expect(await chat.summary({conversationId:binding.conversationId,requestId:turnId})).toEqual(summaryBinding);
 const summaryInput={...input,purpose:'summary' as const};
 // Configuration changes cannot make the parent's actual model the organizer.
 await sql.query('update modules set model_id=$1 where id=$2',[summaryId,t.f.moduleId]);
 await sql.query("update system_settings set value=$1 where key='v3_summary_model_id'",[JSON.stringify(primaryId)]);
 await expect(ai.quote(summaryInput)).rejects.toThrow('SUMMARY_MODEL_MUST_DIFFER');
 const aliasId=randomUUID();
 await sql.query("insert into ai_models(id,model_id,name,api_key,api_endpoint) select $1,model_id,'Parent alias fixture','LOCAL_SYNTHETIC_KEY',api_endpoint from ai_models where id=$2",[aliasId,primaryId]);
 await sql.query("update system_settings set value=$1 where key='v3_summary_model_id'",[JSON.stringify(aliasId)]);
 await expect(ai.quote(summaryInput)).rejects.toThrow('SUMMARY_MODEL_MUST_DIFFER');
 expect(seen).toEqual([primaryId]);
 await sql.query('update modules set model_id=$1 where id=$2',[primaryId,t.f.moduleId]);
 await sql.query("update system_settings set value=$1 where key='v3_summary_model_id'",[JSON.stringify(summaryId)]);
 const summaryQuote=await ai.quote(summaryInput);
 const request={...summaryInput,requestId:summaryBinding.requestId,quoteHash:summaryQuote.quoteHash,budgetCredits:summaryQuote.reservedCredits};
 const result=await ai.generate(request);expect(result.state).toBe('succeeded');
 expect((await ai.generate(request)).candidateId).toBe(result.candidateId);
 expect((await ai.generate(replyRequest)).candidateId).toBe(reply.candidateId);
 expect(seen).toEqual([primaryId,summaryId]);
 // Exercise the SQL admission trigger directly as well as service preflight.
 // A different row UUID cannot admit a quote using the immutable parent model.
 for(const sameRecord of [true,false]){
  await expect(sql.query(`insert into artifact_generations select (jsonb_populate_record(null::artifact_generations,
   to_jsonb(g)||jsonb_build_object('id',$3::uuid,'state','prepared','candidate_id',null,'result',null,
    'quote',g.quote||jsonb_build_object('modelId',$4::text,'providerModel',(select quote->>'providerModel' from artifact_generations where project_id=$1 and request_id=$5))))) .*
   from artifact_generations g where g.project_id=$1 and g.request_id=$2`,
   [t.scope.projectId,summaryBinding.requestId,randomUUID(),sameRecord?primaryId:aliasId,turnId])).rejects.toMatchObject({code:'42501',message:'summary source denied'});
 }
 if(provider==='qwen'){const quoteRow=await sql.query('select quote from artifact_generations where project_id=$1 and request_id=$2',[t.scope.projectId,turnId]);expect(quoteRow.rows[0].quote.providerModel).toBe('qwen/qwen3.8-flash');expect(quoteRow.rows[0].quote.inputTokens).toBe(128000-4096);}
 await t.service.execute({...t.scope,action:'saveCandidate',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Combined result: family audience, budget 1200.',candidateId:result.candidateId!});
 const view=await chat.read({conversationId:binding.conversationId});
 expect(view.turns).toHaveLength(1);expect(view.turns[0]).toMatchObject({answer:dialogue,summaryState:'succeeded',summaryCandidateId:result.candidateId,generationMode:'dual'});
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].valid).toBe(false);
 const logs=await sql.query("select metadata->>'role' role from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1) order by metadata->>'role'",[t.scope.projectId]);
 expect(logs.rows.map(x=>x.role)).toEqual(['reply','summary']);
 await sql.query("delete from system_settings where key='v3_summary_model_id'");
},60000);

aiTest('CHAT: missing summary configuration and unknown summary never replay the paid reply',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Previously saved result',evidenceIds:[]});
 const seen:string[]=[];const ai=t.workbenchGeneration(t.user,db,async req=>{seen.push(req.model.id);if(req.model.id===localSummaryModel)throw new Error('Synthetic lost provider result');return {body:'Dialogue answer survives',inputTokens:800,outputTokens:30};});
 const turnId=randomUUID(),body='Change budget';await chat.submit({conversationId:binding.conversationId,requestId:turnId,stepId:'step-0',body});
 const snap=await t.service.read(t.scope.projectId,t.scope.roundId),input={...t.scope,conversationId:binding.conversationId,turnId,stepId:'step-0',instruction:body,purpose:'reply' as const,expectedSteps:Object.fromEntries(Object.entries(snap.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const q=await ai.quote(input);const reply=await ai.generate({...input,requestId:turnId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits});expect(reply.state).toBe('succeeded');
 const sb=await chat.summary({conversationId:binding.conversationId,requestId:turnId}),summaryInput={...input,purpose:'summary' as const};
 await sql.query("delete from system_settings where key='v3_summary_model_id'");
 await expect(ai.quote(summaryInput)).rejects.toThrow('SUMMARY_MODEL_NOT_CONFIGURED');expect(seen).toEqual([localModel]);
 expect((await chat.read({conversationId:binding.conversationId})).turns[0].answer).toBe('Dialogue answer survives');
 await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1)",[JSON.stringify(localSummaryModel)]);
 const sq=await ai.quote(summaryInput),request={...summaryInput,requestId:sb.requestId,quoteHash:sq.quoteHash,budgetCredits:sq.reservedCredits};
 await expect(ai.generate({...request,requestId:randomUUID()})).rejects.toThrow('ARTIFACT_DENIED');
 expect((await ai.generate(request)).state).toBe('unknown');expect((await ai.generate(request)).state).toBe('unknown');
 expect(await chat.summary({conversationId:binding.conversationId,requestId:turnId})).toEqual(sb);
 expect(seen).toEqual([localModel,localSummaryModel]);
 const restored=await skillChatService(await authenticated(),db).read({conversationId:binding.conversationId});
 expect(restored.turns[0]).toMatchObject({answer:'Dialogue answer survives',summaryState:'unknown',summaryCandidateId:null});
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body).toBe('Previously saved result');
 expect((await sql.query('select count(*)::int n from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1)',[t.scope.projectId])).rows[0].n).toBe(1);
},60000);

aiTest('CHAT: summary dispatched before source revocation settles once but remains unreadable',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 await t.service.execute({...t.scope,action:'userEvidence',requestId:randomUUID(),body:'Restricted test reference',observedAt:null,supersedes:null});
 const evidenceId=(await t.service.read(t.scope.projectId,t.scope.roundId)).evidence[0].id;
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Source-backed saved basis',evidenceIds:[evidenceId]});
 let calls=0;const ai=t.workbenchGeneration(t.user,db,async req=>{
  calls++;
  if(req.model.id===localSummaryModel)await t.service.execute({...t.scope,action:'restrictEvidence',requestId:randomUUID(),evidenceId,deleted:true,expiresAt:null});
  return {body:'Known response with restricted source',inputTokens:800,outputTokens:30};
 });
 const turnId=randomUUID(),body='Discuss the reference';await chat.submit({conversationId:binding.conversationId,requestId:turnId,stepId:'step-0',body});
 const snap=await t.service.read(t.scope.projectId,t.scope.roundId),input={...t.scope,conversationId:binding.conversationId,turnId,stepId:'step-0',instruction:body,purpose:'reply' as const,expectedSteps:Object.fromEntries(Object.entries(snap.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const q=await ai.quote(input);expect((await ai.generate({...input,requestId:turnId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits})).state).toBe('succeeded');
 const sb=await chat.summary({conversationId:binding.conversationId,requestId:turnId}),si={...input,purpose:'summary' as const},sq=await ai.quote(si),request={...si,requestId:sb.requestId,quoteHash:sq.quoteHash,budgetCredits:sq.reservedCredits};
 const done=await ai.generate(request);expect(done.state).toBe('succeeded');
 expect((await ai.generate(request)).state).toBe('succeeded');expect(calls).toBe(2);
 const view=await t.service.read(t.scope.projectId,t.scope.roundId);expect(view.candidates.find(c=>c.id===done.candidateId)?.body).toBeNull();
 expect((await chat.read({conversationId:binding.conversationId})).turns[0]).toMatchObject({answer:null,available:false,summaryState:'succeeded'});
 await expect(t.service.execute({...t.scope,action:'saveCandidate',requestId:randomUUID(),stepId:'step-0',expectedVersion:1,body:'Forbidden result',candidateId:done.candidateId!})).rejects.toThrow();
 expect((await sql.query('select count(*)::int n from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1)',[t.scope.projectId])).rows[0].n).toBe(2);
},60000);

aiTest('CHAT: a summary rejected before dispatch can restart without replaying the reply',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 const turnId=randomUUID(),body='Refine activity';await chat.submit({conversationId:binding.conversationId,requestId:turnId,stepId:'step-0',body});
 async function input(purpose:'reply'|'summary') {const snap=await t.service.read(t.scope.projectId,t.scope.roundId);return {...t.scope,conversationId:binding.conversationId,turnId,stepId:'step-0',instruction:body,purpose,expectedSteps:Object.fromEntries(Object.entries(snap.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};}
 const ri=await input('reply'),rq=await t.ai.quote(ri);expect((await t.ai.generate({...ri,requestId:turnId,quoteHash:rq.quoteHash,budgetCredits:rq.reservedCredits})).state).toBe('succeeded');
 const old=await chat.summary({conversationId:binding.conversationId,requestId:turnId}),si=await input('summary'),sq=await t.ai.quote(si),oldRequest={...si,requestId:old.requestId,quoteHash:sq.quoteHash,budgetCredits:sq.reservedCredits};
 await t.service.execute({...t.scope,action:'save',requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Edited after summary quote',evidenceIds:[]});
 await expect(t.ai.generate(oldRequest)).rejects.toThrow('GENERATION_CONFLICT');
 expect((await t.ai.abandon({...t.scope,requestId:old.requestId})).abandoned).toBe(true);
 const next=await chat.summary({conversationId:binding.conversationId,requestId:turnId});expect(next.requestId).not.toBe(old.requestId);
 expect(await chat.summary({conversationId:binding.conversationId,requestId:turnId})).toEqual(next);
 await expect(t.ai.generate(oldRequest)).rejects.toThrow();
 const ni=await input('summary'),nq=await t.ai.quote(ni);expect((await t.ai.generate({...ni,requestId:next.requestId,quoteHash:nq.quoteHash,budgetCredits:nq.reservedCredits})).state).toBe('succeeded');
 expect(t.calls()).toBe(2);
 expect((await sql.query('select count(*)::int n from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1)',[t.scope.projectId])).rows[0].n).toBe(2);
},60000);

aiTest.each(['recover','dismiss','closed','remote-dirty','remote-frozen','remote-unknown','save-race','save-receipt'])('CHAT: server-only summary recovery respects %s state',async(mode)=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 const turnId=randomUUID(),body='A fictional event request';await chat.submit({conversationId:binding.conversationId,requestId:turnId,stepId:'step-0',body});
 let calls=0;const ai=t.workbenchGeneration(t.user,db,async req=>{calls++;if(mode==='closed'&&req.model.id===localSummaryModel)await t.service.execute({...t.scope,action:'abandon',requestId:randomUUID()});return {body:req.model.id===localSummaryModel?'Saved summary from a different browser session':'A dialogue response',inputTokens:800,outputTokens:30};});
 const snap=await t.service.read(t.scope.projectId,t.scope.roundId),input={...t.scope,conversationId:binding.conversationId,turnId,stepId:'step-0',instruction:body,purpose:'reply' as const,expectedSteps:Object.fromEntries(Object.entries(snap.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const q=await ai.quote(input);expect((await ai.generate({...input,requestId:turnId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits})).state).toBe('succeeded');
 const sb=await chat.summary({conversationId:binding.conversationId,requestId:turnId}),si={...input,purpose:'summary' as const},sq=await ai.quote(si);expect((await ai.generate({...si,requestId:sb.requestId,quoteHash:sq.quoteHash,budgetCredits:sq.reservedCredits})).state).toBe('succeeded');
 if(mode==='save-race'||mode==='save-receipt') {
  const candidateId=(await chat.read({conversationId:binding.conversationId})).turns[0].summaryCandidateId!;
  const save={...t.scope,action:'saveCandidate' as const,requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'Saved summary from a different browser session',candidateId};
  if(mode==='save-receipt') {
   await t.service.execute(save);await chat.dismissSummary({conversationId:binding.conversationId,candidateId});
   expect(await t.service.execute(save)).toEqual({accepted:true});
   expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].version).toBe(1);
  } else {
   const blocker=new pg.Client({connectionString:process.env.V3_LOCAL_DB});await blocker.connect();
   try {
    await blocker.query('begin');await blocker.query('select id from artifact_projects where id=$1 for update',[t.scope.projectId]);
    const pending=t.service.execute(save).then(()=> 'unexpected success',(e:Error)=>e.message);
    await expect.poll(async()=>Number((await sql.query("select count(*) n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%artifact_save_candidate%'" )).rows[0].n),{timeout:5000}).toBeGreaterThan(0);
    await blocker.query("insert into artifact_requests(project_id,request_id,round_id,action,payload,response) values($1,$2,$3,'summary_dismissed',$4,'{\"dismissed\":true}')",[t.scope.projectId,randomUUID(),t.scope.roundId,JSON.stringify({candidateId})]);
    await blocker.query('commit');expect(await pending).toBe('ARTIFACT_CANDIDATE_INVALIDATED');
    expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body).toBe('');
   } finally {await blocker.query('rollback');await blocker.end();}
  }
  expect(calls).toBe(2);return;
 }
 const {page,context}=await pageFor(credentials,[]),writes:string[]=[];
 if(mode==='dismiss'||mode==='remote-dirty')await page.addInitScript(()=>{const real=window.setTimeout.bind(window);window.setTimeout=((handler:TimerHandler,timeout?:number,...args:unknown[])=>real(handler,timeout===450?30000:timeout,...args)) as typeof window.setTimeout;});
 if(mode==='remote-frozen'||mode==='remote-unknown')await page.route('**/api/trpc/workbench.execute*',route=>route.abort('failed'));
 page.on('request',request=>{if(request.url().includes('workbench.execute')||request.url().includes('workbench.generate'))writes.push(request.url());});
 await page.goto(app+'/chat?conversation='+binding.conversationId);await page.getByLabel('当前步骤工作稿').waitFor();
 if(mode==='recover'){
  await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('Saved summary from a different browser session');
  expect(writes.filter(x=>x.includes('workbench.generate'))).toHaveLength(0);
 } else if(mode==='remote-dirty'||mode==='remote-frozen'||mode==='remote-unknown') {
  if(mode==='remote-frozen'||mode==='remote-unknown')await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
  else await expect.poll(()=>page.getByLabel('当前步骤工作稿').inputValue()).toBe('Saved summary from a different browser session');
  const candidateId=(await chat.read({conversationId:binding.conversationId})).turns[0].summaryCandidateId!;
  if(mode==='remote-unknown')await page.getByLabel('当前步骤工作稿').fill('Newer B survives second unknown acknowledgement');
  await chat.dismissSummary({conversationId:binding.conversationId,candidateId});
  if(mode==='remote-unknown'){
   await page.reload();await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
   expect(await page.getByLabel('当前步骤工作稿').inputValue()).toBe('Newer B survives second unknown acknowledgement');
   await page.unroute('**/api/trpc/workbench.execute*');
  }
  if(mode==='remote-frozen')await page.unroute('**/api/trpc/workbench.execute*');
  await page.reload();
  await expect.poll(async()=>await page.getByLabel('当前步骤工作稿').inputValue(),{timeout:30000}).toBe('');
  await expect.poll(()=>page.getByRole('button',{name:'重试保存',exact:true}).count()).toBe(0);
  await page.waitForTimeout(1000);
  expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body).toBe('');
  expect(writes.filter(x=>x.includes('workbench.generate'))).toHaveLength(0);
 } else if(mode==='dismiss') {
  await page.getByRole('button',{name:'放弃本地编辑并载入已保存内容',exact:true}).click();
  await expect.poll(async()=>(await chat.read({conversationId:binding.conversationId})).turns[0].summaryDismissed,{timeout:30000}).toBe(true);
  await page.reload();await page.getByLabel('当前步骤工作稿').waitFor();
  expect(await page.getByLabel('当前步骤工作稿').inputValue()).toBe('');
  expect(await page.getByRole('button',{name:'放弃本地编辑并载入已保存内容',exact:true}).count()).toBe(0);
  expect(writes).toHaveLength(0);
 } else {
  expect(await page.getByRole('button',{name:'放弃本地编辑并载入已保存内容',exact:true}).count()).toBe(0);
  expect(await page.getByLabel('当前步骤工作稿').inputValue()).toBe('');expect(writes).toHaveLength(0);
 }
 expect(calls).toBe(2);await context.close();
},120000);


aiTest.each([false,true])('CHAT: closed manual save resolves original acknowledgement committed=%s',async(committed)=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 await page.route('**/api/trpc/workbench.execute*',async route=>{if(committed)await route.fetch();await route.abort('failed');});
 await page.getByLabel('当前步骤工作稿').fill('Manual A with unknown acknowledgement');
 await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
 await t.service.execute({...t.scope,action:'abandon',requestId:randomUUID()});
 await page.unroute('**/api/trpc/workbench.execute*');await page.reload();
 await expect.poll(async()=>page.getByLabel('当前步骤工作稿').inputValue(),{timeout:30000}).toBe(committed?'Manual A with unknown acknowledgement':'');
 await expect.poll(()=>page.getByRole('button',{name:'重试保存',exact:true}).count()).toBe(0);
 const final=await t.service.read(t.scope.projectId,t.scope.roundId);expect(final.steps['step-0'].version).toBe(committed?1:0);
 expect(t.calls()).toBe(0);await context.close();
},90000);

aiTest('CHAT: provider input usage beyond reservation preserves reconciliation evidence without a candidate or retry',async()=>{
 const t=await generationFixture();let calls=0;
 const ai=t.workbenchGeneration(t.user,db,async()=>{calls++;return {body:'Do not publish an over-budget result',inputTokens:2000000,outputTokens:20};});
 const request=await t.request(ai),result=await ai.generate(request);
 expect(result.state).toBe('unknown');expect(result.candidateId).toBeNull();
 expect((await ai.generate(request)).state).toBe('unknown');expect(calls).toBe(1);
 const evidence=await sql.query("select payload from artifact_requests where project_id=$1 and action='generation_usage_exceeded'",[t.scope.projectId]);
 expect(evidence.rows).toHaveLength(1);expect(evidence.rows[0].payload.inputTokens).toBe(2000000);
 expect(JSON.stringify(evidence.rows)).not.toContain('Do not publish');
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).candidates).toHaveLength(0);
 expect((await sql.query('select count(*)::int n from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1)',[t.scope.projectId])).rows[0].n).toBe(0);
},60000);

aiTest('CHAT: selected module catalog avoids unrelated registrations while retaining authorization',async()=>{
 const t=await generationFixture(),other=await generationFixture();
 const broken='unrelated-'+randomUUID();
 await sql.query("insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) select $1,module_id,skill_id,revision_id,jsonb_set(workflow,'{steps}','[]'),'Unrelated invalid fixture',true from artifact_workflows where module_id=$2 limit 1",[broken,other.f.moduleId]);
 const bulk='catalog-bulk-'+randomUUID();
 await sql.query("insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) select $1||'-'||n,module_id,skill_id,revision_id,workflow,'Unrelated capacity fixture',true from (select * from artifact_workflows where module_id=$2 limit 1) w cross join generate_series(1,101) n",[bulk,other.f.moduleId]);
 try{
  await expect(t.service.catalog()).rejects.toThrow();
  const scoped=await t.service.catalog(t.f.moduleId);expect(scoped.length).toBeGreaterThan(0);expect(scoped.every(x=>x.moduleId===t.f.moduleId)).toBe(true);
  const {skillChatService}=await import('../artifacts/chat');
  expect((await skillChatService(t.user,db).enter({moduleId:t.f.moduleId,requestId:randomUUID()})).projectId).toBe(t.scope.projectId);
  await expect(t.service.catalog(other.f.moduleId)).rejects.toThrow();
  const fresh=await fixture({id:'scoped-'+randomUUID(),label:'Fresh scoped module',methodText:'Fictional scoped entry method.',workflow:makeWorkflow(3)});
  const entry={moduleId:fresh.moduleId,requestId:randomUUID()},chat=skillChatService(t.user,db);
  const created=await chat.enter(entry);expect(created.projectId).toBe(entry.requestId);
  expect(await chat.enter(entry)).toEqual(created);
  expect((await t.service.projects()).filter(p=>p.moduleId===fresh.moduleId)).toHaveLength(1);
  const denied=new pg.Client({connectionString:process.env.V3_LOCAL_DB});await denied.connect();
  try{
   await denied.query('set role authenticated');
   await expect(denied.query('select artifact_module_catalog($1,$2)',[actor,t.f.moduleId])).rejects.toThrow('permission denied');
  }finally{await denied.end();}
  const stopped=await newUser();await sql.query("update profiles set status='disabled' where id=$1",[stopped.id]);
  await expect(sql.query('select artifact_module_catalog($1,$2)',[stopped.id,t.f.moduleId])).rejects.toThrow('artifact denied');
 }finally{await sql.query('delete from artifact_workflows where id=$1 or id like $2',[broken,bulk+'-%']);}
},60000);

aiTest('CHAT: oversized summary preserves the reply and never replays or settles a result',async()=>{
 const {skillChatService}=await import('../artifacts/chat');
 const flow=makeWorkflow(3);flow.steps[0].maxLength=100;
 const t=await generationFixture(3,'Synthetic bounded summary method.',{workflow:flow}),chat=skillChatService(t.user,db);
 const binding=await chat.enter({...t.scope,requestId:randomUUID()}),turnId=randomUUID(),body='Discuss a fictional family event';
 await chat.submit({conversationId:binding.conversationId,requestId:turnId,stepId:'step-0',body});
 const snap=await t.service.read(t.scope.projectId,t.scope.roundId),seen:string[]=[];
 const ai=t.workbenchGeneration(t.user,db,async req=>{seen.push(req.model.id);return {body:req.model.id===localModel?'Readable dialogue':'x'.repeat(101),inputTokens:800,outputTokens:30};});
 const input={...t.scope,conversationId:binding.conversationId,turnId,stepId:'step-0',instruction:body,purpose:'reply' as const,expectedSteps:Object.fromEntries(Object.entries(snap.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const q=await ai.quote(input);expect((await ai.generate({...input,requestId:turnId,quoteHash:q.quoteHash,budgetCredits:q.reservedCredits})).state).toBe('succeeded');
 const sb=await chat.summary({conversationId:binding.conversationId,requestId:turnId}),summary={...input,purpose:'summary' as const},sq=await ai.quote(summary);
 const request={...summary,requestId:sb.requestId,quoteHash:sq.quoteHash,budgetCredits:sq.reservedCredits};
 expect((await ai.generate(request)).state).toBe('unknown');expect((await ai.generate(request)).state).toBe('unknown');
 expect(seen).toEqual([localModel,localSummaryModel]);
 expect((await chat.read({conversationId:binding.conversationId})).turns[0]).toMatchObject({answer:'Readable dialogue',summaryState:'unknown',summaryCandidateId:null});
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body).toBe(snap.steps['step-0'].body);
 expect((await sql.query("select count(*)::int n from token_stats where artifact_generation_id in (select id from artifact_generations where project_id=$1)",[t.scope.projectId])).rows[0].n).toBe(1);
},60000);

aiTest('CHAT: dirty ancestor blocks descendant send until autosave and fresh confirmation',async()=>{
 const {skillChatService}=await import('../artifacts/chat');const t=await generationFixture();
 await t.service.execute({...t.scope,action:'save',stepId:'step-0',requestId:randomUUID(),expectedVersion:0,body:'Old confirmed ancestor',evidenceIds:[]});
 const saved=(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'];
 await t.service.execute({...t.scope,action:'confirm',stepId:'step-0',requestId:randomUUID(),expectedVersion:saved.version,expectedReviewVersion:saved.reviewVersion});
 const chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 const {page,context}=await pageFor(credentials,[]);
 await page.addInitScript(()=>{const original=window.setTimeout.bind(window);window.setTimeout=((handler:TimerHandler,timeout?:number,...args:unknown[])=>original(handler,timeout===450?5000:timeout,...args)) as typeof window.setTimeout;});
 let quotes=0,dispatches=0;page.on('request',r=>{if(r.url().includes('workbench.generationQuote'))quotes++;if(r.url().includes('workbench.generate'))dispatches++;});
 await page.goto(app+'/chat?conversation='+binding.conversationId);
 await page.getByLabel('当前步骤工作稿').fill('New ancestor must be saved before any reply');
 await page.getByRole('button',{name:new RegExp('^2\\. '+t.f.flow.steps[1].title)}).click();
 await page.getByLabel('给当前步骤发消息').fill('Discuss the dependent step');
 expect(await page.getByRole('button',{name:'发送',exact:true}).isDisabled()).toBe(true);
 expect(quotes).toBe(0);expect(dispatches).toBe(0);
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:20000}).toBe('New ancestor must be saved before any reply');
 expect((await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].valid).toBe(false);
 expect(dispatches).toBe(0);
 await context.close();
},90000);

aiTest('CHAT: editing a result while quote is pending abandons before model dispatch',async()=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 let release!:()=>void,arrived!:()=>void;const hold=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>arrived=r);let dispatches=0;
 page.on('request',r=>{if(r.url().includes('workbench.generate'))dispatches++;});
 await page.addInitScript(()=>{const original=window.setTimeout.bind(window);window.setTimeout=((handler:TimerHandler,timeout?:number,...args:unknown[])=>original(handler,timeout===450?3000:timeout,...args)) as typeof window.setTimeout;});
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 await page.route('**/api/trpc/workbench.generationQuote*',async route=>{const response=await route.fetch();arrived();await hold;await route.fulfill({response});});
 await page.getByLabel('给当前步骤发消息').fill('Discuss without replacing manual decisions');await page.getByRole('button',{name:'发送',exact:true}).click();await seen;
 await page.getByLabel('当前步骤工作稿').fill('Manual decision changed during quotation');release();
 const {skillChatService}=await import('../artifacts/chat'),chat=skillChatService(t.user,db);const conversationId=new URL(page.url()).searchParams.get('conversation')!;
 await expect.poll(async()=>(await chat.read({conversationId})).turns.some(t=>t.abandoned),{timeout:30000}).toBe(true);
 expect(dispatches).toBe(0);
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:30000}).toBe('Manual decision changed during quotation');
 await page.unroute('**/api/trpc/workbench.generationQuote*');
 await expect.poll(async()=>page.getByRole('button',{name:'发送',exact:true}).isEnabled(),{timeout:30000}).toBe(true);
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect.poll(async()=>(await chat.read({conversationId})).turns.some(t=>!t.abandoned&&t.generationState==='succeeded'),{timeout:30000}).toBe(true);
 expect(dispatches).toBeGreaterThan(0);await context.close();
},90000);

aiTest('CHAT: dirty edit after failed send recovery releases autosave queue',async()=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 await page.addInitScript(()=>{const original=window.setTimeout.bind(window);window.setTimeout=((handler:TimerHandler,timeout?:number,...args:unknown[])=>original(handler,timeout===450?3000:timeout,...args)) as typeof window.setTimeout;});
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 let submits=0;await page.route('**/api/trpc/workbench.chatSubmit*',async route=>{submits++;await route.abort('failed');});
 await page.getByLabel('给当前步骤发消息').fill('Discuss latest manual facts');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('button',{name:'恢复原操作',exact:true}).waitFor();
 await page.getByLabel('当前步骤工作稿').fill('Manual edit after failed send must autosave');
 await page.getByRole('button',{name:'恢复原操作',exact:true}).click();expect(submits).toBe(1);
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:20000}).toBe('Manual edit after failed send must autosave');
 await page.unroute('**/api/trpc/workbench.chatSubmit*');
 await expect.poll(async()=>page.getByRole('button',{name:'发送',exact:true}).isEnabled(),{timeout:20000}).toBe(true);
 await page.getByRole('button',{name:'发送',exact:true}).click();
 const {skillChatService}=await import('../artifacts/chat'),chat=skillChatService(t.user,db),conversationId=new URL(page.url()).searchParams.get('conversation')!;
 await expect.poll(async()=>(await chat.read({conversationId})).turns.some(t=>t.generationState==='succeeded'),{timeout:30000}).toBe(true);
 await context.close();
},90000);

aiTest('CHAT: prepared delivery recovery waits for all dirty results to autosave',async()=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 await page.addInitScript(()=>{const original=window.setTimeout.bind(window);window.setTimeout=((handler:TimerHandler,timeout?:number,...args:unknown[])=>original(handler,timeout===450?3000:timeout,...args)) as typeof window.setTimeout;});
 await page.goto(app+'/chat?module='+t.f.moduleId);await page.waitForURL(u=>!!u.searchParams.get('conversation'));
 const stopped=new Proxy(db,{get(target,key){if(key==='rpc')return (name:string,args:Record<string,unknown>)=>args.p_action==='prepare'?{abortSignal:async()=>{const result=await target.rpc(name,args);if(result.error)throw result.error;throw new Error('local stopped after reserve');}}:target.rpc(name,args);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 let generates=0;
 await page.route('**/api/trpc/workbench.generate*',async route=>{
  generates++;const data=route.request().postDataJSON(),v=data.json??data['0']?.json??data['0']??data;
  await expect(t.workbenchGeneration(t.user,stopped,async()=>{throw new Error('must not dispatch');}).generate(v)).rejects.toThrow('local stopped after reserve');
  await route.abort('failed');
 });
 await page.getByLabel('给当前步骤发消息').fill('Discuss latest saved decisions');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('button',{name:'恢复原发送状态',exact:true}).waitFor();
 await expect.poll(async()=>page.getByRole('button',{name:'恢复原发送状态',exact:true}).isEnabled(),{timeout:30000}).toBe(true);
 expect((await t.ai.list(t.scope))[0].state).toBe('prepared');
 await page.getByLabel('当前步骤工作稿').fill('New decision must save before prepared delivery');
 await page.getByRole('button',{name:'恢复原发送状态',exact:true}).click();
 expect(generates).toBe(1);expect(t.calls()).toBe(0);
 await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].body,{timeout:20000}).toBe('New decision must save before prepared delivery');
 expect((await t.ai.list(t.scope))[0].state).toBe('prepared');
 await context.close();
},90000);

aiTest('CHAT: deleting the active ordinary or guided conversation clears its route despite unsent text',async()=>{
 const t=await generationFixture(),{page,context}=await pageFor(credentials,[]);
 for(const guided of [false,true]){
  const title='Delete active '+randomUUID();let conversationId:string;
  if(guided){const {skillChatService}=await import('../artifacts/chat');conversationId=(await skillChatService(t.user,db).enter({...t.scope,requestId:randomUUID()})).conversationId;await sql.query('update conversations set title=$1 where id=$2',[title,conversationId]);}
  else {conversationId=randomUUID();await sql.query('insert into conversations(id,user_id,title) values($1,$2,$3)',[conversationId,actor,title]);}
  await page.goto(app+'/chat?conversation='+conversationId);
  await (guided?page.getByLabel('给当前步骤发消息'):page.getByTestId('chat-input')).fill('Unsent text before explicit deletion');
  await page.getByText(title,{exact:true}).locator('../..').getByTestId('conversation-actions-trigger').click();
  await page.getByRole('menuitem',{name:'删除',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'删除',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/chat'&&!u.searchParams.has('conversation'));
  await expect.poll(async()=>page.getByTestId('chat-input').isVisible(),{timeout:30000}).toBe(true);
  await expect.poll(async()=>(await sql.query("select count(*)::int n from conversations where id=$1 and is_deleted='false'",[conversationId])).rows[0].n,{timeout:30000}).toBe(0);
 }
 await context.close();
},90000);

aiTest('CHAT: retention purges chat hierarchy while retaining accounting and deferring unresolved generations',async()=>{
 const {skillChatService}=await import('../artifacts/chat');
 const t=await generationFixture(),chat=skillChatService(t.user,db),binding=await chat.enter({...t.scope,requestId:randomUUID()});
 const turnId=randomUUID(),summaryId=randomUUID();
 await chat.submit({conversationId:binding.conversationId,requestId:turnId,stepId:'step-0',body:'Completed discussion'});
 await sql.query('insert into artifact_chat_summaries(turn_id,request_id,attempt) values($1,$2,1)',[turnId,summaryId]);
 await expect(sql.query('delete from artifact_chat_turns where request_id=$1',[turnId])).rejects.toThrow('immutable');
 await expect(sql.query('delete from artifact_chat_summaries where request_id=$1',[summaryId])).rejects.toThrow('immutable');
 const snapshot=await t.service.read(t.scope.projectId,t.scope.roundId);
 const input={...t.scope,conversationId:binding.conversationId,turnId,purpose:'reply' as const,stepId:'step-0',instruction:'Completed discussion',expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([id,s])=>[id,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const quote=await t.ai.quote(input);
 expect((await t.ai.generate({...input,requestId:turnId,quoteHash:quote.quoteHash,budgetCredits:quote.reservedCredits})).state).toBe('succeeded');
 for(const step of t.f.flow.steps){
  let s=await t.service.read(t.scope.projectId,t.scope.roundId);
  await t.service.execute({action:'save',...t.scope,requestId:randomUUID(),stepId:step.id,expectedVersion:s.steps[step.id].version,body:'Confirmed retained result '+step.id,evidenceIds:[]});
  s=await t.service.read(t.scope.projectId,t.scope.roundId);
  await t.service.execute({action:'confirm',...t.scope,requestId:randomUUID(),stepId:step.id,expectedVersion:s.steps[step.id].version,expectedReviewVersion:s.steps[step.id].reviewVersion});
 }
 const ready=await t.service.read(t.scope.projectId,t.scope.roundId);
 await t.service.execute({action:'publish',...t.scope,requestId:randomUUID(),expectedSteps:Object.fromEntries(Object.entries(ready.steps).map(([id,s])=>[id,{version:s.version,reviewVersion:s.reviewVersion}]))});
 const report=await t.service.report(t.scope.projectId,t.scope.roundId);
 const retained=(await sql.query('select id,state,candidate_id,pre_deduct_id from artifact_generations where project_id=$1',[t.scope.projectId])).rows;
 const accounting=(await sql.query('select id,total_credits,artifact_generation_id from token_stats where artifact_generation_id=any($1::uuid[])',[retained.map(g=>g.id)])).rows;
 expect(accounting).toHaveLength(1);
 const spend=(await sql.query('select id,amount from credit_transactions where source_id=any($1::text[])',[retained.map(g=>g.id)])).rows;
 expect(spend).toHaveLength(1);
 const pending=await generationFixture(),pendingChat=await skillChatService(pending.user,db).enter({...pending.scope,requestId:randomUUID()}),v=await pending.request();
 expect((await db.rpc('artifact_generation',{p_actor_id:actor,p_project_id:v.projectId,p_round_id:v.roundId,p_request_id:v.requestId,p_action:'prepare',p_payload:{input:v,quote:{modelId:localModel,reservedCredits:v.budgetCredits}}})).error).toBeNull();
 const ordinary=randomUUID();await sql.query("insert into conversations(id,user_id,title,is_deleted,deleted_at) values($1,$2,'Expired ordinary','true',now()-interval '40 days')",[ordinary,actor]);
 await sql.query("update conversations set is_deleted='true',deleted_at=now()-interval '40 days' where id=any($1::uuid[])",[[binding.conversationId,pendingChat.conversationId]]);
 // Minimal unused category scaffolding; the purge function itself is the actual migration.
 for(const table of ['tickets','ticket_replies','prompts','announcements'])await sql.query(`create table if not exists ${table}(id uuid primary key default gen_random_uuid(),is_deleted boolean default false,deleted_at timestamptz)`);
 const denied=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
 expect((await denied.rpc('purge_deleted_records',{p_days_old:30})).error).not.toBeNull();
 const purge=await db.rpc('purge_deleted_records',{p_days_old:30});expect(purge.error).toBeNull();
 expect(purge.data.find((r:{table_name:string})=>r.table_name==='conversations').deleted_count).toBe(2);
 expect((await sql.query('select id from conversations where id=any($1::uuid[])',[[binding.conversationId,ordinary]])).rows).toHaveLength(0);
 expect((await sql.query('select request_id from artifact_chat_turns where request_id=$1',[turnId])).rows).toHaveLength(0);
 expect((await sql.query('select request_id from artifact_chat_summaries where request_id=$1',[summaryId])).rows).toHaveLength(0);
 expect((await sql.query('select id,state,candidate_id,pre_deduct_id from artifact_generations where project_id=$1',[t.scope.projectId])).rows).toEqual(retained);
 expect((await sql.query('select id,total_credits,artifact_generation_id from token_stats where artifact_generation_id=any($1::uuid[])',[retained.map(g=>g.id)])).rows).toEqual(accounting);
 expect((await sql.query('select id,amount from credit_transactions where source_id=any($1::text[])',[retained.map(g=>g.id)])).rows).toEqual(spend);
 expect(await t.service.report(t.scope.projectId,t.scope.roundId)).toEqual(report);
 expect((await sql.query('select id from conversations where id=$1',[pendingChat.conversationId])).rows).toHaveLength(1);
 expect((await pending.ai.list(pending.scope))[0].state).toBe('prepared');
 await pending.ai.cancel({...pending.scope,requestId:v.requestId});
 const again=await db.rpc('purge_deleted_records',{p_days_old:30});expect(again.error).toBeNull();
 expect((await sql.query('select id from conversations where id=$1',[pendingChat.conversationId])).rows).toHaveLength(0);
 expect((await db.rpc('purge_deleted_records',{p_days_old:30})).error).toBeNull();
},60000);

aiTest('CHAT: retention skips a busy project without blocking concurrent conversation restoration',async()=>{
 const t=await generationFixture(),{skillChatService}=await import('../artifacts/chat');
 const binding=await skillChatService(t.user,db).enter({...t.scope,requestId:randomUUID()});
 const ordinary=randomUUID();await sql.query("insert into conversations(id,user_id,title,is_deleted,deleted_at) values($1,$2,'Expired ordinary concurrent','true',now()-interval '40 days')",[ordinary,actor]);
 await sql.query("update conversations set is_deleted='true',deleted_at=now()-interval '40 days' where id=$1",[binding.conversationId]);
 for(const table of ['tickets','ticket_replies','prompts','announcements'])await sql.query(`create table if not exists ${table}(id uuid primary key default gen_random_uuid(),is_deleted boolean default false,deleted_at timestamptz)`);
 const holder=new pg.Client({connectionString:process.env.V3_LOCAL_DB});await holder.connect();
 try {
  await holder.query('begin');await holder.query('select id from artifact_projects where id=$1 for update',[t.scope.projectId]);
  const purge=await db.rpc('purge_deleted_records',{p_days_old:30}).abortSignal(AbortSignal.timeout(3000));
  expect(purge.error).toBeNull();
  expect((await sql.query('select id from conversations where id=$1',[ordinary])).rows).toHaveLength(0);
  expect((await sql.query('select id from conversations where id=$1',[binding.conversationId])).rows).toHaveLength(1);
  const restored=await holder.query("select artifact_chat($1,'attach',NULL,$2::jsonb) result",[actor,JSON.stringify({...t.scope,requestId:randomUUID()})]);
  expect(restored.rows[0].result.conversationId).toBe(binding.conversationId);
  await holder.query('commit');
  expect((await skillChatService(t.user,db).read({conversationId:binding.conversationId})).binding.conversationId).toBe(binding.conversationId);
 } finally {await holder.query('rollback');await holder.end();}
},30000);

aiTest('CHAT: search restores a lost response, adopts references once and cancels only unsent work',async()=>{
 const t=await generationFixture(),{skillChatService}=await import('../artifacts/chat');
 const binding=await skillChatService(t.user,db).enter({...t.scope,requestId:randomUUID()});
 const {localMcpFixture}=await import('./fixtures/agentKeyServer'),{databaseBilledResearchStore}=await import('../research/store'),{tavilySchema}=await import('../research/tavilySchema');
 const name='Tavily/post_search',query='Fictional public guide';
 const wire={discovery:{tools:[{name}]},description:{name,category:'Search',provider:'Tavily',params:tavilySchema,cost:{credits_per_call:1.1},health:{healthy:true},execute_as:{name,params:{query:'<The search query to execute with Tavily.>'}}},result:{category:'search',provider:'Tavily',took_ms:10,data:{query,answer:null,follow_up_questions:null,images:[],response_time:0.01,results:[{id:'browser-reference',title:'Browser search guide',url:'https://example.test/browser-guide',content:'Reference from the local MCP fixture.',score:0.8,raw_content:null}],usage:{credits:1}}}};
 const fixture=await localMcpFixture(databaseBilledResearchStore(db,actor),'json',wire);
 const {page,context}=await pageFor(credentials,[]);
 try {
  await sql.query("insert into system_settings(key,value) values('v3_web_search','true'),('search_surcharge_credits','5'),('local_research_endpoint',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(fixture.endpoint)]);
  const before=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
  await page.goto(app+'/chat?conversation='+binding.conversationId);await page.getByText('参考资料（可选）',{exact:true}).click();
  const panel=page.getByRole('region',{name:'网页搜索'});await panel.getByLabel('网页搜索关键词').fill(query);
  await page.route('**/api/trpc/workbench.search*',async route=>{await route.fetch();await route.abort('failed');});
  await panel.getByRole('button',{name:'搜索网页',exact:true}).click();await panel.getByRole('alert').waitFor();
  expect(fixture.events.filter(e=>e==='execute')).toHaveLength(1);
  await page.unroute('**/api/trpc/workbench.search*');await page.reload();await page.getByText('参考资料（可选）',{exact:true}).click();
  expect(await panel.getByLabel('网页搜索关键词').inputValue()).toBe(query);expect(fixture.events.filter(e=>e==='execute')).toHaveLength(1);
  await panel.getByRole('button',{name:'恢复本次查询',exact:true}).click();await panel.getByText('已加入参考资料，可勾选关联到本步骤。',{exact:true}).waitFor();
  await page.getByText('Reference from the local MCP fixture.',{exact:true}).waitFor();await page.getByText('发布时间未提供',{exact:true}).waitFor();
  expect(await page.getByRole('link',{name:'查看原始来源',exact:true}).getAttribute('href')).toBe('https://example.test/browser-guide');
  const snapshot=await t.service.read(t.scope.projectId,t.scope.roundId);expect(snapshot.evidence).toHaveLength(1);
  await page.getByRole('checkbox',{name:'关联到本步骤',exact:true}).check();
  await expect.poll(async()=>(await t.service.read(t.scope.projectId,t.scope.roundId)).steps['step-0'].evidenceIds,{timeout:15000}).toEqual([snapshot.evidence[0].id]);
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(before-5);expect(fixture.events.filter(e=>e==='execute')).toHaveLength(1);
  await panel.getByRole('button',{name:'新搜索',exact:true}).click();
  // A terminal paid result must remain clearable even if evidence adoption fails.
  await page.route('**/api/trpc/workbench.execute*',route=>route.abort('failed'));
  await panel.getByLabel('网页搜索关键词').fill(query);
  await panel.getByRole('button',{name:'搜索网页',exact:true}).click();await panel.getByRole('alert').waitFor();
  expect(fixture.events.filter(e=>e==='execute')).toHaveLength(2);
  await panel.getByRole('button',{name:'新搜索',exact:true}).click();
  expect(await panel.getByLabel('网页搜索关键词').isEnabled()).toBe(true);
  expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('graylum-search:')))).toEqual([]);
  await page.unroute('**/api/trpc/workbench.execute*');
  await sql.query("update system_settings set value='false' where key='v3_web_search'");
  await panel.getByLabel('网页搜索关键词').fill('Unsent query');await panel.getByRole('button',{name:'搜索网页',exact:true}).click();await panel.getByRole('alert').waitFor();
  await panel.getByRole('button',{name:'取消未发送查询',exact:true}).click();await expect.poll(()=>panel.getByLabel('网页搜索关键词').isEnabled()).toBe(true);
  expect(fixture.events.filter(e=>e==='execute')).toHaveLength(2);expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(before-10);
  await sql.query("update system_settings set value='true' where key='v3_web_search'");
  fixture.setBehavior('error');await panel.getByLabel('网页搜索关键词').fill(query);
  await panel.getByRole('button',{name:'搜索网页',exact:true}).click();
  await panel.getByText('本次搜索失败，预扣积分已退回。你可以发起新搜索。',{exact:true}).waitFor();
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(before-10);
  await panel.getByRole('button',{name:'新搜索',exact:true}).click();fixture.setBehavior('success');
  await panel.getByLabel('网页搜索关键词').fill(query);
  await page.route('**/api/trpc/workbench.search*',async route=>{await route.fetch();await route.abort('failed');});
  await panel.getByRole('button',{name:'搜索网页',exact:true}).click();await panel.getByRole('alert').waitFor();
  await page.unroute('**/api/trpc/workbench.search*');
  await t.service.execute({...t.scope,action:'abandon',requestId:randomUUID()});
  await page.reload();await page.getByText('参考资料（可选）',{exact:true}).click();
  expect(await panel.getByRole('button',{name:'恢复本次查询',exact:true}).isEnabled()).toBe(true);
  await panel.getByRole('button',{name:'恢复本次查询',exact:true}).click();
  await panel.getByText('Reference from the local MCP fixture.',{exact:true}).waitFor();
  expect(await panel.getByLabel('网页搜索关键词').isEnabled()).toBe(false);
  expect(await panel.getByRole('button',{name:'新搜索',exact:true}).count()).toBe(0);
  expect((await t.service.read(t.scope.projectId,t.scope.roundId)).evidence).toHaveLength(1);
  expect(fixture.events.filter(e=>e==='execute')).toHaveLength(4);
 } finally {await context.close();await fixture.stop();}
},120000);

aiTest('AI: research cancellation reports unsent and dispatched outcomes under the plan lock',async()=>{
 const {databaseBilledResearchStore}=await import('../research/store');const store=databaseBilledResearchStore(db,actor);
 const t=await generationFixture(),{workbenchSearch}=await import('../research/workbenchSearch');
 const host=workbenchSearch(t.user,db),request={...t.scope,stepId:'step-0',query:'Delayed query',requestId:randomUUID()};
 const {getRateLimiter}=await import('../rateLimiter');
 let reached!:()=>void,resume!:()=>void;
 const paused=new Promise<void>(r=>{reached=r}),released=new Promise<void>(r=>{resume=r});
 const delayedDb=new Proxy(db,{get(target,key){
  if(key==='rpc')return async(name:string,args:Record<string,unknown>)=>{
   if(name==='research_transition'&&args.p_action==='create'){reached();await released;}
   return target.rpc(name,args);
  };
  return Reflect.get(target,key);
 }});
 let connections=0;
 const delayed=workbenchSearch(t.user,delayedDb,async()=>{connections++;throw new Error('must not connect');});
 const before=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 const pending=delayed.search(request).then(()=>null,error=>error);
 await paused;
 try {
  expect(await host.cancel(request)).toEqual({cancelled:true});
  // Simulate losing that successful cancellation response and retrying it.
  expect(await host.cancel(request)).toEqual({cancelled:true});
  await expect(host.cancel({...request,query:'Different scope'})).rejects.toThrow('RESEARCH_IDENTITY_CONFLICT');
  await expect(host.cancel({...request,stepId:'step-1'})).rejects.toThrow('RESEARCH_IDENTITY_CONFLICT');
  await expect(host.cancel({...request,stepId:'missing-step'})).rejects.toThrow('RESEARCH_SCOPE_UNAVAILABLE');
  const foreign=await newUser();
  await expect(workbenchSearch(await authenticated(foreign),db).cancel(request)).rejects.toThrow();
  for(let i=0;i<61;i++)getRateLimiter().check(actor,'ai');
  // Existing cancellation recovery remains available after exhausting new-intent limits.
  expect(await host.cancel(request)).toEqual({cancelled:true});
  const blocked=randomUUID();
  await expect(host.cancel({...request,requestId:blocked})).rejects.toThrow('请求过于频繁');
  expect((await sql.query('select id from research_plans where id=$1',[blocked])).rows).toHaveLength(0);
 } finally {resume();getRateLimiter().close();}
 expect(await pending).toBeInstanceOf(Error);
 expect(connections).toBe(0);
 expect((await sql.query('select id from research_operations where plan_id=$1',[request.requestId])).rows).toHaveLength(0);
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(before);
 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 for(const state of ['empty','prepared','dispatched']){
  await sql.query('update profiles set credits=100 where id=$1',[actor]);
  const planId=randomUUID(),operationId=randomUUID();await store.create(planId,1100000,[{operationId,identityHash:'f'.repeat(64),maxQuoteUnits:1100000}]);
  if(state!=='empty'){const r=await store.reserve(planId,operationId,'f'.repeat(64),1100000);if(state==='dispatched')await store.dispatch(planId,operationId,r.token!);}
  expect(await store.cancel(planId)).toBe(state!=='dispatched');expect(await store.cancel(planId)).toBe(state!=='dispatched');
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(state==='dispatched'?95:100);
  const denied=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
  expect((await denied.rpc('research_cancel',{p_actor_id:actor,p_plan_id:planId})).error).not.toBeNull();
 }
},30000);


aiTest('AI: research explicit provider failure refunds once while unknown stays reserved',async()=>{
 const {databaseBilledResearchStore}=await import('../research/store');const store=databaseBilledResearchStore(db,actor);
 const missing=randomUUID(),lookup={p_actor_id:actor,p_plan_id:missing,p_operation_id:missing};
 expect((await db.rpc('research_lookup',lookup)).data).toBeNull();
 expect((await sql.query('select id from research_plans where id=$1',[missing])).rows).toHaveLength(0);
 const ordinary=await authenticated();expect((await ordinary.rpc('research_lookup',lookup)).error).not.toBeNull();
 const anonymous=createClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 expect((await anonymous.rpc('research_lookup',lookup)).error).not.toBeNull();

 await sql.query("insert into system_settings(key,value) values('search_surcharge_credits','5') on conflict(key) do update set value=excluded.value");
 for(const state of ['failed','unknown'] as const){
  await sql.query('update profiles set credits=100 where id=$1',[actor]);
  const id=randomUUID();await store.create(id,1100000,[{operationId:id,identityHash:'d'.repeat(64),maxQuoteUnits:1100000}]);
  const foreign=await newUser();expect((await db.rpc('research_lookup',{p_actor_id:foreign.id,p_plan_id:id,p_operation_id:id})).error).not.toBeNull();
  const reserved=await store.reserve(id,id,'d'.repeat(64),1100000);await store.dispatch(id,id,reserved.token!);
  await store.finish(id,id,reserved.token!,state,{source:'agentkey',fixture:true,canonicalTool:'Tavily/post_search',objects:[],fetchedAt:new Date().toISOString(),pagination:{complete:false,nextCursor:null},error:state==='failed'?'PROVIDER_TOOL_ERROR':'RESULT_UNKNOWN',cost:{unit:'agentkey-credit',quoted:1.1,actual:null,status:'unknown'}});
  await store.get(id,id);await store.get(id,id);
  expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(state==='failed'?100:95);
  expect((await sql.query('select charged_credits from research_operations where id=$1',[id])).rows[0].charged_credits).toBe(state==='failed'?0:null);
 }
},30000);

function adminModuleInput(): ModuleSkillInput {
  const pack = makePackage();
  return { moduleId: randomUUID(), skillId: pack.id, revisionId: pack.revisionId, requestId: pack.requestId,
    expectedUpdatedAt: null, expectedVersion: 0, directoryName: 'synthetic-method', kind: 'document',
    files: [...pack.files, { path: 'assets/state.yaml', base64: Buffer.from('state: draft\n').toString('base64') }],
    steps: [{ title: '需求确认', resources: ['references/step-0.md', 'assets/state.yaml'] }, { title: '定位成果', resources: ['references/step-1.md'] }],
    resourcePlanReviewed: true, module: { title: 'ADMIN synthetic method ' + randomUUID(), description: 'Synthetic admin validation', full_description: null,
      model_id: randomUUID(), platform: 'all', category: 'analysis', icon: 'Wand2', image_url: null,
      badge_type: null, badge_text: null, credits_display: null, sort_order: 0, active: true, is_featured: false,
      features: null, examples: null, preparation_questions: null },
  };
}
it('ADMIN: atomic package, YAML template, workflow and module publication with replay, rollback and stale-write protection', async () => {
  const input = adminModuleInput();
  await sql.query("insert into ai_models(id,model_id,name,provider,api_key,max_tokens,input_limit) values($1,'qwen/qwen3.8-27b','Admin fixture model','openai','LOCAL_ONLY',4096,800000)", [input.module.model_id]);
  const result = await saveModuleSkill(db, owner, input);
  expect(result.version).toBe(1);
  expect(await saveModuleSkill(db, owner, input)).toEqual(result);
  const read = await db.rpc('admin_read_skill_module', { p_actor_id: owner, p_module_id: input.moduleId });
  expect(read.error).toBeNull(); expect(read.data.files).toHaveLength(input.files.length);
  expect(read.data.workflow.steps.map((s: any) => s.title)).toEqual(['需求确认','定位成果']);
  expect(read.data.files.find((f: any) => f.path === 'assets/state.yaml').base64).toBe(input.files.at(-1)!.base64);
  const catalog = await db.rpc('artifact_query', { p_actor_id: actor, p_action: 'catalog' });
  expect(catalog.data.filter((w: any) => w.moduleId === input.moduleId)).toHaveLength(1);
  const before = (await sql.query('select updated_at::text from modules where id=$1', [input.moduleId])).rows[0];
  const next = { ...input, revisionId: randomUUID(), requestId: randomUUID(), expectedVersion: 1, expectedUpdatedAt: before.updated_at };
  next.files = input.files.map(f => f.path === 'references/step-0.md' ? { ...f, base64: Buffer.from('Revised private method').toString('base64') } : f);
  expect((await saveModuleSkill(db, owner, next)).version).toBe(2);
  await expect(saveModuleSkill(db, owner, { ...next, revisionId: randomUUID(), requestId: randomUUID() })).rejects.toThrow();
  const history = await db.rpc('read_skill_package', { p_actor_id: actor, p_module_id: input.moduleId, p_skill_id: input.skillId, p_revision_id: input.revisionId });
  expect(history.error).toBeNull();
  expect((await sql.query('select count(*)::int as n from artifact_workflows where module_id=$1 and enabled', [input.moduleId])).rows[0].n).toBe(1);
  const invalid = adminModuleInput(); // Missing model must roll back Skill/module/registration creation.
  await expect(saveModuleSkill(db, owner, invalid)).rejects.toThrow();
  expect((await sql.query('select count(*)::int as n from skills where id=$1', [invalid.skillId])).rows[0].n).toBe(0);
  expect((await sql.query('select count(*)::int as n from modules where id=$1', [invalid.moduleId])).rows[0].n).toBe(0);
});
it('ADMIN: unauthorized users cannot read private configuration or publish, including direct RPC', async () => {
  const input = adminModuleInput();
  await expect(saveModuleSkill(db, actor, input)).rejects.toThrow();
  const denied = await db.rpc('admin_read_skill_module', { p_actor_id: actor, p_module_id: fixtures[0].moduleId });
  expect(denied.error?.code).toBe('42501');
  const user = await authenticated();
  expect((await user.rpc('admin_read_skill_module', { p_actor_id: owner, p_module_id: fixtures[0].moduleId })).error?.code).toBe('42501');
  const privilege = await sql.query("select has_function_privilege('anon','public.admin_read_skill_module(uuid,uuid)','EXECUTE') as anon, has_function_privilege('authenticated','public.admin_publish_skill_module(uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid,integer,jsonb,text,jsonb,jsonb)','EXECUTE') as authenticated");
  expect(privilege.rows[0]).toEqual({ anon: false, authenticated: false });
});
it('ADMIN: browser imports a Skill folder, configures steps, publishes and opens the resulting conversation', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  writeFileSync(output + '/admin-preview.json', JSON.stringify({ url: app, email: admin.email, password: admin.password }), { mode: 0o600 });
  const input = adminModuleInput();
  await sql.query("insert into ai_models(id,model_id,name,provider,api_key,max_tokens,input_limit) values($1,'qwen/qwen3.8-27b','Browser admin model','openai','LOCAL_ONLY',4096,800000)", [input.module.model_id]);
  const directory = output + '/synthetic-method'; mkdirSync(directory, { recursive: true });
  for (const f of input.files) {
    const target = directory + '/' + f.path; mkdirSync(target.slice(0,target.lastIndexOf('/')), { recursive: true });
    writeFileSync(target, Buffer.from(f.base64,'base64'));
  }
  const context = await browser.newContext(), page = await context.newPage();
  try {
    const ready = page.waitForResponse(r => r.url().includes('/api/trpc/settings.getSystemSettings') && r.ok());
    await page.goto(app + '/login?redirect=/admin/prompts'); await ready;
    await page.getByPlaceholder('name@example.com').fill(admin.email);
    await page.getByPlaceholder('输入你的密码').fill(admin.password);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL(u => u.pathname === '/admin/prompts', { timeout: 90000 });
    const unusedModule = randomUUID();
    await sql.query("insert into modules(id,title,active) values($1,'Inactive deletion browser fixture',false)",[unusedModule]);
    await page.reload();
    // Simulate a browser extension blocking native dialogs; our page dialog must still work.
    await page.evaluate(() => { window.confirm = () => false; });
    await page.getByTestId('admin-prompt-delete-' + unusedModule).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect((await sql.query('select id from modules where id=$1',[unusedModule])).rowCount).toBe(1);
    await page.getByTestId('admin-prompt-delete-' + unusedModule).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect.poll(async () => (await sql.query('select id from modules where id=$1',[unusedModule])).rowCount).toBe(0);

    await page.getByRole('button', { name: '新建模块', exact: true }).click();
    await page.getByLabel('功能类型', { exact: true }).selectOption('skill');
    await page.getByLabel('导入 Skill 文件夹', { exact: true }).setInputFiles(directory);
    await page.getByText('已载入 10 个文件', { exact: true }).waitFor();
    await page.getByTestId('prompt-name-input').fill(input.module.title);
    await page.getByLabel('步骤 1 名称', { exact: true }).fill('需求确认');
    await page.getByRole('button', { name: '添加步骤', exact: true }).click();
    await page.getByLabel('步骤 2 名称', { exact: true }).fill('定位成果');
    const modelTrigger = page.getByRole('dialog').getByRole('combobox').filter({ hasText: '不限制' });
    await modelTrigger.click(); await page.getByRole('option', { name: 'Browser admin model', exact: true }).click();
    await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').check();
    await page.getByTestId('prompt-save').click();
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 30000 }).toBe(0);
    const module = (await sql.query('select id,skill_id from modules where title=$1', [input.module.title])).rows[0];
    expect(module.skill_id).toBeTruthy();
    await page.goto(app + '/chat?module=' + module.id);
    await page.getByRole('heading', { name: input.module.title, exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /^1\. 需求确认/ }).waitFor();
    await page.screenshot({ path: output + '/admin-skill-conversation.png' });
    await page.goto(app + '/admin/prompts');
    const row = page.getByRole('row').filter({ hasText: input.module.title });
    await row.getByRole('button').first().click();
    await page.getByLabel('步骤 1 名称', { exact: true }).waitFor();
    await expect.poll(() => page.getByLabel('步骤 1 名称', { exact: true }).inputValue(), { timeout: 20000 }).toBe('需求确认');
    await page.screenshot({ path: output + '/admin-skill-editor.png' });
    // A slow second import must revoke confirmation before bytes finish reading.
    await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').check();
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      (window as any).releaseAdminImport = () => { File.prototype.arrayBuffer = original; release(); };
      File.prototype.arrayBuffer = async function () { await pending; return original.call(this); };
    });
    await page.getByLabel('导入 Skill 文件夹', { exact: true }).setInputFiles(directory);
    await page.getByText('正在读取 Skill 文件…', { exact: true }).waitFor();
    expect(await page.getByTestId('prompt-save').isEnabled()).toBe(false);
    expect(await page.getByLabel('我已检查步骤顺序和各步使用的参考文件').isChecked()).toBe(false);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '新建模块', exact: true }).click();
    await page.getByLabel('功能类型', { exact: true }).selectOption('skill');
    await page.getByLabel('步骤 1 名称', { exact: true }).fill('新会话内容');
    await page.evaluate(() => (window as any).releaseAdminImport());
    // Flush the original read promise through its actual microtask completion.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve,100)));
    expect(await page.getByLabel('步骤 1 名称', { exact: true }).inputValue()).toBe('新会话内容');
    expect(await page.getByText('已载入 10 个文件', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();

  } finally { await context.close(); }
}, 180000);

it('ADMIN: three modules delete in one atomic request and disappear before a slow dashboard refresh', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i,id] of ids.entries()) await sql.query("insert into modules(id,title,active,sort_order) values($1,$2,false,9999)", [id, `Batch delete fixture ${i}`]);
  const {page,context} = await pageFor(admin);
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  try {
    // A referenced member rejects the entire batch, including unused members.
    const rejected = await page.request.post(app + '/api/trpc/admin.removePrompts', {data:{ids:[ids[0],fixtures[0].moduleId]}});
    expect(rejected.status()).toBe(409);
    expect((await sql.query('select id from modules where id=any($1::uuid[])',[ids])).rowCount).toBe(3);
    const ordinary = await pageFor();
    expect((await ordinary.page.request.post(app + '/api/trpc/admin.removePrompts',{data:{ids}})).status()).toBe(403);
    await ordinary.context.close();
    const anon = await browser.newContext();
    expect((await anon.request.post(app + '/api/trpc/admin.removePrompts',{data:{ids}})).status()).toBe(401);
    await anon.close();
    await page.goto(app + '/admin/prompts');
    for (const id of ids) await page.getByRole('row').filter({has:page.getByTestId('admin-prompt-delete-' + id)}).getByRole('checkbox').check();
    await page.getByRole('button',{name:'删除选中',exact:true}).click();
    await page.getByRole('button',{name:'取消',exact:true}).click();
    expect((await sql.query('select id from modules where id=any($1::uuid[])',[ids])).rowCount).toBe(3);
    let mutationCount = 0, refreshStarted = false;
    page.on('request', request => { if (request.url().includes('/api/trpc/admin.removePrompts')) mutationCount++; });
    await page.route('**/api/trpc/admin.getPromptsDashboard*', async route => {
      refreshStarted = true;
      await refreshGate;
      await route.continue();
    });
    await page.getByRole('button',{name:'删除选中',exact:true}).click();
    const started = Date.now();
    const response = page.waitForResponse(response => response.url().includes('/api/trpc/admin.removePrompts'));
    await page.getByTestId('admin-module-confirm').click();
    expect((await response).status()).toBe(200);
    const acknowledged = Date.now();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    for (const id of ids) expect(await page.getByTestId('admin-prompt-delete-' + id).count()).toBe(0);
    expect(mutationCount).toBe(1);
    await expect.poll(() => refreshStarted).toBe(true);
    expect((await sql.query('select id from modules where id=any($1::uuid[])',[ids])).rowCount).toBe(0);
    console.log('MODULE_DELETE_LOCAL', JSON.stringify({modules:3,deleteRequests:mutationCount,requestMs:acknowledged-started,visibleAfterAckMs:Date.now()-acknowledged,refreshStillBlocked:true}));
    releaseRefresh();
    await page.unrouteAll({behavior:'wait'});
    // Successful replay is harmless; there are no extra deletions.
    const replay = await page.request.post(app + '/api/trpc/admin.removePrompts',{data:{ids}});
    expect(replay.status()).toBe(200);
    expect((await replay.json()).result.data.deletedIds).toEqual([]);
    await page.reload();
    await page.getByRole('heading',{name:'功能模块',exact:true}).waitFor();
    for (const id of ids) expect(await page.getByTestId('admin-prompt-delete-' + id).count()).toBe(0);
  } finally { releaseRefresh(); await context.close(); }
}, 180000);

it('ADMIN: model edits and unused-module deletion work through authenticated HTTP while client writes and referenced deletion are denied', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const login = await client.auth.signInWithPassword({ email: admin.email, password: admin.password });
  expect(login.error).toBeNull();
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(app + '/login?redirect=/admin/prompts');
  await page.getByPlaceholder('name@example.com').fill(admin.email);
  await page.getByPlaceholder('输入你的密码').fill(admin.password);
  await page.getByRole('button', { name: '登录', exact: true }).last().click();
  await page.waitForURL(u => u.pathname === '/admin/prompts', {timeout:90000});
  const call = async (name: string, data: any) => {
    const response = await page.request.post(app + '/api/trpc/' + name, { data });
    return {status: response.status()};
  };
  const previousSummarySetting = (await sql.query("select value from system_settings where key='v3_summary_model_id'")).rows;
  const model = randomUUID(), module = randomUUID();
  await sql.query("insert into ai_models(id,model_id,name,api_key) values($1,'local-synthetic','Before','LOCAL_ONLY')", [model]);
  const response = await call('model.updateModel', { id: model, name: 'After', description: 'Saved without provider call' });
  expect(response.status).toBe(200);
  expect((await sql.query('select name,api_key from ai_models where id=$1',[model])).rows[0]).toEqual({name:'After',api_key:'LOCAL_ONLY'});
  expect((await client.from('ai_models').update({name:'Denied'}).eq('id',model)).error).not.toBeNull();
  await sql.query("insert into modules(id,title,active) values($1,'Unused test module',false)",[module]);
  const card = randomUUID();
  await sql.query("insert into modules(id,title,active,link_module_id) values($1,'Linked card',true,$2)",[card,module]);
  expect((await call('admin.removePrompt',{id:module})).status).toBe(409);
  expect((await sql.query('select link_module_id from modules where id=$1',[card])).rows[0].link_module_id).toBe(module);
  await sql.query('delete from modules where id=$1',[card]);
  expect((await call('admin.removePrompt',{id:module})).status).toBe(200);
  expect((await sql.query('select id from modules where id=$1',[module])).rowCount).toBe(0);
  expect((await call('admin.removePrompt',{id:module})).status).toBe(200);
  expect((await call('admin.removePrompt',{id:fixtures[0].moduleId})).status).toBe(409);
  expect((await sql.query('select id from modules where id=$1',[fixtures[0].moduleId])).rowCount).toBe(1);
  const ordinary = await pageFor();
  expect((await ordinary.page.request.post(app + '/api/trpc/model.updateModel',{data:{id:model,name:'Denied'}})).status()).toBe(403);
  expect((await ordinary.page.request.post(app + '/api/trpc/admin.removePrompt',{data:{id:fixtures[0].moduleId}})).status()).toBe(403);
  expect((await ordinary.page.request.post(app + '/api/trpc/model.deleteModel',{data:{id:model}})).status()).toBe(403);
  expect((await client.rpc('admin_delete_unused_model',{p_actor_id:admin.id,p_model_id:model})).error?.code).toBe('42501');
  expect((await db.rpc('admin_delete_unused_model',{p_actor_id:actor,p_model_id:model})).error?.code).toBe('42501');
  const target = randomUUID();
  await sql.query("insert into ai_models(id,model_id,name) values($1,'unused-model','Unused deletion model')",[target]);
  await sql.query("insert into system_settings(key,value) values('ai_models',$1)",[JSON.stringify({primaryModelId:target.toUpperCase()})]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  await sql.query("delete from system_settings where key='ai_models'");
  const prompt = randomUUID();
  await sql.query('insert into prompts(id,model_id) values($1,$2)',[prompt,target]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  expect((await sql.query('select model_id from prompts where id=$1',[prompt])).rows[0].model_id).toBe(target);
  await sql.query('delete from prompts where id=$1',[prompt]);
  const linkedModule = randomUUID();
  await sql.query("insert into modules(id,title,model_id) values($1,'Model reference',$2)",[linkedModule,target]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  expect((await sql.query('select model_id from modules where id=$1',[linkedModule])).rows[0].model_id).toBe(target);
  await sql.query('delete from modules where id=$1',[linkedModule]);
  const historicalChat = randomUUID();
  await sql.query("insert into conversations(id,user_id,model_id,title) values($1,$2,$3,'Retained model history')",[historicalChat,admin.id,target]);
  expect((await call('model.deleteModel',{id:target})).status).toBe(409);
  expect((await sql.query('select model_id from conversations where id=$1',[historicalChat])).rows[0].model_id).toBe(target);
  await sql.query('delete from conversations where id=$1',[historicalChat]);
  await page.goto(app + '/admin/models');
  await page.getByTestId('admin-model-delete-' + target).click();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  expect((await sql.query('select id from ai_models where id=$1',[target])).rowCount).toBe(1);
  await page.getByTestId('admin-model-delete-' + target).click();
  await page.getByTestId('admin-model-delete-confirm').click();
  await expect.poll(async () => (await sql.query('select id from ai_models where id=$1',[target])).rowCount).toBe(0);
  expect((await call('model.deleteModel',{id:target})).status).toBe(200);
  expect((await call('model.deleteModel',{id:target})).status).toBe(200);
  expect((await sql.query('select id from ai_models where id=$1',[target])).rowCount).toBe(0);
  await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(model)]);
  await expect(sql.query("update system_settings set value=$1 where key='v3_summary_model_id'",[JSON.stringify(target)])).rejects.toMatchObject({code:'23503'});
  expect((await sql.query("select value from system_settings where key='v3_summary_model_id'")).rows[0].value).toBe(model);
  await expect(sql.query("insert into system_settings(key,value) values('delete-test-untouched','true'),('v3_summary_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(target)])).rejects.toMatchObject({code:'23503'});
  expect((await sql.query("select value from system_settings where key='delete-test-untouched'")).rowCount).toBe(0);
  await expect(sql.query("insert into system_settings(key,value) values('ai_models',$1)",[JSON.stringify({haikuModelId:target})])).rejects.toMatchObject({code:'23503'});
  // Unknown setting UUIDs are ordinary content, not model references.
  await sql.query("insert into system_settings(key,value) values('delete-test-note',$1)",[JSON.stringify(target)]);
  // Do not leak the synthetic model-reference fixture into the later full-form
  // settings save, which validates whether the selected summary model is usable.
  await sql.query("delete from system_settings where key in ('v3_summary_model_id','delete-test-note')");
  if (previousSummarySetting.length) await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1)", [JSON.stringify(previousSummarySetting[0].value)]);

  await ordinary.context.close(); await context.close();
  const privileges = await sql.query("select has_table_privilege('anon','ai_models','UPDATE') as anon,has_table_privilege('authenticated','modules','DELETE') as authenticated");
  expect(privileges.rows[0]).toEqual({anon:false,authenticated:false});
});


it('ADMIN: model deletion and settings writes serialize in both transaction orders', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  const holder = new pg.Client({connectionString:process.env.V3_LOCAL_DB});
  const waiter = new pg.Client({connectionString:process.env.V3_LOCAL_DB});
  await holder.connect(); await waiter.connect();
  const pid = (await waiter.query('select pg_backend_pid() as pid')).rows[0].pid;
  const waitForLock = () => expect.poll(async () => (await sql.query("select wait_event_type from pg_stat_activity where pid=$1",[pid])).rows[0]?.wait_event_type, {timeout:2000,interval:20}).toBe('Lock');
  const model = randomUUID();
  await sql.query("insert into ai_models(id,model_id,name) values($1,'concurrent-delete','Concurrent deletion model')",[model]);
  try {
    // Settings writes first: deletion waits, then refuses the committed reference.
    await holder.query('begin');
    await holder.query("insert into system_settings(key,value) values('assistant_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(model)]);
    const deletion = waiter.query('select admin_delete_unused_model($1,$2)',[admin.id,model]).then(()=>'deleted', e=>e.code);
    await waitForLock(); await holder.query('commit');
    expect(await deletion).toBe('23503');
    expect((await sql.query('select id from ai_models where id=$1',[model])).rowCount).toBe(1);
    await sql.query("delete from system_settings where key='assistant_model_id'");
    // Deletion first: the queued stale settings write is rejected after deletion commits.
    await holder.query('begin');
    await holder.query('select admin_delete_unused_model($1,$2)',[admin.id,model]);
    const setting = waiter.query("insert into system_settings(key,value) values('assistant_model_id',$1)",[JSON.stringify(model)]).then(()=>'saved', e=>e.code);
    await waitForLock(); await holder.query('commit');
    expect(await setting).toBe('23503');
    expect((await sql.query("select key from system_settings where key='assistant_model_id'")).rowCount).toBe(0);
    expect((await sql.query('select id from ai_models where id=$1',[model])).rowCount).toBe(0);
  } finally {
    await holder.query('rollback'); await waiter.query('rollback');
    await holder.end(); await waiter.end();
  }
});


aiTest('CHAT: provider usage is persisted exactly while missing or interrupted usage cannot settle success',async()=>{
 // Earlier Skill/admin cases create additional Luna and Qwen records. This
 // ordinary-chat usage fixture needs one active pricing record per model name.
 const priorPricing=(await sql.query("select id from ai_models where model_id in ('openai/gpt-5.6-luna','qwen/qwen3.8-27b') and is_active='true' and id<>$1",[localModel])).rows.map(r=>r.id);
 await sql.query("update ai_models set is_active='false' where id=any($1::uuid[])",[priorPricing]);
 await sql.query("insert into system_settings(key,value) values('primary_model_id',$1),('assistant_model_id',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(localModel)]);
 const {page,context}=await pageFor();
 const auth=await authenticated();const token=(await auth.auth.getSession()).data.session!.access_token;
 await sql.query("update ai_models set model_id='qwen/qwen3.8-27b',provider='openai',api_endpoint='',token_counting_supported='false',token_counting_method='unsupported' where id=$1",[localModel]);
 try{
  for(const mode of ['NATIVE','ZERO','MISSING','INVALID','TRUNCATED','LUNA']){
   if(mode==='LUNA')await sql.query("update ai_models set model_id='openai/gpt-5.6-luna' where id=$1",[localModel]);
   const requestId=randomUUID();
   const response=await page.request.post(app+'/api/ai/stream',{headers:{Authorization:'Bearer '+token},data:{message:'USAGE_CASE_'+mode,requestId}});
   const text=await response.text();expect(response.status(),text).toBe(200);
   const events=text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
   const conversationId=events.find(e=>e.type==='init')?.conversationId;expect(conversationId,text).toBeTruthy();
   const stats=(await sql.query('select input_tokens,output_tokens,metadata from token_stats where conversation_id=$1',[conversationId])).rows;
   if(['NATIVE','ZERO','LUNA'].includes(mode)){
    const input=mode==='ZERO'?0:800,output=mode==='ZERO'?0:30;
    expect(events.find(e=>e.type==='complete')?.usage).toMatchObject({inputTokens:input,outputTokens:output});
    expect(stats).toHaveLength(1);expect(stats[0]).toMatchObject({input_tokens:input,output_tokens:output,metadata:{count_source:'provider_usage'}});
   }else{
    expect(events.some(e=>e.type==='error')).toBe(true);expect(events.some(e=>e.type==='complete')).toBe(false);expect(stats).toHaveLength(0);
   }
  }
  expect((await sql.query('select token_counting_supported,api_endpoint from ai_models where id=$1',[localModel])).rows[0]).toEqual({token_counting_supported:'false',api_endpoint:''});
 }finally{await sql.query("update ai_models set is_active='true' where id=any($1::uuid[])",[priorPricing]);await context.close();}
});

// Optional local acceptance uses the Owner-supplied private directory payload.
// Method bytes stay outside git. This test never dispatches a model request.
it.skipIf(!process.env.V3_REAL_SKILL_INPUT)('REAL SKILL: original six-step publication, homepage entry and dual-model preflight without paid dispatch',async()=>{
 const {prepareModuleSkill}=await import('../skills/modulePublication');
 const {workbenchGeneration}=await import('../artifacts/generation');
 const {skillChatService}=await import('../artifacts/chat');
 const input=JSON.parse(readFileSync(process.env.V3_REAL_SKILL_INPUT!,'utf8')) as ModuleSkillInput;
 const primary=input.module.model_id,secondary=randomUUID();
 for(const [id,model_id,name] of [[primary,'qwen/qwen3.8-27b','Qwen dialogue'],[secondary,'openai/gpt-5.6-luna','Luna summary']]){
  await sql.query("insert into ai_models(id,model_id,name,provider,api_key,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family,input_token_cost,output_token_cost) values($1,$2,$3,'openai','LOCAL_ONLY','','4096',800000,'false','openai',150000,2000000)",[id,model_id,name]);
 }
 await sql.query("update ai_models set api_key='' where id=$1",[primary]);
 await expect(saveModuleSkill(db,owner,input)).rejects.toThrow('请先配置 API 密钥');
 expect((await sql.query('select id from modules where id=$1',[input.moduleId])).rowCount).toBe(0);
 await sql.query("update ai_models set api_key='LOCAL_ONLY' where id=$1",[primary]);
 await sql.query("alter table system_settings enable row level security; create policy local_existing_public_settings on system_settings for select to anon,authenticated using(key in ('maintenance_mode','home_show_onboarding','home_show_featured_modules','chat_show_model_selector','max_input_characters','site_name','support_email')); ");
 const prepared=prepareModuleSkill(input);
 writeFileSync(output+'/private-publication.json',JSON.stringify({...prepared,hashPayload:packageHashPayload(prepared.descriptor)}),{mode:0o600});
 await saveModuleSkill(db,owner,input);
 const read=await db.rpc('admin_read_skill_module',{p_actor_id:owner,p_module_id:input.moduleId});
 expect(read.error).toBeNull();
 for(const original of input.files)expect(read.data.files.find((f:any)=>f.path===original.path)?.base64).toBe(original.base64);
 expect(read.data.workflow.steps.map((s:any)=>s.title)).toEqual(input.steps.map(s=>s.title));
 await sql.query('insert into artifact_accounts values($1,$2,$3,$4)',[actor,input.moduleId,input.skillId,'youtube:new-account']);
 for(const [key,value] of [['home_show_onboarding',true],['home_analysis_module_id',input.moduleId],['v3_workbench_ai',true],['v3_summary_model_id',secondary],['v3_summary_max_tokens',2048]] as const)
  await sql.query('insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',[key,JSON.stringify(value)]);
 const {page,context}=await pageFor();
 try{
  let dispatches=0;page.on('request',r=>{if(r.url().includes('/workbench.generate'))dispatches++;});
  await page.goto(app+'/');await page.getByRole('button',{name:'开始分析',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/chat'&&!!u.searchParams.get('conversation'),{timeout:60000});
  await page.getByRole('heading',{name:input.module.title,exact:true}).waitFor();
  for(let n=0;n<input.steps.length;n++)await page.getByRole('button',{name:new RegExp('^'+(n+1)+'\\. '+input.steps[n].title)}).waitFor();
  expect(await page.getByRole('button',{name:'使用此 Skill',exact:true}).count()).toBe(0);
  await page.screenshot({path:output+'/real-skill-home-entry.png'});
  const conversationId=new URL(page.url()).searchParams.get('conversation')!;
  const user=await authenticated(),service=workbenchService(user,db),chat=skillChatService(user,db);
  const {databaseSkillSource}=await import('../skills/databaseSource');
  const {activateSkill,identityOf}=await import('../skills/loader');
  const source=databaseSkillSource({userClient:user,privateClient:db,moduleId:input.moduleId,skillId:input.skillId,revisionId:input.revisionId});
  for(const step of input.steps){
   const loaded=await activateSkill(source,identityOf(prepared.descriptor),{resources:step.resources,maxContextBytes:2097152});
   expect(loaded.resourceIdentities().map(r=>r.path).sort()).toEqual(['SKILL.md',...step.resources].sort());
  }
  const project=(await service.projects()).find(p=>p.moduleId===input.moduleId)!;
  const round=(await service.rounds(project.projectId)).find(r=>r.state==='draft')!;
  const scope={projectId:project.projectId,roundId:round.roundId};
  let calls=0;const ai=workbenchGeneration(user,db,async()=>{calls++;throw new Error('Real-model dispatch is not authorized in this test');});
  const turnId=randomUUID(),body='我准备从零创建 YouTube 账号，请先了解我的经验、目标观众和时间预算。';
  await chat.submit({conversationId,requestId:turnId,stepId:'step-1',body});
  const snapshot=await service.read(scope.projectId,scope.roundId);
  const request={...scope,conversationId,turnId,purpose:'reply' as const,stepId:'step-1',instruction:body,expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
  const quote=await ai.quote(request);expect(quote.reservedCredits).toBeGreaterThan(0);
  for(const patch of ["api_key=''","is_active='false'","input_limit=1","input_limit=13000","input_token_cost=0"]){
   await sql.query('update ai_models set '+patch+' where id=$1',[secondary]);
   await expect(ai.quote(request)).rejects.toThrow();
   await sql.query("update ai_models set api_key='LOCAL_ONLY',is_active='true',input_limit=800000,input_token_cost=150000 where id=$1",[secondary]);
  }
  await sql.query("update system_settings set value=$1 where key='v3_summary_model_id'",[JSON.stringify(primary)]);
  await expect(ai.quote(request)).rejects.toThrow('SUMMARY_MODEL_MUST_DIFFER');
  await sql.query("delete from system_settings where key='v3_summary_model_id'");
  await expect(ai.quote(request)).rejects.toThrow('SUMMARY_MODEL_NOT_CONFIGURED');
  await sql.query("insert into system_settings(key,value) values('v3_summary_model_id',$1)",[JSON.stringify(secondary)]);
  const anonymous=createClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
  expect((await anonymous.from('system_settings').select('key,value').eq('key','home_analysis_module_id')).data).toEqual([{key:'home_analysis_module_id',value:input.moduleId}]);
  expect((await anonymous.from('system_settings').select('key,value').eq('key','v3_summary_model_id')).data).toEqual([]);
  expect((await user.from('system_settings').upsert({key:'v3_summary_model_id',value:secondary})).error).not.toBeNull();
  expect((await anonymous.from('system_settings').upsert({key:'home_analysis_module_id',value:input.moduleId})).error).not.toBeNull();
  expect((await page.request.post(app+'/api/trpc/settings.updateSystemSettings',{data:{key:'v3_summary_model_id',value:secondary}})).status()).toBe(403);
  expect(calls).toBe(0);expect(dispatches).toBe(0);
  expect((await sql.query('select id from billing_history where user_id=$1',[actor])).rowCount).toBe(0);
  expect((await sql.query('select token_counting_supported,api_endpoint,input_limit from ai_models where id=$1',[primary])).rows[0]).toEqual({token_counting_supported:'false',api_endpoint:'',input_limit:800000});
  writeFileSync(output+'/real-skill-result.json',JSON.stringify({files:input.files.length,packageHash:prepared.descriptor.packageHash,steps:input.steps.map(s=>s.title),homepageEntry:true,models:['qwen/qwen3.8-27b','openai/gpt-5.6-luna'],providerCalls:calls,billingRows:0}));
 }finally{await context.close();}
 const admin=await newUser();await sql.query("update profiles set role='admin' where id=$1",[admin.id]);
 // The disposable app's settings bootstrap also reads an empty membership catalog.
 await sql.query('create table if not exists membership_plans(id uuid primary key,sort_order integer); grant select on membership_plans to service_role; notify pgrst,\'reload schema\'');
 const adminBrowser=await pageFor(admin);
 try{
  const p=adminBrowser.page;
  await p.goto(app+'/admin/settings');await p.getByRole('tab',{name:'功能设置',exact:true}).click();
  const select=p.getByLabel('步骤成果整理模型',{exact:true});
  await expect.poll(()=>select.locator('option[value="'+secondary+'"]').isEnabled()).toBe(true);
  await select.selectOption(secondary);
  await p.getByRole('button',{name:'保存所有设置',exact:true}).click();
  await p.getByText('设置保存成功',{exact:true}).waitFor();
  await p.screenshot({path:output+'/real-skill-summary-settings.png'});
  await sql.query("update ai_models set api_key='' where id=$1",[secondary]);
  for(const [name,data] of [['settings.updateSystemSettings',{key:'v3_summary_model_id',value:secondary}],['settings.updateSystemSettingsBulk',[{key:'v3_summary_model_id',value:secondary}]]] as const){
   const response=await p.request.post(app+'/api/trpc/'+name,{data});expect(response.status()).toBe(400);
   expect(await response.text()).not.toContain('LOCAL_ONLY');
  }
  await sql.query("update ai_models set api_key='LOCAL_ONLY' where id=$1",[secondary]);
  for(const patch of ["is_deleted='true'","status='disabled'"]){
   await sql.query('update profiles set '+patch+' where id=$1',[admin.id]);
   const response=await p.request.post(app+'/api/trpc/settings.updateSystemSettings',{data:{key:'v3_summary_model_id',value:primary}});
   expect(response.status()).toBe(403);
   expect((await sql.query("select value from system_settings where key='v3_summary_model_id'")).rows[0].value).toBe(secondary);
   await sql.query("update profiles set is_deleted='false',status='active' where id=$1",[admin.id]);
  }
 }finally{await adminBrowser.context.close();}
},180000);

it('ADMIN: settings save recovers under staging column grants without weakening authorization', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1", [admin.id]);
  await sql.query("create table if not exists membership_plans(id uuid primary key,sort_order integer); grant select on membership_plans to service_role; notify pgrst,'reload schema'");
  const { page, context } = await pageFor(admin);
  const beforeSettings = (await sql.query('select key,value from system_settings order by key')).rows;
  const profileColumns = (await sql.query("select column_name from information_schema.columns where table_schema='public' and table_name='profiles'")).rows.map(r => r.column_name);
  const migration = readFileSync(new URL('../../../../db/migrations/0076_admin_settings_writer_profile_read.sql', import.meta.url), 'utf8');
  const request = (name: string, data: unknown) => page.request.post(app + '/api/trpc/' + name, { data });
  const target = { key: 'max_input_characters', value: '10000' };
  try {
    // Reproduce the observed staging posture, instead of the fixture's GRANT ALL.
    await sql.query('revoke select on profiles from service_role');
    await sql.query('revoke select (' + profileColumns.map(c => '"' + c + '"').join(',') + ') on profiles from service_role');
    await sql.query('grant select(id,role,status,nickname,email,credits,membership_level,created_at) on profiles to service_role');
    const deniedRead = await db.from('profiles').select('role,status,is_deleted').eq('id',admin.id).single();
    expect(deniedRead.error?.code).toBe('42501');
    for (const [name,data] of [['settings.updateSystemSettings',target],['settings.updateSystemSettingsBulk',[target]]] as const) {
      const response = await request(name,data);
      expect(response.status()).toBe(503);
      const body = await response.text();
      expect(body).toContain('暂时无法验证设置保存权限');
      expect(body).not.toMatch(/permission denied|42501|is_deleted/);
    }
    await page.goto(app + '/admin/settings');
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    await page.getByTestId('admin-setting-max_input_characters').fill('10000');
    await page.getByTestId('admin-setting-free_tier_messages').fill('0');
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('暂时无法验证设置保存权限，请稍后重试',{exact:true}).waitFor();
    expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(beforeSettings);

    const grants = () => sql.query("select grantee,column_name,privilege_type from information_schema.column_privileges where table_schema='public' and table_name='profiles' and grantee in ('anon','authenticated','service_role') order by grantee,column_name,privilege_type").then(r=>r.rows);
    const beforeGrants = await grants();
    await sql.query(migration);
    const afterGrants = await grants();
    expect(afterGrants.filter(g=>!beforeGrants.some(b=>JSON.stringify(b)===JSON.stringify(g))))
      .toEqual([{grantee:'service_role',column_name:'is_deleted',privilege_type:'SELECT'}]);
    expect(beforeGrants.every(b=>afterGrants.some(g=>JSON.stringify(b)===JSON.stringify(g)))).toBe(true);
    await sql.query(migration);
    expect(await grants()).toEqual(afterGrants);
    expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(beforeSettings);

    // The failed draft stays on screen and succeeds with the same Save All click.
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('设置保存成功',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    expect(await page.getByTestId('admin-setting-max_input_characters').inputValue()).toBe('10000');
    expect(await page.getByTestId('admin-setting-free_tier_messages').inputValue()).toBe('0');
    expect((await sql.query("select value from system_settings where key='max_input_characters'")).rows[0].value).toBe('10000');
    expect((await request('settings.updateSystemSettings',{key:'max_input_characters',value:'12000'})).status()).toBe(200);
    await page.screenshot({path:output + '/admin-settings-save-recovered.png'});
    const saved = (await sql.query('select key,value from system_settings order by key')).rows;

    for (const patch of ["is_deleted='true'", "status='disabled'", "status='banned'", "role='user'"]) {
      await sql.query('update profiles set ' + patch + ' where id=$1',[admin.id]);
      for (const [name,data] of [['settings.updateSystemSettings',target],['settings.updateSystemSettingsBulk',[target]]] as const) {
        expect((await request(name,data)).status()).toBe(403);
      }
      expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(saved);
      await sql.query("update profiles set is_deleted='false',status='active',role='admin' where id=$1",[admin.id]);
    }
    const user = await authenticated();
    const anon = createClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
    for (const client of [user,anon]) expect((await client.from('system_settings').upsert(target)).error).not.toBeNull();
    for (const [name,data] of [['settings.updateSystemSettings',target],['settings.updateSystemSettingsBulk',[target]]] as const) {
      expect((await fetch(app+'/api/trpc/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})).status).toBe(401);
    }
    // Recovery revokes only the new column grant, preserves data, and fails closed.
    await sql.query('revoke select(is_deleted) on profiles from service_role');
    expect((await request('settings.updateSystemSettings',target)).status()).toBe(503);
    expect((await sql.query('select key,value from system_settings order by key')).rows).toEqual(saved);
    await sql.query(migration);
    expect((await request('settings.updateSystemSettings',target)).status()).toBe(200);
  } finally {
    await sql.query('grant select on profiles to service_role');
    await sql.query("update profiles set is_deleted='false',status='active',role='admin' where id=$1",[admin.id]);
    await context.close();
  }
},180000);

it('ADMIN: settings save submits the complete form with selected model records and rejects stale or named models atomically', async () => {
  const admin = await newUser();
  await sql.query("update profiles set role='admin' where id=$1",[admin.id]);
  await sql.query("create table if not exists membership_plans(id uuid primary key,sort_order integer); grant select on membership_plans to service_role; notify pgrst,'reload schema'");
  const primary=randomUUID(),assistant=randomUUID();
  for(const [id,name,model] of [[primary,'Settings Qwen','qwen/qwen3.8-27b'],[assistant,'Settings Luna','openai/gpt-5.6-luna']]) {
    await sql.query("insert into ai_models(id,name,model_id,provider,api_key,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family,input_token_cost,output_token_cost) values($1,$2,$3,'openai','SETTINGS_PRIVATE_CANARY','',4096,800000,'false','openai',150000,2000000)",[id,name,model]);
  }
  const snapshot=()=>sql.query('select key,value from system_settings order by key').then(r=>r.rows);
  const before=await snapshot();
  // Actual canonical model-reference trigger reproduces the user's old failure.
  const oldWrite=await db.from('system_settings').upsert([{key:'max_input_characters',value:'10000'},{key:'assistant_model_id',value:'openai/gpt-5.6-luna'}],{onConflict:'key'});
  expect(oldWrite.error?.code).toBe('23503');expect(await snapshot()).toEqual(before);
  const {page,context}=await pageFor(admin);
  try {
    await page.goto(app+'/admin/settings');
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    await expect.poll(()=>page.getByLabel('辅助模型',{exact:true}).locator('option[value="'+assistant+'"]').count()).toBe(1);
    await page.getByLabel('主力模型',{exact:true}).selectOption(primary);
    await page.getByLabel('辅助模型',{exact:true}).selectOption(assistant);
    await page.getByLabel('步骤成果整理模型',{exact:true}).selectOption(assistant);
    for(const [key,value] of [['max_input_characters','10000'],['free_tier_messages','0'],['search_surcharge_credits','5']])await page.getByTestId('admin-setting-'+key).fill(value);
    let submitted: Record<string,Array<{key:string;value:string}>> | null=null;
    const pattern='**/api/trpc/settings.updateSystemSettingsBulk**';
    const capture=async(route:import('../../../../../apps/web/node_modules/@playwright/test').Route)=>{submitted=route.request().postDataJSON();await route.abort();};
    await page.route(pattern,capture);
    await page.getByTestId('admin-settings-save-all').click();
    await expect.poll(()=>submitted!==null).toBe(true);
    await page.unroute(pattern,capture);
    const full=(submitted! as Record<string,Array<{key:string;value:string}>>)['0'];
    expect(full.length).toBe(53);
    expect(full).toEqual(expect.arrayContaining([{key:'primary_model_id',value:primary},{key:'assistant_model_id',value:assistant},{key:'v3_summary_model_id',value:assistant},{key:'max_input_characters',value:'10000'},{key:'free_tier_messages',value:'0'},{key:'search_surcharge_credits',value:'5'}]));
    // Exercise the full batch envelope, not a single-row surrogate.
    for(const invalid of ['openai/gpt-5.6-luna',randomUUID()]) {
      const payload=full.map(item=>item.key==='assistant_model_id'?{...item,value:invalid}:item);
      const response=await page.request.post(app+'/api/trpc/settings.updateSystemSettingsBulk?batch=1',{data:{0:payload}});
      expect(response.status()).toBe(400);expect(await response.text()).not.toContain('SETTINGS_PRIVATE_CANARY');
      expect(await snapshot()).toEqual(before);
    }
    // A model can become unavailable after loading the selector. The actual UI
    // shows the actionable server message and retains every draft value.
    await sql.query("update ai_models set is_active='false' where id=$1",[primary]);
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('所选主力模型已删除或停用，请刷新模型列表后重新选择',{exact:true}).waitFor();
    expect(await snapshot()).toEqual(before);
    expect(await page.getByTestId('admin-setting-max_input_characters').inputValue()).toBe('10000');
    await sql.query("update ai_models set is_active='true' where id=$1",[primary]);
    const savedResponse=page.waitForResponse(r=>r.url().includes('settings.updateSystemSettingsBulk')&&r.request().method()==='POST');
    await page.getByTestId('admin-settings-save-all').click();
    expect((await savedResponse).status()).toBe(200);
    await page.getByText('设置保存成功',{exact:true}).waitFor();
    const persisted=await snapshot();
    for(const item of full)expect(persisted.find(row=>row.key===item.key)?.value).toEqual(item.value);
    await page.reload();
    await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    for(const item of full.filter(item=>['primary_model_id','assistant_model_id','v3_summary_model_id','max_input_characters','free_tier_messages','search_surcharge_credits'].includes(item.key)))expect(await page.getByTestId('admin-setting-'+item.key).inputValue()).toBe(item.value);
    await page.screenshot({path:output+'/settings-models-full-save.png'});
    // Optional blank selections remain valid and survive reload.
    await page.getByLabel('主力模型',{exact:true}).selectOption('');
    await page.getByLabel('辅助模型',{exact:true}).selectOption('');
    await page.getByTestId('admin-settings-save-all').click();
    await page.getByText('设置保存成功',{exact:true}).waitFor();
    await page.reload();await page.getByRole('tab',{name:'功能设置',exact:true}).click();
    expect(await page.getByLabel('主力模型',{exact:true}).inputValue()).toBe('');
    expect(await page.getByLabel('辅助模型',{exact:true}).inputValue()).toBe('');
    // The new lightweight catalog neither exposes credentials nor requires a
    // model to be eligible for Skill summary work.
    const catalog=await page.request.get(app+'/api/trpc/settings.getRoutingModels');
    expect(catalog.status()).toBe(200);expect(await catalog.text()).not.toContain('SETTINGS_PRIVATE_CANARY');
    const normal=await pageFor();
    try {expect((await normal.page.request.get(app+'/api/trpc/settings.getRoutingModels')).status()).toBe(403);}
    finally {await normal.context.close();}
    expect((await fetch(app+'/api/trpc/settings.getRoutingModels')).status).toBe(401);
  } finally {
    await context.close();
    await sql.query("update ai_models set is_active='true' where id=$1",[primary]);
  }
},180000);

// Consumption admission uses the same local Auth/PostgREST/SQL and real billing RPCs.
// These cases require the narrow ACL/cap/fault proxy from the dedicated adapter.
const consumptionTest=it.skipIf(process.env.V3_WORKBENCH_PHASE==='restore'||process.env.V3_CONSUMPTION_SUITE!=='1');
async function consumptionHttp(user: Awaited<ReturnType<typeof authenticated>>, name: string, data: unknown) {
 const {createServerClient}=requireWeb('@supabase/ssr');
 const cookies:Array<{name:string;value:string}>=[];
 const session=(await user.auth.getSession()).data.session!;
 const cookieClient=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[],setAll:(values:Array<{name:string;value:string}>)=>cookies.push(...values)}});
 const auth=await cookieClient.auth.setSession(session);if(auth.error)throw auth.error;
 const response=await fetch(app+'/api/trpc/workbench.'+name,{method:'POST',headers:{Cookie:cookies.map(c=>c.name+'='+c.value).join('; '),'Content-Type':'application/json'},body:JSON.stringify(data)});
 return {status:response.status,body:await response.json()};
}
async function consumptionCounts() {
 const rows=(await sql.query("select operation_type,count(*)::int n from billing_history where user_id=$1 group by operation_type",[actor])).rows;
 const provider=await (await fetch(url+'/__workbench_model_calls')).json();
 return {calls:provider.calls,pre:rows.find(r=>r.operation_type==='pre_deduct')?.n??0,settle:rows.find(r=>r.operation_type==='settle')?.n??0};
}
async function consumptionSearch(t:Awaited<ReturnType<typeof generationFixture>>) {
 const {localMcpFixture}=await import('./fixtures/agentKeyServer'),{databaseBilledResearchStore}=await import('../research/store'),{tavilySchema}=await import('../research/tavilySchema');
 const query='Fictional public exhibition',name='Tavily/post_search';
 const wire={discovery:{tools:[{name}]},description:{name,category:'Search',provider:'Tavily',params:tavilySchema,cost:{credits_per_call:1.1},health:{healthy:true},execute_as:{name,params:{query:'<The search query to execute with Tavily.>'}}},result:{category:'search',provider:'Tavily',took_ms:10,data:{query,answer:null,follow_up_questions:null,images:[],response_time:0.01,results:[],usage:{credits:1}}}};
 const fixture=await localMcpFixture(databaseBilledResearchStore(db,actor),'json',wire);
 await sql.query("insert into system_settings(key,value) values('v3_web_search','true'),('search_surcharge_credits','5'),('local_research_endpoint',$1) on conflict(key) do update set value=excluded.value",[JSON.stringify(fixture.endpoint)]);
 return {fixture,input:{...t.scope,requestId:randomUUID(),stepId:'step-0',query}};
}
consumptionTest.each(['generation','search'])('CONSUMPTION: %s narrow ACL hourly refusal precedes external calls and reservation',async(kind)=>{
 const t=await generationFixture(),v=await t.request(),search=await consumptionSearch(t),marker=randomUUID();
 const acl=(await db.from('billing_history').select('amount',{count:'exact'}).eq('user_id',actor));
 expect(acl.error?.code).toBe('42501');
 await sql.query("insert into billing_history(id,user_id,operation_type,amount) values($1,$2,'settle',-10000)",[marker,actor]);
 try {
  const before=await consumptionCounts();
  const response=await consumptionHttp(t.user,kind==='generation'?'generate':'search',kind==='generation'?v:search.input);
  const after=await consumptionCounts();
  console.log('CONSUMPTION_OBSERVED',JSON.stringify({kind,status:response.status,modelCalls:after.calls-before.calls,preDeductions:after.pre-before.pre,searchCalls:search.fixture.events.filter(e=>e==='execute').length}));
  expect.soft(after.calls-before.calls).toBe(0);expect.soft(after.pre-before.pre).toBe(0);expect.soft(search.fixture.events).toHaveLength(0);
  expect(response.status).toBe(403);
 } finally {await sql.query('delete from billing_history where id=$1',[marker]);await search.fixture.stop();}
},90000);

consumptionTest.each(['generation','search'].flatMap(kind=>['permission','daily','truncated','positive-amount','missing-data','missing-count','missing-amount','string-amount','null-amount','balance'].map(mode=>[kind,mode])))('CONSUMPTION: %s rejects %s with zero provider and pre-deduction effects',async(kind,mode)=>{
 const t=await generationFixture(),v=await t.request(),search=await consumptionSearch(t),marker=randomUUID();
 await sql.query("insert into billing_history(id,user_id,operation_type,amount,created_at,metadata) values($1,$2,'settle',-1,now(),$3)",[marker,actor,{consumptionTest:marker}]);
 try {
  if(mode==='permission')await sql.query('REVOKE SELECT(user_id,operation_type,amount,created_at) ON billing_history FROM authenticated');
  else if(mode==='daily')await sql.query("update billing_history set amount=-50000,created_at=now()-interval '2 hours' where id=$1",[marker]);
  else if(mode==='positive-amount')await sql.query('update billing_history set amount=10000 where id=$1',[marker]);
  else if(mode==='truncated')await sql.query("insert into billing_history(user_id,operation_type,amount,metadata) select $1,'settle',-1,$2 from generate_series(1,1000)",[actor,{consumptionTest:marker}]);
  else if(mode==='balance')await sql.query('update profiles set credits=0 where id=$1',[actor]);
  else await fetch(url+'/__consumption_fault/'+mode);
  const before=await consumptionCounts(),response=await consumptionHttp(t.user,kind==='generation'?'generate':'search',kind==='generation'?v:search.input),after=await consumptionCounts();
  expect.soft(after.calls-before.calls).toBe(0);expect.soft(after.pre-before.pre).toBe(0);expect.soft(search.fixture.events).toHaveLength(0);
  expect(response.status).toBe(mode==='balance'?412:mode==='daily'?403:503);
  expect(JSON.stringify(response.body)).not.toContain('42501');
 } finally {
  await fetch(url+'/__consumption_fault/none');await sql.query('GRANT SELECT(user_id,operation_type,amount,created_at) ON billing_history TO authenticated');
  await sql.query("delete from billing_history where metadata->>'consumptionTest'=$1",[marker]);
  await search.fixture.stop();
 }
},90000);
consumptionTest.each(['generation','search'])('CONSUMPTION: %s reads only the actor and accepts complete history without duplicate billing',async(kind)=>{
 const t=await generationFixture(),v=await t.request(),search=await consumptionSearch(t),marker=randomUUID();
 await sql.query("insert into billing_history(user_id,operation_type,amount,metadata) select $1,'settle',-10000,$2 from generate_series(1,1001)",[owner,{consumptionTest:marker}]);
 try {
  const mine=await t.user.from('billing_history').select('amount',{count:'exact'}).eq('user_id',actor);
  expect(mine.error).toBeNull();expect(mine.count).toBe(mine.data!.length);
  const foreign=await t.user.from('billing_history').select('amount',{count:'exact'}).eq('user_id',owner);
  expect(foreign).toMatchObject({data:[],count:0,error:null});
  const before=await consumptionCounts(),data=kind==='generation'?v:search.input,name=kind==='generation'?'generate':'search';
  const response=await consumptionHttp(t.user,name,data);expect(response.status).toBe(200);
  // Recover the exact durable result with no new allowance and unavailable consumption reads.
  await sql.query('update profiles set credits=0 where id=$1',[actor]);
  await sql.query('REVOKE SELECT(user_id,operation_type,amount,created_at) ON billing_history FROM authenticated');
  expect(await consumptionHttp(t.user,name,data)).toEqual(response);
  const after=await consumptionCounts();expect(after.pre-before.pre).toBe(1);expect(after.settle-before.settle).toBe(1);
  expect(after.calls-before.calls).toBe(kind==='generation'?1:0);expect(search.fixture.events.filter(e=>e==='execute')).toHaveLength(kind==='search'?1:0);
  const other=await authenticated(await newUser());
  expect((await consumptionHttp(other,name,data)).status).toBe(403);
  expect((await consumptionCounts()).pre).toBe(after.pre);
 } finally {await sql.query('GRANT SELECT(user_id,operation_type,amount,created_at) ON billing_history TO authenticated');await sql.query("delete from billing_history where metadata->>'consumptionTest'=$1",[marker]);await search.fixture.stop();}
},90000);
consumptionTest.each(['generation','search'])('CONSUMPTION: %s pending settlement recovers under original identity without new allowance',async(kind)=>{
 const t=await generationFixture(),v=await t.request(),search=await consumptionSearch(t),marker=randomUUID();
 const before=await consumptionCounts(),data=kind==='generation'?v:search.input,name=kind==='generation'?'generate':'search';
 await sql.query("create function consumption_reject_settle() returns trigger language plpgsql as $$begin raise exception 'synthetic settlement outage';end$$;create trigger consumption_reject_settle before insert on credit_transactions for each row execute function consumption_reject_settle()");
 try {await consumptionHttp(t.user,name,data);}
 finally {await sql.query('drop trigger consumption_reject_settle on credit_transactions;drop function consumption_reject_settle()');}
 const pending=kind==='generation'
  ? (await sql.query('select state,charged_credits from artifact_generations where request_id=$1',[v.requestId])).rows[0]
  : (await sql.query('select state,charged_credits from research_operations where id=$1',[search.input.requestId])).rows[0];
 expect(pending).toEqual({state:kind==='generation'?'responded':'succeeded',charged_credits:null});
 await sql.query("insert into billing_history(id,user_id,operation_type,amount) values($1,$2,'settle',-10000)",[marker,actor]);
 await sql.query('update profiles set credits=0 where id=$1',[actor]);
 await sql.query('REVOKE SELECT(user_id,operation_type,amount,created_at) ON billing_history FROM authenticated');
 try {
  const response=await consumptionHttp(t.user,name,data);expect(response.status).toBe(200);
  expect(await consumptionHttp(t.user,name,data)).toEqual(response);
  const after=await consumptionCounts();expect(after.pre-before.pre).toBe(1);expect(after.settle-before.settle).toBe(2); // one marker and one original settlement
  expect(after.calls-before.calls).toBe(kind==='generation'?1:0);expect(search.fixture.events.filter(e=>e==='execute')).toHaveLength(kind==='search'?1:0);
  const foreign=await authenticated(await newUser());expect((await consumptionHttp(foreign,name,data)).status).toBe(403);
  expect((await consumptionCounts()).pre).toBe(after.pre);
 } finally {await sql.query('GRANT SELECT(user_id,operation_type,amount,created_at) ON billing_history TO authenticated');await sql.query('delete from billing_history where id=$1',[marker]);await search.fixture.stop();}
},90000);
consumptionTest('CONSUMPTION: reply and summary each check new spending while preserving original result recovery',async()=>{
 const t=await generationFixture(),{skillChatService}=await import('../artifacts/chat'),chat=skillChatService(t.user,db);
 const binding=await chat.enter({...t.scope,requestId:randomUUID()}),turnId=randomUUID(),body='Fictional reply and organization';
 await chat.submit({conversationId:binding.conversationId,stepId:'step-0',body,requestId:turnId});
 const snap=await t.service.read(t.scope.projectId,t.scope.roundId);
 const value={...t.scope,conversationId:binding.conversationId,turnId,stepId:'step-0',instruction:body,expectedSteps:Object.fromEntries(Object.entries(snap.steps).map(([k,s])=>[k,{version:s.version,reviewVersion:s.reviewVersion}]))};
 const before=await consumptionCounts();
 for(const purpose of ['reply','summary'] as const){
  const requestId=purpose==='reply'?turnId:(await chat.summary({conversationId:binding.conversationId,requestId:turnId})).requestId;
  const input={...value,purpose},quote=await t.ai.quote(input),request={...input,requestId,quoteHash:quote.quoteHash,budgetCredits:quote.reservedCredits},marker=randomUUID();
  await sql.query("insert into billing_history(id,user_id,operation_type,amount) values($1,$2,'settle',-10000)",[marker,actor]);
  try {const a=await consumptionCounts();expect((await consumptionHttp(t.user,'generate',request)).status).toBe(403);const b=await consumptionCounts();expect(b.calls).toBe(a.calls);expect(b.pre).toBe(a.pre);}
  finally {await sql.query('delete from billing_history where id=$1',[marker]);}
  const response=await consumptionHttp(t.user,'generate',request);expect(response.status).toBe(200);
  await sql.query('REVOKE SELECT(user_id,operation_type,amount,created_at) ON billing_history FROM authenticated');
  try {expect(await consumptionHttp(t.user,'generate',request)).toEqual(response);}
  finally {await sql.query('GRANT SELECT(user_id,operation_type,amount,created_at) ON billing_history TO authenticated');}
 }
 const after=await consumptionCounts();expect(after.calls-before.calls).toBe(2);expect(after.pre-before.pre).toBe(2);expect(after.settle-before.settle).toBe(2);
},90000);
consumptionTest('CONSUMPTION: complete 1000-row own history is read and summed without foreign rows',async()=>{
 const t=await generationFixture(),v=await t.request(),marker=randomUUID();
 // Existing settlements are outside this fresh reader's test window.
 const previous=(await sql.query("update billing_history set created_at=created_at-interval '2 days' where user_id=$1 returning id",[actor])).rows.map(r=>r.id);
 await sql.query("insert into billing_history(user_id,operation_type,amount,metadata) select $1,'settle',-1,$2 from generate_series(1,1000)",[actor,{consumptionTest:marker}]);
 try {
  const read=await t.user.from('billing_history').select('amount',{count:'exact'}).eq('user_id',actor).eq('operation_type','settle').gte('created_at',new Date(Date.now()-3600000).toISOString());
  expect(read.error).toBeNull();expect(read.count).toBe(1000);expect(read.data).toHaveLength(1000);
  const before=await consumptionCounts();expect((await consumptionHttp(t.user,'generate',v)).status).toBe(200);const after=await consumptionCounts();expect(after.calls-before.calls).toBe(1);expect(after.pre-before.pre).toBe(1);
 } finally {await sql.query("delete from billing_history where metadata->>'consumptionTest'=$1",[marker]);await sql.query("update billing_history set created_at=created_at+interval '2 days' where id=any($1::uuid[])",[previous]);}
},90000);

consumptionTest.each([5,'5'])('CONSUMPTION: admin saves search price %j then Skill reserves and settles the same value',async price=>{
 const t=await generationFixture(),search=await consumptionSearch(t);
 const {createServerClient}=requireWeb('@supabase/ssr');const cookies:any[]=[];
 const session=(await t.user.auth.getSession()).data.session!;const client=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[],setAll:(v:any[])=>cookies.push(...v)}});await client.auth.setSession(session);
 await sql.query("update profiles set role='admin' where id=$1",[actor]);
 try{
  const saved=await fetch(app+'/api/trpc/settings.updateSystemSettingsBulk',{method:'POST',headers:{Cookie:cookies.map(c=>c.name+'='+c.value).join('; '),'Content-Type':'application/json'},body:JSON.stringify([{key:'search_surcharge_credits',value:price}])});expect(saved.status).toBe(200);
  expect((await sql.query("select value from system_settings where key='search_surcharge_credits'")).rows[0].value).toBe(price);
  const response=await consumptionHttp(t.user,'search',search.input);expect(response.status).toBe(200);
  const row=(await sql.query('select state,user_quote_credits,charged_credits,result from research_operations where id=$1',[search.input.requestId])).rows[0];
  expect(row).toMatchObject({state:'succeeded',user_quote_credits:5,charged_credits:5});expect(row.result.searchEvidence).toEqual({executed:true,queryCount:1,providerUsage:{unit:'tavily-credit',credits:1}});expect(row.result.objects).toEqual([]);expect(row.result.cost.actual).toBeNull();
  await settingPrice('invalid');expect((await consumptionHttp(t.user,'search',search.input)).status).toBe(200);expect(search.fixture.events.filter(e=>e==='execute')).toHaveLength(1);
 }finally{await sql.query("update profiles set role='user' where id=$1",[actor]);await search.fixture.stop();}
 async function settingPrice(value:unknown){await sql.query("update system_settings set value=$1 where key='search_surcharge_credits'",[JSON.stringify(value)]);}
},90000);
consumptionTest.each([0,'0',null,'',-1,1000000])('CONSUMPTION: invalid or zero paid Skill search price %j refuses before provider/reservation',async price=>{
 const t=await generationFixture(),search=await consumptionSearch(t);await sql.query("update system_settings set value=$1 where key='search_surcharge_credits'",[JSON.stringify(price)]);
 try{const before=await consumptionCounts();expect((await consumptionHttp(t.user,'search',search.input)).status).toBe(503);expect(search.fixture.events).toEqual([]);expect((await consumptionCounts()).pre).toBe(before.pre);}finally{await search.fixture.stop();}
},90000);

it.skipIf(process.env.V3_WORKBENCH_PHASE === 'restore')('SLICE: fixed A to title to revised A retains dependency restrictions and leaves B independent',async()=>{
 const {artifactReuse}=await import('../artifacts/reuse');
 const {sliceLinks}=await import('../agentSlice/links');
 const user=await authenticated(),service=workbenchService(user,db),reuse=artifactReuse(user,db),links=sliceLinks(user,db);
 const src=await fixture({id:'slice-position',label:'虚构定位',methodText:'Synthetic positioning.',workflow:makeWorkflow(6,true)});
 const script=await fixture({id:'slice-script',label:'虚构脚本',methodText:'Synthetic script ALPHA: prose only.',workflow:makeWorkflow(1,false)});
 const titleFlow=makeWorkflow(1,false);titleFlow.steps[0].maxLength=1000;
 const title=await fixture({id:'slice-title',label:'虚构标题',methodText:'Synthetic title BETA: numbered titles only.',workflow:titleFlow});
 const p=randomUUID(),r=randomUUID();
 // This suite shares an actor with earlier tests; positioning is unique per account.
 const sliceAccount='synthetic:slice-'+p;
 await sql.query('update artifact_accounts set account=$1 where actor_id=$2 and module_id=$3 and skill_id=$4',[sliceAccount,actor,src.moduleId,src.pack.id]);
 await service.start({projectId:p,roundId:r,requestId:randomUUID(),registration:src.registration,account:sliceAccount},src.moduleId);
 async function publish(projectId:string,roundId:string,body:string){
  let state=await service.read(projectId,roundId);
  for(const step of state.workflow.steps){
   await service.execute({action:'save',projectId,roundId,stepId:step.id,requestId:randomUUID(),expectedVersion:state.steps[step.id].version,body:body+' '+step.title,evidenceIds:[]});
   state=await service.read(projectId,roundId);
   await service.execute({action:'confirm',projectId,roundId,stepId:step.id,requestId:randomUUID(),expectedVersion:state.steps[step.id].version,expectedReviewVersion:state.steps[step.id].reviewVersion});
   state=await service.read(projectId,roundId);
  }
  await service.execute({action:'publish',projectId,roundId,requestId:randomUUID(),expectedSteps:Object.fromEntries(Object.entries(state.steps).map(([k,v])=>[k,{version:v.version,reviewVersion:v.reviewVersion}]))});
  return service.report(projectId,roundId);
 }
 const position=await publish(p,r,'POSITION');
 for(const [id,target] of [['slice-p-script',script],['slice-p-title',title]] as const)
  await sql.query('INSERT INTO artifact_reference_configs VALUES($1,$2,$3,$4,20000,true)',[id,src.registration,target.registration,JSON.stringify(['step-2'])]);
 await sql.query("INSERT INTO agent_slice_pairs VALUES('slice-pair',$1,$2,'[\"step-0\"]','[\"step-0\"]',20000,true)",[script.registration,title.registration]);
 const sliceModel=randomUUID(),summaryModel=randomUUID(),conversation=randomUUID();
 await sql.query("INSERT INTO system_settings(key,value) VALUES('v3_workbench_ai','true') ON CONFLICT(key) DO UPDATE SET value='true'");
 await sql.query("INSERT INTO ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost) VALUES($1,'qwen/qwen3.8-flash','Synthetic slice model','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',150000,600000)",[sliceModel]);
 await sql.query('UPDATE modules SET model_id=$1 WHERE id=ANY($2::uuid[])',[sliceModel,[script.moduleId,title.moduleId]]);
 await sql.query("INSERT INTO ai_models(id,model_id,name,api_key,api_endpoint,input_token_cost,output_token_cost) VALUES($1,'qwen/qwen3.8-27b','Synthetic summary model','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',150000,600000)",[summaryModel]);
 await sql.query("INSERT INTO system_settings(key,value) VALUES('v3_summary_model_id',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(summaryModel)]);
 await sql.query("INSERT INTO conversations(id,user_id,title,agent_slice_mode) VALUES($1,$2,'Synthetic dual Skill',true)",[conversation,actor]);
 const begin=async(projectId:string,roundId:string,requestId:string,body:string,budgetCredits=50,preferenceRefs:Array<{scope:string;name:string;version:number}>=[])=>{
  const result=await db.rpc('agent_slice_begin',{p_actor_id:actor,p_conversation_id:conversation,p_request_id:requestId,p_payload:{projectId,roundId,stepId:'step-0',pairId:'slice-pair',modelId:sliceModel,budgetCredits,body,preferenceRefs}});
  if(result.error)throw result.error;return result.data;
 };
 const a=randomUUID(),b=randomUUID(),t=randomUUID();
 const create=(id:string,configId:string)=>reuse.create({projectId:id,roundId:id,requestId:id,sourceVersionId:position.id!,configId,title:id===a?'脚本 A':id===b?'脚本 B':'标题'});
 await Promise.all([create(a,'slice-p-script'),create(b,'slice-p-script')]);
 await service.execute({action:'userEvidence',projectId:a,roundId:a,requestId:randomUUID(),body:'Synthetic restricted A input',observedAt:null,supersedes:null});
 const extra=(await service.read(a,a)).evidence.find(e=>JSON.stringify(e.payload).includes('restricted A input'))!;
 await service.execute({action:'save',projectId:a,roundId:a,stepId:'step-0',expectedVersion:0,requestId:randomUUID(),body:'A1',evidenceIds:[extra.id]});
 const av1=await publish(a,a,'A1');
 await create(t,'slice-p-title');
 const bind={projectId:t,roundId:t,sourceVersionId:av1.id!,pairId:'slice-pair',requestId:randomUUID()};
 const [bound,replay]=await Promise.all([links.link(bind),links.link(bind)]);expect(bound).toEqual(replay);
 await expect(links.link({...bind,requestId:randomUUID()})).rejects.toThrow();
 const reader=await links.reader({projectId:t,roundId:t});expect(await reader()).toContain('A1');
 const titleRequest=randomUUID();
 expect(await begin(t,t,titleRequest,'为 A1 写标题')).toEqual(await begin(t,t,titleRequest,'为 A1 写标题'));
 await expect(begin(b,b,titleRequest,'改为 B')).rejects.toBeDefined();
 const {sliceAccounting}=await import('../agentSlice/accounting');
 const {runSkillSlice}=await import('../agentSlice/runner');
 const sdkRequest=randomUUID();await begin(t,t,sdkRequest,'读取 A1 后拟标题',100000);
 await sql.query('update profiles set credits=100000 where id=$1',[actor]);
 const modelRow=(await sql.query('select * from ai_models where id=$1',[sliceModel])).rows[0];
 const accounting=sliceAccounting(user,db,sdkRequest,modelRow);
 const {loadSliceContext}=await import('../agentSlice/context');const assembled=await loadSliceContext(user,db,sdkRequest);
 expect(assembled.loaded.forModel()).toContain('BETA');expect(assembled.loaded.forModel()).not.toContain('ALPHA');
 const {confirmedPreferences}=await import('../agentSlice/preferences');const prefs=confirmedPreferences(user,db);
 await prefs.change({scope:'user',name:'表达风格',value:'简洁中文',expectedVersion:0,confirmed:true,requestId:randomUUID(),action:'confirm'});
 const prefRequest=randomUUID();await begin(t,t,prefRequest,'偏好装配验证',50,[{scope:'user',name:'表达风格',version:1}]);
 expect((await loadSliceContext(user,db,prefRequest)).data.preferences).toEqual([{scope:'user',name:'表达风格',value:'简洁中文'}]);
 await prefs.change({scope:'user',name:'表达风格',value:'详细中文',expectedVersion:1,confirmed:true,requestId:randomUUID(),action:'confirm'});
 await expect(loadSliceContext(user,db,prefRequest)).rejects.toThrow('SLICE_CONTEXT_CHANGED');
 const correctedRequest=randomUUID();await begin(t,t,correctedRequest,'采用新偏好',50,[{scope:'user',name:'表达风格',version:2}]);
 expect((await loadSliceContext(user,db,correctedRequest)).data.preferences).toEqual([{scope:'user',name:'表达风格',value:'详细中文'}]);
 await prefs.change({scope:'user',name:'表达风格',expectedVersion:2,confirmed:true,requestId:randomUUID(),action:'delete'});
 await expect(loadSliceContext(user,db,correctedRequest)).rejects.toThrow('SLICE_CONTEXT_CHANGED');

 let providerCalls=0;
 const sdkInput={model:modelRow.model_id,apiKey:'SYNTHETIC_ONLY',instructions:assembled.loaded.forModel(),input:JSON.stringify(assembled.data),maxOutputTokens:100,readArtifact:reader,...accounting};
 const fakeProvider=async(_url:unknown,init?:RequestInit)=>{
  providerCalls++;const request=JSON.parse(String(init?.body));
  if(providerCalls===2)expect(JSON.stringify(request.messages)).toContain('A1');
  const message=providerCalls===1?{role:'assistant',content:null,tool_calls:[{id:'fixed-read',type:'function',function:{name:'read_selected_artifact',arguments:'{}'}}]}:{role:'assistant',content:'1. Synthetic title from A1'};
  return new Response(JSON.stringify({id:'synthetic-'+providerCalls,object:'chat.completion',created:1,model:modelRow.model_id,choices:[{index:0,finish_reason:providerCalls===1?'tool_calls':'stop',message}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}),{headers:{'content-type':'application/json'}});
 };
 const sdkReply=await runSkillSlice(sdkInput,fakeProvider);expect(sdkReply.body).toContain('title from A1');
 const {sliceResults}=await import('../agentSlice/results');const results=sliceResults(user,db);
 const syntheticPrivate=assembled.loaded.forModel();
 const replyScope={executionId:sdkRequest,phase:'reply' as const};
 await expect(results.save(replyScope,JSON.parse(syntheticPrivate).resources[0].path,syntheticPrivate)).rejects.toThrow('SLICE_OUTPUT_RESTRICTED');
 const savedReply=await results.save(replyScope,sdkReply.body,syntheticPrivate);
 expect(savedReply.state).toBe('saved');expect(await results.save(replyScope,sdkReply.body,syntheticPrivate)).toEqual(savedReply);
 expect(await results.read(replyScope)).toEqual(savedReply);
 if(savedReply.state!=='saved')throw new Error('reply missing');
 await expect(service.execute({action:'saveCandidate',projectId:t,roundId:t,stepId:'step-0',candidateId:savedReply.candidateId,expectedVersion:(await service.read(t,t)).steps['step-0'].version,requestId:randomUUID(),body:savedReply.body})).rejects.toThrow();
 expect(providerCalls).toBe(2);
 expect((await accounting.recover()).map(c=>c.state)).toEqual(['settled','settled']);
 await expect(runSkillSlice(sdkInput,fakeProvider)).rejects.toThrow();expect(providerCalls).toBe(2);
 expect((await sql.query("SELECT count(*)::int n FROM token_stats WHERE metadata->>'executionId'=$1",[sdkRequest])).rows[0].n).toBe(2);
 const summaryRow=(await sql.query('select * from ai_models where id=$1',[summaryModel])).rows[0];
 let settleUnavailable=true;
 const delayedAdmin=new Proxy(db,{get(target,key){
  if(key==='rpc')return (name:string,args:any)=>{
   if(name==='agent_slice_call'&&args.p_execution_id===sdkRequest&&args.p_action==='settle'&&settleUnavailable)
    return {abortSignal:()=>Promise.resolve({data:null,error:{code:'TEST_ONLY_UNAVAILABLE'}})};
   return target.rpc(name,args);
  };
  return Reflect.get(target,key);
 }});
 const summaryAccounting=sliceAccounting(user,delayedAdmin,sdkRequest,summaryRow,'summary');let summaryCalls=0;
 const summaryInput={...sdkInput,...summaryAccounting,model:summaryRow.model_id,readArtifact:undefined,input:'已完成回复：'+savedReply.body,instructions:'Synthetic summary: preserve the selected title.'};
 const summaryProvider=async(_url:unknown,init?:RequestInit)=>{
  summaryCalls++;const request=JSON.parse(String(init?.body));expect(request.model).toBe(summaryRow.model_id);expect(request.tools??[]).toEqual([]);
  expect(JSON.stringify(request.messages)).toContain('Synthetic title from A1');
  return new Response(JSON.stringify({id:'synthetic-summary',object:'chat.completion',created:1,model:summaryRow.model_id,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic selected title'}}],usage:{prompt_tokens:12,completion_tokens:5,total_tokens:17}}),{headers:{'content-type':'application/json'}});
 };
 const summaryReply=await runSkillSlice(summaryInput,summaryProvider);expect(summaryReply.body).toBe('Synthetic selected title');
 const summaryScope={executionId:sdkRequest,phase:'summary' as const};
 const savedSummary=await results.save(summaryScope,summaryReply.body,syntheticPrivate);expect(savedSummary.state).toBe('saved');
 if(savedSummary.state!=='saved')throw new Error('summary missing');expect(savedSummary.adoptable).toBe(true);
 expect((await sql.query("select state from agent_slice_calls where execution_id=$1 and phase='summary'",[sdkRequest])).rows[0].state).toBe('responded');
 expect(await results.read(summaryScope)).toEqual(savedSummary);settleUnavailable=false;
 const {recoverSlice}=await import('../agentSlice/recovery'); // Formal browser refresh must perform maintenance below.
 expect(summaryCalls).toBe(1);expect(providerCalls).toBe(2);
 await expect(runSkillSlice(summaryInput,summaryProvider)).rejects.toThrow();expect(summaryCalls).toBe(1);
 expect((await sql.query('select phase, count(*)::int n from agent_slice_calls where execution_id=$1 group by phase order by phase',[sdkRequest])).rows).toEqual([{phase:'reply',n:2},{phase:'summary',n:1}]);
 expect((await sql.query("SELECT count(*)::int n FROM token_stats WHERE metadata->>'executionId'=$1",[sdkRequest])).rows[0].n).toBe(2);

 // Unadopted replies are fixed at admission, scoped to this work, not UI pagination.
 const followRequest=randomUUID();await begin(t,t,followRequest,'保留第一个标题，改短一点',100000);
 const followContext=await loadSliceContext(user,db,followRequest);
 expect(followContext.data.discussion).toEqual([{user:'读取 A1 后拟标题',assistant:savedReply.body}]);
 expect((await loadSliceContext(user,db,sdkRequest)).data.discussion).toEqual([]);
 const independentDiscussion=randomUUID();await begin(b,b,independentDiscussion,'独立脚本 B',100000);
 expect((await loadSliceContext(user,db,independentDiscussion)).data.discussion).toEqual([]);
 const fixedDiscussion=(await sql.query('select discussion_refs from agent_slice_executions where request_id=$1',[followRequest])).rows[0].discussion_refs;
 expect(fixedDiscussion).toEqual([{executionId:sdkRequest,candidateId:savedReply.candidateId}]);
 const unknownRequest=randomUUID();await begin(t,t,unknownRequest,'测试缺失用量',100000);
 const unknownAccounting=sliceAccounting(user,db,unknownRequest,modelRow);let unknownCalls=0;
 const missingUsage=async()=>{unknownCalls++;return new Response(JSON.stringify({id:'synthetic-missing-usage',object:'chat.completion',created:1,model:modelRow.model_id,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Not a verified completion'}}]}),{headers:{'content-type':'application/json'}});};
 await expect(runSkillSlice({...sdkInput,...unknownAccounting},missingUsage)).rejects.toThrow();
 expect((await unknownAccounting.recover()).map(c=>c.state)).toEqual(['unknown']);
 const deniedSummary=sliceAccounting(user,db,unknownRequest,summaryRow,'summary');
 await expect(runSkillSlice({...summaryInput,...deniedSummary},summaryProvider)).rejects.toThrow();expect(summaryCalls).toBe(1);
 await expect(runSkillSlice({...sdkInput,...unknownAccounting},missingUsage)).rejects.toThrow();expect(unknownCalls).toBe(1);
 const observation=(await sql.query('select evidence from agent_slice_calls where execution_id=$1',[unknownRequest])).rows[0].evidence;
 expect(observation).toMatchObject({providerId:'synthetic-missing-usage',finishReason:'stop',inputTokens:null,outputTokens:null});
 expect((await sql.query("SELECT count(*)::int n FROM token_stats WHERE metadata->>'executionId'=$1",[unknownRequest])).rows[0].n).toBe(0);
 await expect(results.save({executionId:unknownRequest,phase:'reply'},'Unknown body',syntheticPrivate)).rejects.toThrow();
 const {sliceExecutor}=await import('../agentSlice/execute');const joinedRequest=randomUUID();
 await sql.query("update agent_slice_calls set dispatched_at=clock_timestamp()-interval '3 minutes' where execution_id=$1",[unknownRequest]);
 expect(await sliceExecutor(user,db,missingUsage).execute({executionId:unknownRequest,phase:'reply'})).toEqual({state:'unavailable',reason:'outcome_unknown'});expect(unknownCalls).toBe(1);

 const {sliceAdmission}=await import('../agentSlice/admission');const admission=sliceAdmission(user,db);
 const {sliceEntry}=await import('../agentSlice/entry');const entry=sliceEntry(user,db);const newConversation=randomUUID();
 expect(await entry.open({requestId:newConversation})).toEqual({conversationId:newConversation});expect(await entry.open({requestId:newConversation})).toEqual({conversationId:newConversation});
 expect((await sql.query('select count(*)::int n from conversations where id=$1',[newConversation])).rows[0].n).toBe(1);
 const sourceOptions=await entry.sources();expect(sourceOptions).toContainEqual(expect.objectContaining({sourceVersionId:position.id,version:1,pairId:'slice-pair'}));expect(JSON.stringify(sourceOptions)).not.toContain('POSITION ');
 const targetOptions=await entry.targets();expect(targetOptions.some(x=>x.projectId===t&&x.purpose==='title')).toBe(true);expect(targetOptions.some(x=>x.projectId===b&&x.purpose==='script')).toBe(true);

 const admissionInput={conversationId:conversation,requestId:joinedRequest,projectId:t,roundId:t,stepId:'step-0',pairId:'slice-pair',body:'从 A1 拟标题并保存',preferenceRefs:[]};
 const admitted=await admission.begin(admissionInput);expect(await admission.begin(admissionInput)).toEqual(admitted);
 await expect(admission.begin({...admissionInput,projectId:b,roundId:b})).rejects.toThrow();
 // Admission replay retains identity even if routing subsequently changes.
 await sql.query('update modules set model_id=$1 where id=$2',[summaryModel,title.moduleId]);
 expect(await admission.begin(admissionInput)).toEqual(admitted);
 await sql.query('update modules set model_id=$1 where id=$2',[sliceModel,title.moduleId]);
 let joinedCalls=0;
 const joinedTransport=async(_url:unknown,init?:RequestInit)=>{
  joinedCalls++;const req=JSON.parse(String(init?.body));
  expect(JSON.stringify(req.messages)).toContain('BETA');expect(JSON.stringify(req.messages)).not.toContain('ALPHA');
  if(joinedCalls===1)expect(JSON.stringify(req.messages)).toContain('Synthetic title from A1');
  if(joinedCalls===1)expect(req.tool_choice).toMatchObject({function:{name:'read_selected_artifact'}});
  if(joinedCalls===2)expect(JSON.stringify(req.messages)).toContain('A1');
  if(joinedCalls===3){expect(req.model).toBe(summaryRow.model_id);expect(req.tools??[]).toEqual([]);expect(JSON.stringify(req.messages)).toContain('Joined title');}
  const msg=joinedCalls===1?{role:'assistant',content:null,tool_calls:[{id:'joined-read',type:'function',function:{name:'read_selected_artifact',arguments:'{}'}}]}:{role:'assistant',content:joinedCalls===2?'Joined title':'Saved joined title'};
  return new Response(JSON.stringify({id:'joined-'+joinedCalls,object:'chat.completion',created:1,model:req.model,choices:[{index:0,finish_reason:joinedCalls===1?'tool_calls':'stop',message:msg}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}),{headers:{'content-type':'application/json'}});
 };
 // Non-transactional sequence makes exactly the first candidate INSERT fail.
 // This tests rollback of both usage evidence and candidate, not an HTTP-only mock.
 await sql.query("create sequence slice_final_fault; create function slice_final_fault_once() returns trigger language plpgsql as $$ begin if NEW.body='Joined title' and nextval('slice_final_fault')=1 then raise exception 'synthetic candidate unavailable'; end if; return NEW; end $$; create trigger slice_final_fault before insert on artifact_candidates for each row execute function slice_final_fault_once()");
 let lostFinalAcknowledgement=0;
 const finalAdmin=new Proxy(db,{get(target,key){if(key==='rpc')return(name:string,args:any)=>{
  if(name==='agent_slice_record_final'&&args.p_execution_id===joinedRequest&&args.p_phase==='summary')return {abortSignal:async(signal:AbortSignal)=>{const response=await target.rpc(name,args).abortSignal(signal);if(!response.error&&lostFinalAcknowledgement++===0)return {...response,error:{code:'TEST_LOST_ACK'},data:null};return response;}};
  return target.rpc(name,args);
 };return Reflect.get(target,key);}});
 const executor=sliceExecutor(user,finalAdmin,joinedTransport);
 const joinedReply=await executor.execute({executionId:joinedRequest,phase:'reply'});expect(joinedReply).toMatchObject({state:'saved',body:'Joined title'});
 expect(await executor.execute({executionId:joinedRequest,phase:'reply'})).toEqual(joinedReply);expect(joinedCalls).toBe(2);
 const joinedSummary=await executor.execute({executionId:joinedRequest,phase:'summary'});expect(joinedSummary).toMatchObject({state:'saved',body:'Saved joined title'});
 expect(await executor.execute({executionId:joinedRequest,phase:'summary'})).toEqual(joinedSummary);expect(joinedCalls).toBe(3);
 expect(lostFinalAcknowledgement).toBe(1);
 expect(Number((await sql.query('select last_value from slice_final_fault')).rows[0].last_value)).toBe(2);
 await sql.query('drop trigger slice_final_fault on artifact_candidates; drop function slice_final_fault_once(); drop sequence slice_final_fault');
 // Recreate the service after committed output; no SDK/provider work is repeated.
 expect(await sliceExecutor(user,db,joinedTransport).execute({executionId:joinedRequest,phase:'reply'})).toEqual(joinedReply);expect(joinedCalls).toBe(3);

 const {readSliceConversation}=await import('../agentSlice/conversation');
 const historyInput={conversationId:conversation,limit:2};
 const firstPage=await readSliceConversation(user,db,historyInput);
 expect(firstPage.items.length).toBe(2);expect(firstPage.nextCursor).not.toBeNull();
 const allHistory=[...firstPage.items];let historyCursor=firstPage.nextCursor;
 while(historyCursor){const next=await readSliceConversation(user,db,{...historyInput,before:historyCursor});allHistory.push(...next.items);historyCursor=next.nextCursor;}
 expect(new Set(allHistory.map(x=>x.executionId)).size).toBe(allHistory.length);
 expect(allHistory.find(x=>x.executionId===joinedRequest)?.reply).toMatchObject({state:'saved',body:'Joined title'});
 expect(allHistory.some(x=>x.projectId===t)).toBe(true);
 expect(joinedCalls).toBe(3);
 let browserA='',browserB='',browserA2='';
 const browserSession=await pageFor();
 try {
  const httpHistory=await browserSession.page.request.get(app+'/api/trpc/agentSlice.conversation',{params:{input:JSON.stringify({conversationId:conversation})}});
  expect(httpHistory.status()).toBe(200);expect(await httpHistory.text()).toContain('Joined title');
  const oldPath=await browserSession.page.request.post(app+'/api/ai/stream',{headers:{Authorization:'Bearer '+(await user.auth.getSession()).data.session!.access_token},data:{message:'must not generate',conversationId:conversation,requestId:randomUUID(),modelId:sliceModel}});expect(oldPath.status()).toBe(403);
  const httpBegin=await browserSession.page.request.post(app+'/api/trpc/agentSlice.begin',{data:admissionInput});expect(httpBegin.status()).toBe(200);expect(await httpBegin.text()).toContain(joinedRequest);
  const httpRead=await browserSession.page.request.get(app+'/api/trpc/agentSlice.result',{params:{input:JSON.stringify({executionId:joinedRequest,phase:'summary'})}});
  expect(httpRead.status()).toBe(200);expect(await httpRead.text()).toContain('Saved joined title');
  const httpReplay=await browserSession.page.request.post(app+'/api/trpc/agentSlice.executePhase',{data:{executionId:joinedRequest,phase:'summary'}});
  expect(httpReplay.status()).toBe(200);expect(await httpReplay.text()).toContain('Saved joined title');expect(joinedCalls).toBe(3);
  await browserSession.page.goto(app+'/chat?mode=agent-slice&conversation='+conversation);
  await browserSession.page.getByRole('main',{name:'双 Skill 对话'}).waitFor();
  await browserSession.page.getByText('Joined title',{exact:true}).waitFor();
  await expect.poll(async()=>(await sql.query("select state from agent_slice_calls where execution_id=$1 and phase='summary'",[sdkRequest])).rows[0].state).toBe('settled');
  expect((await sql.query("SELECT count(*)::int n FROM token_stats WHERE metadata->>'executionId'=$1",[sdkRequest])).rows[0].n).toBe(3);
  expect(summaryCalls).toBe(1);expect(providerCalls).toBe(2);
  await browserSession.page.reload();await browserSession.page.getByText('Joined title',{exact:true}).waitFor();
  expect(joinedCalls).toBe(3);
  // Confirm in the existing conversation, then use it in a distinct new conversation.
  await browserSession.page.getByLabel('使用 Skill 创作').waitFor();
  await browserSession.page.getByText('我的创作偏好',{exact:true}).click();
  await browserSession.page.getByLabel('写作偏好').fill('先给具体例子');await browserSession.page.getByRole('button',{name:'确认保存偏好'}).click();
  await browserSession.page.getByText('已确认：先给具体例子',{exact:true}).waitFor();
  await browserSession.page.getByLabel('写作偏好').fill('结尾给行动建议');await browserSession.page.getByRole('button',{name:'确认保存偏好'}).click();
  await browserSession.page.getByText('已确认：结尾给行动建议',{exact:true}).waitFor();
  await browserSession.page.goto(app+'/chat?conversation='+newConversation);
  await browserSession.page.getByRole('main',{name:'双 Skill 对话'}).waitFor();
  await browserSession.page.getByLabel('使用 Skill 创作').selectOption(t+':step-0:slice-pair');
  await browserSession.page.evaluate(()=>{
   const timing:{start?:number;feedback?:number;reply?:number}={};(window as any).__sliceTiming=timing;
   document.addEventListener('submit',()=>{timing.start=performance.now();},{once:true,capture:true});
   const observer=new MutationObserver(()=>{if(timing.start===undefined)return;
    const turns=Array.from(document.querySelectorAll('section[aria-label="一轮对话"]'));
    const turn=turns.find(t=>t.textContent?.includes('浏览器新增标题'));if(!turn)return;
    if(timing.feedback===undefined&&turn.querySelector('[aria-label="助手回答"]'))timing.feedback=performance.now()-timing.start;
    if(turn.textContent?.includes('浏览器真实接线回复')){timing.reply=performance.now()-timing.start;observer.disconnect();}
   });observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  });
  await browserSession.page.getByLabel('消息',{exact:true}).fill('浏览器新增标题');await browserSession.page.getByRole('button',{name:'发送',exact:true}).click();
  await browserSession.page.getByText('浏览器新增标题',{exact:true}).waitFor();
  await browserSession.page.getByText('浏览器真实接线回复',{exact:true}).waitFor();
  await expect.poll(async()=>Number((await sql.query("select count(*) n from agent_slice_calls c join agent_slice_executions e on e.request_id=c.execution_id where e.conversation_id=$1 and c.state='settled'",[newConversation])).rows[0].n),{timeout:20000}).toBe(3);
  const browserTiming=await browserSession.page.evaluate(()=>(window as any).__sliceTiming);expect(browserTiming.feedback).toBeGreaterThanOrEqual(0);expect(browserTiming.reply).toBeGreaterThanOrEqual(browserTiming.feedback);console.log('SLICE synthetic browser timing (ms; includes local HTTP and provider fixture wait)',JSON.stringify(browserTiming));
  const actualCalls=await (await fetch(url+'/__slice_calls')).json();expect(actualCalls).toHaveLength(3);expect(actualCalls.every((c:{hasConfirmedPreference:boolean;hasOldPreference:boolean})=>c.hasConfirmedPreference&&!c.hasOldPreference)).toBe(true);
  await browserSession.page.reload();await browserSession.page.getByText('浏览器真实接线回复',{exact:true}).waitFor();expect(await (await fetch(url+'/__slice_calls')).json()).toHaveLength(3);
  await browserSession.page.getByText('我的创作偏好',{exact:true}).click();

  await browserSession.page.getByRole('button',{name:'删除这条偏好'}).click();await browserSession.page.getByText('已确认：尚未设置',{exact:true}).waitFor();
  const page=browserSession.page;
  const sendAndSave=async(message:string,expectedCalls:number)=>{
   await page.getByLabel('消息',{exact:true}).fill(message);await page.getByRole('button',{name:'发送',exact:true}).click();
   await page.getByText(message,{exact:true}).waitFor();
   await expect.poll(async()=>Number((await sql.query("select count(*) n from agent_slice_calls c join agent_slice_executions e on e.request_id=c.execution_id where e.conversation_id=$1 and c.state='settled'",[newConversation])).rows[0].n),{timeout:20000}).toBe(expectedCalls);
   await page.getByRole('button',{name:'采用本轮成果',exact:true}).click();
   await expect.poll(async()=>page.getByLabel('本步骤成果',{exact:true}).inputValue()).toBe('浏览器整理成果');
  };
  const confirmAndPublish=async()=>{await page.getByRole('button',{name:'确认本步骤成果',exact:true}).click();await page.getByRole('button',{name:'发布已确认版本',exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');};
  await page.getByText('基于定位报告新建脚本',{exact:true}).click();
  await page.getByLabel('选择定位报告与版本').selectOption(position.id!+':slice-pair');
  await page.getByLabel('新脚本名称').fill('浏览器脚本 A');await page.getByRole('button',{name:'创建独立脚本',exact:true}).click();
  await expect.poll(async()=>page.getByLabel('新脚本名称').inputValue(),{timeout:10000}).toBe('');
  browserA=(await page.getByLabel('使用 Skill 创作').inputValue()).split(':')[0];
  await page.getByLabel('新脚本名称').fill('浏览器脚本 B');await page.getByRole('button',{name:'创建独立脚本',exact:true}).click();
  await expect.poll(async()=>page.getByLabel('新脚本名称').inputValue(),{timeout:10000}).toBe('');
  browserB=(await page.getByLabel('使用 Skill 创作').inputValue()).split(':')[0];expect(browserA).not.toBe(browserB);
  expect((await service.read(browserA,browserA)).state).toBe('draft');expect((await service.read(browserB,browserB)).state).toBe('draft');
  const replay={projectId:browserA,requestId:browserA,sourceVersionId:position.id!,pairId:'slice-pair',purpose:'script',title:'浏览器脚本 A'};
  expect((await page.request.post(app+'/api/trpc/agentSlice.continueWork',{data:replay})).status()).toBe(200);
  expect(await (await fetch(url+'/__slice_calls')).json()).toHaveLength(3);
  await page.getByText('基于定位报告新建脚本',{exact:true}).click();
  await page.getByLabel('使用 Skill 创作').selectOption(browserA+':step-0:slice-pair');
  await sendAndSave('为这个账号写脚本 A',6);await confirmAndPublish();
  // A report arriving after the user selects B must not open under B's identity.
  let reportFetched=false,reportDelivered=false,releaseReport:()=>void=()=>{};
  const reportBarrier=new Promise<void>(resolve=>{releaseReport=resolve;});
  await page.route('**/api/trpc/workbench.report*',async route=>{const response=await route.fetch();reportFetched=true;await reportBarrier;await route.fulfill({response});reportDelivered=true;});
  await page.getByRole('button',{name:'查看正式报告',exact:true}).click();
  await expect.poll(()=>reportFetched).toBe(true);
  await page.getByLabel('使用 Skill 创作').selectOption(browserB+':step-0:slice-pair');
  releaseReport();await expect.poll(()=>reportDelivered).toBe(true);
  await expect.poll(()=>page.getByRole('complementary',{name:'当前作品成果'}).getAttribute('aria-busy')).toBe('false');
  await expect.poll(()=>page.getByRole('dialog').count()).toBe(0);
  expect(await page.getByLabel('使用 Skill 创作').inputValue()).toBe(browserB+':step-0:slice-pair');
  await page.unroute('**/api/trpc/workbench.report*');
  await page.getByLabel('使用 Skill 创作').selectOption(browserA+':step-0:slice-pair');
  await page.getByRole('button',{name:'用这版脚本创作标题',exact:true}).click();
  await expect.poll(async()=>{const value=await page.getByLabel('使用 Skill 创作').inputValue();return value!==browserA+':step-0:slice-pair'&&(await page.getByLabel('使用 Skill 创作').locator('option:checked').textContent())?.startsWith('标题 · 浏览器脚本 A')===true;},{timeout:10000}).toBe(true);
  const browserTitleRound=(await page.getByLabel('使用 Skill 创作').inputValue()).split(':')[0];
  await sendAndSave('为刚才的脚本拟标题',9);
  await page.getByLabel('本步骤成果',{exact:true}).fill('选定标题：倾斜的地球如何创造四季');await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect.poll(async()=>(await service.read(browserTitleRound,browserTitleRound)).steps['step-0'].body).toBe('选定标题：倾斜的地球如何创造四季');
  await confirmAndPublish();await page.getByLabel('带回哪份脚本').selectOption(browserA);
  await page.getByRole('button',{name:'采用这些标题，修订脚本',exact:true}).click();
  await expect.poll(async()=>{const value=await page.getByLabel('使用 Skill 创作').inputValue();return value!==browserTitleRound+':step-0:slice-pair';},{timeout:10000}).toBe(true);
  browserA2=(await page.getByLabel('使用 Skill 创作').inputValue()).split(':')[0];expect(browserA2).not.toBe(browserA);
  await sendAndSave('按选定标题修订原脚本',12);await confirmAndPublish();
  await page.reload();await page.getByText('为这个账号写脚本 A',{exact:true}).waitFor();await page.getByText('为刚才的脚本拟标题',{exact:true}).waitFor();await page.getByText('按选定标题修订原脚本',{exact:true}).waitFor();
  expect((await service.read(browserB,browserB)).steps['step-0'].body).toBe('');expect((await service.report(browserA,browserA2)).version).toBe(2);expect((await service.read(b,b)).steps['step-0'].body).toBe('');
  const afterDelete=await (await fetch(url+'/__slice_calls')).json();expect(afterDelete).toHaveLength(12);expect(afterDelete.slice(3).every((c:{hasConfirmedPreference:boolean;hasOldPreference:boolean})=>!c.hasConfirmedPreference&&!c.hasOldPreference)).toBe(true);

  // Real application death while the provider has received a request but has not replied.
  const killedRequest=randomUUID();await begin(b,b,killedRequest,'Synthetic process death',100000);
  const controls={method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}};
  expect((await fetch(url+'/__slice_hold',controls)).ok).toBe(true);
  const killedHttp=page.request.post(app+'/api/trpc/agentSlice.executePhase',{data:{executionId:killedRequest,phase:'reply'},timeout:60000}).catch(()=>null);
  await expect.poll(async()=>(await (await fetch(url+'/__slice_calls')).json()).length,{timeout:20000}).toBe(13);
  const financialBeforeKill=(await sql.query('select state,pre_deduct_id from agent_slice_calls where execution_id=$1',[killedRequest])).rows;expect(financialBeforeKill).toHaveLength(1);expect(financialBeforeKill[0].state).toBe('dispatched');
  expect((await fetch(url+'/__restart_app',controls)).ok).toBe(true);await killedHttp;
  await expect.poll(async()=>{try{return (await fetch(app+'/login')).ok;}catch{return false;}},{timeout:60000}).toBe(true);
  await sql.query("update agent_slice_calls set dispatched_at=clock_timestamp()-interval '3 minutes' where execution_id=$1",[killedRequest]);
  const recoveredHttp=await page.request.post(app+'/api/trpc/agentSlice.executePhase',{data:{executionId:killedRequest,phase:'reply'}});expect(recoveredHttp.ok()).toBe(true);expect(await recoveredHttp.text()).toContain('outcome_unknown');
  expect((await page.request.post(app+'/api/trpc/agentSlice.recover',{data:{executionId:killedRequest}})).ok()).toBe(true);
  expect((await (await fetch(url+'/__slice_calls')).json()).length).toBe(13);
  expect((await sql.query('select state,pre_deduct_id from agent_slice_calls where execution_id=$1',[killedRequest])).rows).toEqual(financialBeforeKill);
  expect((await sql.query("select count(*)::int n from token_stats where metadata->>'executionId'=$1",[killedRequest])).rows[0].n).toBe(0);
  console.log('SLICE real SIGKILL/restart: original unknown request retained, provider count unchanged, no extra reservation/settlement PASS');
 } finally {await browserSession.context.close();}
 // Equal timestamps still paginate by immutable request identity, without loss.
 const tieIds=[randomUUID(),randomUUID(),randomUUID()].sort().reverse();
 for(const tieId of tieIds){
  await sql.query("insert into artifact_requests select (jsonb_populate_record(null::artifact_requests,to_jsonb(q)||jsonb_build_object('request_id',$2::text))).* from artifact_requests q where request_id=$1",[joinedRequest,tieId]);
  await sql.query("insert into agent_slice_executions select (jsonb_populate_record(null::agent_slice_executions,to_jsonb(e)||jsonb_build_object('request_id',$2::text,'created_at','2030-01-01T00:00:00Z'))).* from agent_slice_executions e where request_id=$1",[joinedRequest,tieId]);
 }
 const tiePage=await readSliceConversation(user,db,{conversationId:conversation,limit:2});expect(tiePage.items.map(x=>x.executionId)).toEqual(tieIds.slice(0,2));
 const tieNext=await readSliceConversation(user,db,{conversationId:conversation,limit:2,before:tiePage.nextCursor!});expect(tieNext.items[0].executionId).toBe(tieIds[2]);
 // Known provider usage survives a deterministic oversized summary rejection.
 const oversizedExecution=randomUUID();await begin(t,t,oversizedExecution,'Synthetic bounded summary',100000);
 let oversizedCalls=0;
 const oversizedTransport=async(_url:unknown,init?:RequestInit)=>{
  oversizedCalls++;const req=JSON.parse(String(init?.body));
  const message=oversizedCalls===1?{role:'assistant',content:null,tool_calls:[{id:'oversize-read',type:'function',function:{name:'read_selected_artifact',arguments:'{}'}}]}:{role:'assistant',content:oversizedCalls===2?'A readable reply':'Long synthetic explanation. '.repeat(60)};
  return new Response(JSON.stringify({id:'oversized-'+oversizedCalls,object:'chat.completion',created:1,model:req.model,choices:[{index:0,finish_reason:oversizedCalls===1?'tool_calls':'stop',message}],usage:{prompt_tokens:10,completion_tokens:400,total_tokens:410}}),{headers:{'content-type':'application/json'}});
 };
 const oversizedExecutor=sliceExecutor(user,db,oversizedTransport);
 expect((await oversizedExecutor.execute({executionId:oversizedExecution,phase:'reply'})).state).toBe('saved');
 expect(await oversizedExecutor.execute({executionId:oversizedExecution,phase:'summary'})).toEqual({state:'unavailable',reason:'result_unavailable'});
 expect(await oversizedExecutor.execute({executionId:oversizedExecution,phase:'summary'})).toEqual({state:'unavailable',reason:'result_unavailable'});
 expect((await recoverSlice(user,db,{executionId:oversizedExecution})).calls.map(c=>c.state)).toEqual(['settled','settled','settled']);expect(oversizedCalls).toBe(3);
 expect((await sql.query("select count(*)::int n from token_stats where metadata->>'executionId'=$1",[oversizedExecution])).rows[0].n).toBe(3);
 expect((await sql.query("select count(*)::int n from artifact_requests where payload->>'sliceExecution'=$1 and payload->>'slicePhase'='summary'",[oversizedExecution])).rows[0].n).toBe(0);
 // Recreate the service after losing prepare acknowledgement: no provider dispatch.
 const {sliceCallId}=await import('../agentSlice/accounting');
 const abandoned=randomUUID();await begin(b,b,abandoned,'Synthetic undispatched request');
 const abandonedArgs={p_actor_id:actor,p_execution_id:abandoned,p_call_id:sliceCallId(abandoned,1)};
 const abandonedBalance=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 const abandonedPrepared=await db.rpc('agent_slice_call',{...abandonedArgs,p_action:'prepare',p_payload:{sequence:1,quote:{modelId:sliceModel,providerModel:'qwen/qwen3.8-flash',reservedCredits:20}}});
 expect(abandonedPrepared.error).toBeNull();
 expect((await recoverSlice(user,db,{executionId:abandoned})).calls[0].state).toBe('prepared');
 await sql.query("update agent_slice_calls set created_at=clock_timestamp()-interval '3 minutes' where id=$1",[abandonedArgs.p_call_id]);
 // A changed saved step invalidates the frozen request, but not financial recovery.
 const abandonedStep=(await service.read(b,b)).steps['step-0'];
 await service.execute({action:'save',projectId:b,roundId:b,stepId:'step-0',requestId:randomUUID(),expectedVersion:abandonedStep.version,body:'Changed after preparation',evidenceIds:[]});
 expect((await recoverSlice(user,db,{executionId:abandoned})).calls[0].state).toBe('refunded');
 expect((await recoverSlice(user,db,{executionId:abandoned})).calls[0].state).toBe('refunded');
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(abandonedBalance);
 const lateAbandoned=await db.rpc('agent_slice_call',{...abandonedArgs,p_action:'dispatch',p_payload:{token:abandonedPrepared.data.token}});
 expect(lateAbandoned.error!==null||lateAbandoned.data?.dispatch===false).toBe(true);
 expect((await sql.query('select state from agent_slice_calls where id=$1',[abandonedArgs.p_call_id])).rows[0].state).toBe('refunded');
 await service.execute({action:'save',projectId:b,roundId:b,stepId:'step-0',requestId:randomUUID(),expectedVersion:(await service.read(b,b)).steps['step-0'].version,body:'',evidenceIds:[]});
 // Concurrent recovery/dispatch share the execution lock. A dispatched winner
 // must never be refunded; a recovered winner must reject the stale token.
 const racing=randomUUID();await begin(b,b,racing,'Synthetic dispatch race');
 const raceArgs={p_actor_id:actor,p_execution_id:racing,p_call_id:sliceCallId(racing,1)};
 const racePrepared=await db.rpc('agent_slice_call',{...raceArgs,p_action:'prepare',p_payload:{sequence:1,quote:{modelId:sliceModel,providerModel:'qwen/qwen3.8-flash',reservedCredits:20}}});expect(racePrepared.error).toBeNull();
 await sql.query("update agent_slice_calls set created_at=clock_timestamp()-interval '3 minutes' where id=$1",[raceArgs.p_call_id]);
 const otherActor=(await newUser()).id;
 const deniedRecovery=await db.rpc('agent_slice_call',{...raceArgs,p_actor_id:otherActor,p_action:'recover_prepared'});expect(deniedRecovery.error).not.toBeNull();
 const [,raceDispatch]=await Promise.all([recoverSlice(user,db,{executionId:racing}),db.rpc('agent_slice_call',{...raceArgs,p_action:'dispatch',p_payload:{token:racePrepared.data.token}})]);
 expect(raceDispatch.error).toBeNull();
 const raceState=(await recoverSlice(user,db,{executionId:racing})).calls[0].state;
 expect(raceState).toBe(raceDispatch.data.dispatch?'dispatched':'refunded');
 const beforeManual=(await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits;
 const callId=randomUUID();
 const call=async(action:string,payload:Record<string,unknown>={})=>{
  const result=await db.rpc('agent_slice_call',{p_actor_id:actor,p_execution_id:titleRequest,p_call_id:callId,p_action:action,p_payload:payload});
  if(result.error)throw result.error;return result.data;
 };
 const callQuote={modelId:sliceModel,providerModel:'qwen/qwen3.8-flash',reservedCredits:20};
 const claim=await call('prepare',{sequence:1,quote:callQuote});
 expect(claim.state).toBe('prepared');
 const reclaimed=await call('prepare',{sequence:1,quote:callQuote});expect(reclaimed.state).toBe('prepared');
 expect(await call('dispatch',{token:claim.token})).toEqual({dispatch:false});
 claim.token=reclaimed.token;
 await expect(call('prepare',{sequence:1,quote:{...callQuote,reservedCredits:21}})).rejects.toBeDefined();
 expect(await call('dispatch',{token:claim.token})).toEqual({dispatch:true});
 expect(await call('dispatch',{token:claim.token})).toEqual({dispatch:false});
 await call('unknown',{token:claim.token});
 await expect(call('settle')).rejects.toBeDefined();
 await expect(call('refund',{token:claim.token})).rejects.toBeDefined();
 const adoptInput={action:'saveCandidate' as const,projectId:t,roundId:t,stepId:'step-0',candidateId:savedSummary.candidateId,expectedVersion:(await service.read(t,t)).steps['step-0'].version,requestId:randomUUID(),body:savedSummary.body};
 await service.execute(adoptInput);await service.execute(adoptInput);
 expect((await service.read(t,t)).steps['step-0'].body).toBe(summaryReply.body);
 await expect(service.execute({...adoptInput,requestId:randomUUID(),expectedVersion:(await service.read(t,t)).steps['step-0'].version})).rejects.toThrow();
 expect(await results.read(summaryScope)).toMatchObject({state:'saved',adoptable:false});
 const tv1=await publish(t,t,'TITLE1');
 // Creation succeeds internally, then invalid title -> title binding must roll back the whole transaction.
 const {continueSliceWork}=await import('../agentSlice/continueWork');const failedWork=randomUUID();
 await expect(continueSliceWork(user,db,{requestId:failedWork,projectId:failedWork,sourceVersionId:tv1.id!,pairId:'slice-pair',purpose:'title',title:'Invalid title loop'})).rejects.toThrow();
 for(const table of ['artifact_projects','artifact_rounds'])expect((await sql.query(`select count(*)::int n from ${table} where id=$1`,[failedWork])).rows[0].n).toBe(0);
 expect((await sql.query('select count(*)::int n from artifact_work_references where creation_request_id=$1',[failedWork])).rows[0].n).toBe(0);

 const a2=randomUUID();
 await reuse.create({projectId:a,roundId:a2,requestId:a2,fromRoundId:a,sourceVersionId:position.id!,configId:'slice-p-script',title:'脚本 A'});
 await links.link({projectId:a,roundId:a2,sourceVersionId:tv1.id!,pairId:'slice-pair',requestId:randomUUID()});
 const revisionRequest=randomUUID();await begin(a,a2,revisionRequest,'采用标题修改 A');
 const switchedHistory=await readSliceConversation(user,db,{conversationId:conversation});expect(switchedHistory.items.some(x=>x.projectId===a)).toBe(true);expect(switchedHistory.items.some(x=>x.projectId===t)).toBe(true);
 const switched=await loadSliceContext(user,db,revisionRequest);expect(switched.loaded.forModel()).toContain('ALPHA');expect(switched.loaded.forModel()).not.toContain('BETA');
 const frozen=(await sql.query('SELECT conversation_id,project_id,round_id,revision_id FROM agent_slice_executions WHERE request_id=ANY($1::uuid[]) ORDER BY created_at',[[titleRequest,revisionRequest]])).rows;
 expect(frozen).toEqual([
  {conversation_id:conversation,project_id:t,round_id:t,revision_id:title.pack.revisionId},
  {conversation_id:conversation,project_id:a,round_id:a2,revision_id:script.pack.revisionId},
 ]);
 const av2=await publish(a,a2,'A2');expect(av2.available).toBe(true);expect(av2.version).toBe(2);
 expect(await reader()).toContain('A1');expect(await reader()).not.toContain('A2');
 expect((await service.read(b,b)).steps['step-0'].body).toBe('');
 const otherUser=await newUser(),other=await authenticated(otherUser);
 await expect(sliceEntry(other,db).sources()).resolves.toEqual([]);
 const stolenWork=randomUUID();await expect(continueSliceWork(other,db,{requestId:stolenWork,projectId:stolenWork,sourceVersionId:position.id!,pairId:'slice-pair',purpose:'script',title:'Foreign'})).rejects.toThrow('SLICE_DENIED');
 expect((await user.rpc('agent_slice_sources',{p_actor_id:actor})).error).not.toBeNull();
 await expect(sliceLinks(other,db).read({projectId:t,roundId:t})).rejects.toThrow('ARTIFACT_DENIED');
 await expect(sliceResults(other,db).read(replyScope)).rejects.toThrow('SLICE_DENIED');
 await expect(readSliceConversation(other,db,historyInput)).rejects.toThrow('SLICE_DENIED');
 await expect(loadSliceContext(other,db,revisionRequest)).rejects.toThrow('SLICE_DENIED');
 expect((await user.rpc('agent_slice_link_read',{p_actor_id:actor,p_project_id:t,p_round_id:t})).error).not.toBeNull();
 await service.execute({action:'restrictEvidence',projectId:a,roundId:a,requestId:randomUUID(),evidenceId:extra.id,deleted:true,expiresAt:null});
 await expect(reader()).rejects.toThrow();
 const restrictedHistory=await readSliceConversation(user,db,{conversationId:conversation});
 expect(restrictedHistory.items.find(x=>x.executionId===joinedRequest)).toMatchObject({input:null,reply:{state:'restricted'},summary:{state:'restricted'}});
 expect(JSON.stringify(restrictedHistory)).not.toContain('Joined title');
 expect(await results.read(replyScope)).toEqual({state:'restricted'});expect(await results.read(summaryScope)).toEqual({state:'restricted'});
 expect(await results.save(replyScope,sdkReply.body,syntheticPrivate)).toEqual({state:'restricted'});
 expect((await recoverSlice(user,db,{executionId:joinedRequest})).calls.map(c=>c.state)).toEqual(['settled','settled','settled']);expect(joinedCalls).toBe(3);
 expect((await service.report(t,t)).available).toBe(false);expect((await service.report(a,a2)).available).toBe(false);
 expect((await service.read(t,t)).steps['step-0'].body).toBeNull();
 expect((await service.read(b,b)).steps['step-0'].body).toBe('');
 // Rollback closes new admission while the already dispatched original call can finish.
 await sql.query("UPDATE agent_slice_pairs SET enabled=false WHERE id='slice-pair'");
 const rollbackRequest=randomUUID();
 await expect(begin(b,b,rollbackRequest,'Must not start while disabled')).rejects.toBeDefined();
 expect((await sql.query('SELECT count(*)::int n FROM agent_slice_executions WHERE request_id=$1',[rollbackRequest])).rows[0].n).toBe(0);
 expect((await sql.query('SELECT count(*)::int n FROM agent_slice_calls WHERE execution_id=$1',[rollbackRequest])).rows[0].n).toBe(0);
 // Source loss prevents fresh use, but does not erase a trusted monetary outcome.
 const financial={providerId:'synthetic-call',finishReason:'length',inputTokens:100,outputTokens:20,cacheReadTokens:0,cacheCreationTokens:0,credits:7,costUsd:0.001,outcome:'truncated'};
 await expect(call('evidence',{token:claim.token,evidence:{...financial,inputTokens:null}})).rejects.toBeDefined();
 await call('evidence',{token:claim.token,evidence:financial});
 expect((await call('settle')).state).toBe('settled');
 expect((await call('settle')).state).toBe('settled');
 await sql.query("UPDATE agent_slice_pairs SET enabled=true WHERE id='slice-pair'");
 expect((await sql.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(beforeManual-7);
 expect((await sql.query("SELECT count(*)::int n FROM credit_transactions WHERE idempotency_key=$1",['agent_slice_call:'+callId])).rows[0].n).toBe(1);
 expect((await sql.query("SELECT count(*)::int n FROM token_stats WHERE metadata->>'callId'=$1",[callId])).rows[0].n).toBe(1);
 expect((await sql.query("SELECT count(*)::int n FROM billing_history WHERE operation_type='pre_deduct' AND id=(SELECT pre_deduct_id FROM agent_slice_calls WHERE id=$1)",[callId])).rows[0].n).toBe(1);
 await expect(call('prepare',{sequence:1,quote:callQuote})).rejects.toBeDefined();
 expect((await sql.query('SELECT count(*)::int n FROM artifact_generations WHERE project_id=ANY($1::uuid[])',[[a,b,t]])).rows[0].n).toBe(0);
 // One revoked target revision must not make unrelated works or history unavailable.
 await sql.query('insert into skill_revision_revocations(revision_id,revoked_by) values($1,$2)',[title.pack.revisionId,actor]);
 const afterRevisionRevoked=await readSliceConversation(user,db,{conversationId:conversation});
 expect(afterRevisionRevoked.items.some(x=>x.projectId===b&&x.reply.state!=='restricted')).toBe(true);
 expect(afterRevisionRevoked.items.filter(x=>x.projectId===t).every(x=>x.reply.state==='restricted'&&x.input===null)).toBe(true);
 const referenceChoices=await db.rpc('artifact_reference_choices',{p_actor_id:actor,p_source_version_id:position.id});expect(referenceChoices.error).toBeNull();expect(referenceChoices.data.map((c:{id:string})=>c.id)).toEqual(['slice-p-script']);
 const remainingTargets=await entry.targets();expect(remainingTargets.some(x=>x.projectId===b)).toBe(true);expect(remainingTargets.some(x=>x.projectId===t)).toBe(false);
 expect((await entry.sources()).some(x=>x.sourceVersionId===position.id)).toBe(true);
 await sql.query('insert into skill_revision_revocations(revision_id,revoked_by) values($1,$2)',[script.pack.revisionId,actor]);
 expect(await entry.sources()).toEqual([]);
 // Removing account ownership invalidates this entry even if the source has no evidence IDs.
 await sql.query('delete from artifact_accounts where actor_id=$1 and module_id=$2 and skill_id=$3',[actor,src.moduleId,src.pack.id]);
 expect(await entry.sources()).toEqual([]);
 const revokedCreate=randomUUID();await expect(continueSliceWork(user,db,{requestId:revokedCreate,projectId:revokedCreate,sourceVersionId:position.id!,pairId:'slice-pair',purpose:'script',title:'Revoked'})).rejects.toThrow();
 expect((await sql.query('select count(*)::int n from artifact_projects where id=$1',[revokedCreate])).rows[0].n).toBe(0);

},240000);

it.skipIf(!process.env.V3_REUSE_TEST || process.env.V3_WORKBENCH_PHASE === 'restore')('REUSE: independent works, stable reference, revisions and revoked-source denial through real services', async()=>{
  const {artifactReuse}=await import('../artifacts/reuse');
  const user=await authenticated(), service=workbenchService(user,db), reuse=artifactReuse(user,db);
  const src=await fixture({id:'reuse-positioning',label:'测试定位',methodText:'Synthetic positioning only.',workflow:makeWorkflow(6,true)});
  const modelFixture=await generationFixture(3,'Synthetic script only.');
  const target=modelFixture.f;
  const sourceProject=randomUUID(),sourceRound=randomUUID();
  await service.start({projectId:sourceProject,roundId:sourceRound,requestId:randomUUID(),registration:src.registration,account:'synthetic:local-account'});
  await service.execute({action:'userEvidence',projectId:sourceProject,roundId:sourceRound,requestId:randomUUID(),body:'SOURCE_EVIDENCE',observedAt:null,supersedes:null});
  const sourceEvidenceId=(await service.read(sourceProject,sourceRound)).evidence[0].id;
  async function publish(projectId:string,roundId:string, marker:string) {
    let s=await service.read(projectId,roundId);
    for(const step of s.workflow.steps){
      await service.execute({action:'save',projectId,roundId,requestId:randomUUID(),stepId:step.id,body:marker+' '+step.title,evidenceIds:projectId===sourceProject?[sourceEvidenceId]:[],expectedVersion:s.steps[step.id].version});
      s=await service.read(projectId,roundId);
      await service.execute({action:'confirm',projectId,roundId,requestId:randomUUID(),stepId:step.id,expectedVersion:s.steps[step.id].version,expectedReviewVersion:s.steps[step.id].reviewVersion});
      s=await service.read(projectId,roundId);
    }
    await service.execute({action:'publish',projectId,roundId,requestId:randomUUID(),expectedSteps:Object.fromEntries(Object.entries(s.steps).map(([k,v])=>[k,{version:v.version,reviewVersion:v.reviewVersion}]))});
    return service.report(projectId,roundId);
  }
  const report=await publish(sourceProject,sourceRound,'POSITION_V1');
  await sql.query('insert into artifact_reference_configs values($1,$2,$3,$4,$5,true)',['position-script',src.registration,target.registration,JSON.stringify(['step-2']),20000]);
  expect(await reuse.choices(report.id!)).toEqual([{id:'position-script',label:target.label}]);
  expect((await user.rpc('artifact_create_work',{p_actor_id:actor,p_project_id:randomUUID(),p_round_id:randomUUID(),p_request_id:randomUUID(),p_payload:{}})).error?.code).toBe('42501');
  expect((await user.rpc('artifact_work_source',{p_actor_id:actor,p_project_id:sourceProject,p_round_id:sourceRound})).error?.code).toBe('42501');
  const a=randomUUID(),b=randomUUID();
  const input={projectId:a,roundId:a,requestId:a,sourceVersionId:report.id!,configId:'position-script',title:'独立脚本 A'};
  expect(await Promise.all([reuse.create(input),reuse.create(input)])).toEqual([{projectId:a,roundId:a},{projectId:a,roundId:a}]);
  expect(await reuse.create(input)).toEqual({projectId:a,roundId:a});
  await expect(reuse.create({...input,title:'Conflicting replay'})).rejects.toThrow();
  await reuse.create({...input,projectId:b,roundId:b,requestId:b,title:'独立脚本 B'});
  expect((await service.read(a,a)).state).toBe('draft');expect((await service.read(b,b)).state).toBe('draft');
  await service.execute({action:'userEvidence',projectId:a,roundId:a,requestId:randomUUID(),body:'Additional limited reference',observedAt:null,supersedes:null});
  const extra=(await service.read(a,a)).evidence.find(e=>e.payload && typeof e.payload==='object' && !Array.isArray(e.payload) && 'text' in e.payload)!;
  await service.execute({action:'save',projectId:a,roundId:a,requestId:randomUUID(),stepId:'step-0',body:'SCRIPT_A',evidenceIds:[extra.id],expectedVersion:0});
  const inheritedSave={action:'save' as const,projectId:a,roundId:a,requestId:randomUUID(),stepId:'step-1',body:'Inherited dependency',evidenceIds:[],expectedVersion:0};
  const saved=await service.execute(inheritedSave);
  expect((await service.read(a,a)).steps['step-1'].provenanceIds).toContain(extra.id);
  expect(await service.execute(inheritedSave)).toEqual(saved);
  await expect(service.execute({...inheritedSave,body:'Different input'})).rejects.toThrow();
  await publish(a,a,'SCRIPT_A');
  await service.execute({action:'restrictEvidence',projectId:a,roundId:a,requestId:randomUUID(),evidenceId:extra.id,deleted:true,expiresAt:null});
  const a2=randomUUID();await reuse.create({...input,roundId:a2,requestId:a2,fromRoundId:a});
  expect((await service.read(b,b)).steps['step-0'].body).toBe('');
  expect((await service.read(a,a2)).steps['step-0'].body).toBeNull();
  const sourceV2=randomUUID();await service.start({projectId:sourceProject,roundId:sourceV2,requestId:randomUUID(),fromRoundId:sourceRound});
  const [reportV2,pinnedDuringPublish]=await Promise.all([publish(sourceProject,sourceV2,'POSITION_V2'),reuse.source({projectId:b,roundId:b})]);
  expect(pinnedDuringPublish?.sourceVersionId).toBe(report.id);
  expect((await reuse.source({projectId:b,roundId:b}))?.sourceVersionId).toBe(report.id);
  await service.execute({action:'abandon',projectId:a,roundId:a2,requestId:randomUUID()});
  const a3=randomUUID();await reuse.create({...input,roundId:a3,requestId:a3,fromRoundId:a,sourceVersionId:reportV2.id!});
  expect((await service.read(a,a3)).steps['step-0'].body).toBe('');
  expect((await service.read(a,a3)).confirmations).toHaveLength(0);
  await expect(service.start({projectId:randomUUID(),roundId:randomUUID(),requestId:randomUUID(),registration:src.registration,account:'synthetic:local-account'})).rejects.toThrow();
  const sourceEvidence=(await service.read(sourceProject,sourceRound)).evidence[0]?.id;
  expect(sourceEvidence).toBeTruthy();
  await expect(service.execute({action:'save',projectId:b,roundId:b,requestId:randomUUID(),stepId:'step-0',body:'Forged',evidenceIds:[sourceEvidence!],expectedVersion:0})).rejects.toThrow();

  expect((await reuse.source({projectId:a,roundId:a2}))?.sourceVersionId).toBe(report.id);
  expect((await service.projects()).filter(p=>p.workKind==='script')).toHaveLength(2);
  const other=await newUser();await expect(artifactReuse(await authenticated(other),db).source({projectId:a,roundId:a})).rejects.toThrow('ARTIFACT_DENIED');
  // Existing project-local save cannot wash out the mandatory reference.
  const snap=await service.read(b,b);
  await service.execute({action:'save',projectId:b,roundId:b,requestId:randomUUID(),stepId:'step-0',body:'SCRIPT_B',evidenceIds:[],expectedVersion:snap.steps['step-0'].version});
  expect((await service.read(b,b)).steps['step-0'].evidenceIds).toHaveLength(1);
  // Browser uses the actual report, HTTP creation, chat reply/summary and saved result.
  const {page,context}=await pageFor();
  let browserWork:{project_id:string;round_id:string}|undefined, browserConversation='';
  try {
    await page.getByRole('button',{name:/测试定位.*synthetic:local-account/}).click();await quiet(page);
    await page.getByRole('button',{name:'查看正式报告',exact:true}).click();await quiet(page);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.setViewportSize({width:1280,height:900});
    await page.getByLabel('新作品名称').fill('浏览器独立脚本');
    await page.getByRole('button',{name:'基于此定位创作脚本',exact:true}).click();
    await page.waitForURL(u=>u.pathname==='/chat'&&!!u.searchParams.get('conversation'));
    const conversationId=new URL(page.url()).searchParams.get('conversation')!;browserConversation=conversationId;
    await page.getByLabel('给当前步骤发消息').fill('Write a short fictional script.');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(async()=>page.getByLabel('给当前步骤发消息').inputValue(),{timeout:60000}).toBe('');
    const binding=(await sql.query('select project_id,round_id from artifact_chats where conversation_id=$1',[conversationId])).rows[0];browserWork=binding;
    await expect.poll(async()=>(await service.read(binding.project_id,binding.round_id)).steps['step-0'].body,{timeout:60000}).toBe('Synthetic local HTTP candidate');
    const count=async()=>(await sql.query('select count(*)::int n from artifact_generations where project_id=$1',[binding.project_id])).rows[0].n;
    expect(await count()).toBe(2);
    await page.reload();await page.getByLabel('给当前步骤发消息').waitFor();expect(await count()).toBe(2);
    const secondTab=await context.newPage();await secondTab.goto(page.url());await secondTab.getByLabel('给当前步骤发消息').waitFor();expect(await count()).toBe(2);await secondTab.close();
    await page.goto(app+'/workbench');await page.getByRole('button',{name:/浏览器独立脚本/}).click();await quiet(page);
    await fillConfirm(page,target,'BROWSER_SAVED '+('长报告内容。'.repeat(120)));
    await page.getByRole('button',{name:'发布正式版',exact:true}).click();await quiet(page);
    expect(await page.getByLabel('升级方法').count()).toBe(0);
    await page.getByRole('button',{name:'查看正式报告',exact:true}).click();await quiet(page);
    await page.screenshot({path:output+'/reuse-report.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:output+'/reuse-report-mobile.png'});
    const overflowing=await page.evaluate(()=>Array.from(document.querySelectorAll('main *')).filter(e=>e.getBoundingClientRect().right>window.innerWidth+1).map(e=>({tag:e.tagName,class:e.className,width:e.getBoundingClientRect().width})).slice(0,12));
    expect(overflowing).toEqual([]);
    await page.setViewportSize({width:1280,height:900});
    expect((await service.report(binding.project_id,binding.round_id)).available).toBe(true);
    expect(await count()).toBe(2);
  } finally {await context.close();}
  // Mapping invalidation is content authorization, not a new Skill execution license.
  await sql.query("update artifact_reference_configs set enabled=false where id='position-script'");
  await expect(reuse.source({projectId:b,roundId:b})).rejects.toThrow();
  expect((await service.read(b,b)).steps['step-0'].body).toBeNull();
  await sql.query("update artifact_reference_configs set enabled=true where id='position-script'");
  const revokeSource=()=>sql.query('delete from artifact_accounts where actor_id=$1 and module_id=$2',[actor,src.moduleId]);
  const restoreSource=()=>sql.query('insert into artifact_accounts values($1,$2,$3,$4)',[actor,src.moduleId,src.pack.id,'synthetic:local-account']);
  for(const window of ['before','dispatched','unknown','settled','extra'] as const){
    const id=randomUUID();await reuse.create({...input,projectId:id,roundId:id,requestId:id,title:'Window '+window});
    let extraId='';
    if(window==='extra'){
      await service.execute({action:'userEvidence',projectId:id,roundId:id,requestId:randomUUID(),body:'Extra dependency',observedAt:null,supersedes:null});
      extraId=(await service.read(id,id)).evidence.find(e=>e.payload&&typeof e.payload==='object'&&!Array.isArray(e.payload)&&'text' in e.payload)!.id;
      await service.execute({action:'save',projectId:id,roundId:id,requestId:randomUUID(),stepId:'step-0',body:'Extra basis',evidenceIds:[extraId],expectedVersion:0});
    }
    let count=0;
    const ai=modelFixture.workbenchGeneration(user,db,async()=>{
      count++;
      if(window==='extra')await service.execute({action:'restrictEvidence',projectId:id,roundId:id,requestId:randomUUID(),evidenceId:extraId,deleted:true,expiresAt:null});
      if(window==='dispatched'||window==='unknown')await revokeSource();
      if(window==='unknown')throw new Error('Synthetic unknown outcome');
      return {body:'Restricted window result',inputTokens:800,outputTokens:30};
    });
    const snap=await service.read(id,id),base={projectId:id,roundId:id,stepId:'step-0',instruction:'Fictional script',expectedSteps:Object.fromEntries(Object.entries(snap.steps).map(([k,v])=>[k,{version:v.version,reviewVersion:v.reviewVersion}]))};
    const quote=await ai.quote(base),req={...base,requestId:randomUUID(),quoteHash:quote.quoteHash,budgetCredits:quote.reservedCredits};
    if(window==='before'){
      await revokeSource();await expect(ai.generate(req)).rejects.toThrow();expect(count).toBe(0);
      expect((await sql.query('select id from artifact_generations where project_id=$1',[id])).rows).toHaveLength(0);
    }else{
      const result=await ai.generate(req);expect(result.state).toBe(window==='unknown'?'unknown':'succeeded');
      if(window==='settled')await revokeSource();
      if(window==='unknown'){
        await expect(ai.recover({projectId:id,roundId:id,requestId:req.requestId})).rejects.toThrow('GENERATION_CONFLICT');
        expect((await ai.generate(req)).state).toBe('unknown');
        expect((await ai.list({projectId:id,roundId:id}))[0].chargedCredits).toBeNull();
      }else expect((await ai.recover({projectId:id,roundId:id,requestId:req.requestId})).state).toBe(result.state);
      expect(count).toBe(1);
      expect((await service.read(id,id)).candidates.every(c=>c.body===null)).toBe(true);
      const n=(await sql.query('select count(*)::int n from token_stats where artifact_generation_id=(select id from artifact_generations where request_id=$1)',[req.requestId])).rows[0].n;
      expect(n).toBe(window==='unknown'?0:1);
    }
    if(window!=='extra')await restoreSource();
    else {
      expect((await reuse.source({projectId:id,roundId:id}))?.sourceVersionId).toBe(report.id);
      expect((await sql.query('select body from artifact_candidates where round_id=$1',[id])).rows[0].body).toBe('[来源已不可用]');
    }
  }
  // Real generation service + counting provider; receipt before revocation.
  const gs=await service.read(b,b), base={projectId:b,roundId:b,stepId:'step-0',instruction:'Write the script.',expectedSteps:Object.fromEntries(Object.entries(gs.steps).map(([k,v])=>[k,{version:v.version,reviewVersion:v.reviewVersion}]))};
  const quote=await modelFixture.ai.quote(base), requestId=randomUUID();
  await sql.query("create function local_reuse_fail_settle() returns trigger language plpgsql as $$ begin if NEW.operation_type='settle' then raise exception 'test settle failure'; end if; return NEW; end $$; create trigger local_reuse_fail_settle before insert on billing_history for each row execute function local_reuse_fail_settle()");
  try { await modelFixture.ai.generate({...base,requestId,quoteHash:quote.quoteHash,budgetCredits:quote.reservedCredits}); }
  finally {await sql.query('drop trigger local_reuse_fail_settle on billing_history; drop function local_reuse_fail_settle()');}
  expect(modelFixture.calls()).toBe(1);
  expect(modelFixture.captured[0].split('POSITION_V1').length-1).toBe(1);
  expect((await modelFixture.ai.list({projectId:b,roundId:b}))[0].state).toBe('responded');
  await sql.query('delete from artifact_accounts where actor_id=$1 and module_id=$2',[actor,src.moduleId]);
  const settled=await modelFixture.ai.recover({projectId:b,roundId:b,requestId});
  expect(settled.state).toBe('succeeded');
  expect(await modelFixture.ai.recover({projectId:b,roundId:b,requestId})).toEqual(settled);
  expect(modelFixture.calls()).toBe(1);
  const rawCandidate=(await sql.query('select body from artifact_candidates where id=$1',[settled.candidateId])).rows[0];
  expect(rawCandidate.body).toBe('[来源已不可用]');
  expect((await sql.query("select count(*)::int n from token_stats where artifact_generation_id=(select id from artifact_generations where request_id=$1)",[requestId])).rows[0].n).toBe(1);

  expect((await service.read(a,a)).steps['step-0'].body).toBeNull();
  expect((await service.read(b,b)).steps['step-0'].body).toBeNull();
  expect((await service.report(a,a)).available).toBe(false);
  await expect(service.export(a,a)).rejects.toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
  const {skillChatService}=await import('../artifacts/chat');
  const hidden=await skillChatService(user,db).read({conversationId:browserConversation});
  expect(hidden.turns.every(t=>t.body===null&&t.answer===null&&!t.available)).toBe(true);
  expect((await service.report(browserWork!.project_id,browserWork!.round_id)).available).toBe(false);
  await expect(reuse.source({projectId:a,roundId:a})).rejects.toThrow();
  writeFileSync(output+'/reuse-restore.json',JSON.stringify({a,b,a3,requestId,sourceProject,sourceModule:src.moduleId,sourceSkill:src.pack.id}));
},240000);

it.skipIf(!process.env.V3_REUSE_TEST || process.env.V3_WORKBENCH_PHASE !== 'restore')('REUSE: restart preserves work identity and restricted content without generation',async()=>{
  const saved=JSON.parse(readFileSync(output+'/reuse-restore.json','utf8'));
  const service=workbenchService(await authenticated(),db);
  expect((await service.projects()).filter(p=>[saved.a,saved.b].includes(p.projectId))).toHaveLength(2);
  expect((await service.read(saved.a,saved.a3)).state).toBe('draft');
  expect((await service.read(saved.b,saved.b)).steps['step-0'].body).toBeNull();
  expect((await service.report(saved.a,saved.a)).available).toBe(false);
  expect((await sql.query('select count(*)::int n from artifact_generations where request_id=$1',[saved.requestId])).rows[0].n).toBe(1);
});
