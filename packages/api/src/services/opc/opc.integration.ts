/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { makePackage, makeWorkflow } from "../__tests__/fixtures/artifacts";
import { publishSkillPackage } from "../skills/publication";
import { opcService } from "./service";
import { workbenchService } from "../artifacts/workbench";
const connectionString = process.env.V3_LOCAL_DB!;
if (
  !connectionString?.startsWith("postgres://postgres@127.0.0.1:") ||
  !connectionString.endsWith("/v3_disposable")
)
  throw new Error("isolated runner required");
const sql = new pg.Client({ connectionString });
const admin = createClient(
  process.env.V3_LOCAL_REST!,
  process.env.V3_LOCAL_SERVICE_JWT!,
  { auth: { persistSession: false } },
);
beforeAll(() => sql.connect());
afterAll(() => sql.end());
async function fixture(n = 6) {
  const password = "Local-" + randomUUID() + "!",
    email = randomUUID() + "@example.test";
  const made = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (made.error) throw made.error;
  const actor = made.data.user.id;
  await sql.query(
    "insert into profiles(id,email,role,credits) values($1,$2,'user',100)",
    [actor, email],
  );
  await sql.query(
    "insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",
    [actor, randomUUID()],
  );
  const user = createClient(
    process.env.V3_LOCAL_REST!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
  const login = await user.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const owner = randomUUID();
  await sql.query("insert into profiles(id,role) values($1,'admin')", [owner]);
  const pack = makePackage(),
    moduleId = randomUUID(),
    registration = "opc-" + randomUUID(),
    flow = makeWorkflow(n, n === 6);
  flow.steps.forEach((step, index) => {
    step.information = [
      {
        id: "goal",
        title: "已知目标 " + index,
        required: true,
        profileKey: "goal_" + index,
      },
    ];
  });
  await sql.query(
    "insert into skills(id,skill_key,created_by) values($1,$2,$3)",
    [pack.id, registration, owner],
  );
  await sql.query(
    "insert into modules(id,title,skill_id,active) values($1,$2,$3,true)",
    [moduleId, "隔离定位 " + n, pack.id],
  );
  await publishSkillPackage(admin, owner, pack);
  await sql.query(
    "insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
    [registration, moduleId, pack.id, pack.revisionId, flow, "隔离定位 " + n],
  );
  return {
    actor,
    owner,
    user,
    pack,
    moduleId,
    registration,
    flow,
    email,
    password,
    service: opcService(user, admin),
    artifacts: workbenchService(user, admin),
  };
}
async function completed(n = 6) {
  const f = await fixture(n);
  const requestId = randomUUID();
  const d = await f.service.start({
    requestId,
    registration: f.registration,
    mode: "manual",
  });
  for (const step of f.flow.steps) {
    await f.artifacts.execute({
      action: "save",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      stepId: step.id,
      body: "User confirmed " + step.title,
      evidenceIds: [],
      expectedVersion: 0,
    });
    const snap = await f.artifacts.read(d.projectId, d.roundId);
    const state = snap.steps[step.id];
    await f.service.information({
      draftId: d.draftId,
      stepId: step.id,
      requestId: randomUUID(),
      expectedVersion: state.version,
      values: {
        goal: {
          status: "confirmed",
          nature: "decision",
          value: "A concrete user decision",
        },
      },
    });
    const updated = (await f.artifacts.read(d.projectId, d.roundId)).steps[
      step.id
    ];
    await f.artifacts.execute({
      action: "confirm",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      stepId: step.id,
      expectedVersion: updated.version,
      expectedReviewVersion: updated.reviewVersion,
    });
  }
  const snap = await f.artifacts.read(d.projectId, d.roundId);
  await f.artifacts.execute({
    action: "publish",
    projectId: d.projectId,
    roundId: d.roundId,
    requestId: randomUUID(),
    expectedSteps: Object.fromEntries(
      Object.entries(snap.steps).map(([k, v]) => [
        k,
        { version: v.version, reviewVersion: v.reviewVersion },
      ]),
    ),
  });
  const read = await f.service.read(d.draftId);
  return { ...f, d, sourceVersionId: read.report.id };
}
it.each([3, 6, 8, 4])(
  "OPC: configured %i step draft, manual persistence and publication before account creation",
  async (n) => {
    const f = await completed(n);
    const read = await f.service.read(f.d.draftId);
    expect(read.snapshot.workflow.steps).toHaveLength(n);
    expect(read.report.available).toBe(true);
    expect(
      (
        await sql.query(
          "select count(*)::int n from opc_accounts where actor_id=$1",
          [f.actor],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await sql.query(
          "select count(*)::int n from bill2_runs where actor_id=$1",
          [f.actor],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await f.service.list()).drafts).toHaveLength(1);
  },
);
it("OPC: start replay and concurrency preserve one draft/session; actor and payload changes denied", async () => {
  const f = await fixture(),
    input = {
      requestId: randomUUID(),
      registration: f.registration,
      mode: "mentor",
    };
  const [a, b] = await Promise.all([
    f.service.start(input),
    f.service.start(input),
  ]);
  expect(a).toEqual(b);
  await expect(f.service.start({ ...input, mode: "manual" })).rejects.toThrow(
    "CONFLICT",
  );
  const other = await fixture();
  await expect(other.service.read(a.draftId)).rejects.toThrow("DENIED");
});
it("OPC: confirmed multi-account handoff is atomic, concurrent/replayed once and keeps original source/session/money", async () => {
  const f = await completed();
  const body = [
    {
      id: randomUUID(),
      platform: "x",
      account: "one",
      title: "Topic one",
      brief: "Original brief",
      day: "2026-09-15",
    },
    {
      id: randomUUID(),
      platform: "youtube",
      account: "two",
      title: "Topic two",
      brief: "Second brief",
      day: "2026-09-16",
    },
  ];
  const plan = await f.service.savePlan({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    expectedVersion: 0,
    sourceVersionId: f.sourceVersionId,
    body,
  });
  const input = {
    draftId: f.d.draftId,
    requestId: randomUUID(),
    planId: plan.planId,
    accounts: body.map((i) => ({
      platform: i.platform,
      account: i.account,
      expectedRevision: null,
    })),
  };
  const [a, b] = await Promise.all([
    f.service.handoff(input),
    f.service.handoff(input),
  ]);
  expect(a).toEqual(b);
  expect(a).toHaveLength(2);
  expect(new Set(a.map((x: { sessionId: string }) => x.sessionId)).size).toBe(
    2,
  );
  expect(
    a.every((x: { sessionId: string }) => x.sessionId !== f.d.sessionId),
  ).toBe(true);
  expect((await f.service.list()).accounts).toHaveLength(2);
  expect((await f.service.read(f.d.draftId)).sessionId).toBe(f.d.sessionId);
  expect(
    (await sql.query("select credits from profiles where id=$1", [f.actor]))
      .rows[0].credits,
  ).toBe(100);
  await expect(
    f.service.handoff({ ...input, accounts: [input.accounts[0]] }),
  ).rejects.toThrow("CONFLICT");
  await expect(
    f.service.handoff({ ...input, requestId: randomUUID() }),
  ).rejects.toThrow("ACCOUNT_CONFLICT");
  expect(
    (
      await sql.query(
        "select count(*)::int n from opc_items where plan_id=$1",
        [plan.planId],
      )
    ).rows[0].n,
  ).toBe(2);
});
it("OPC: stale plan, invalid target and transaction failure leave no partial accounts", async () => {
  const f = await completed();
  const body = [
    {
      id: randomUUID(),
      platform: "x",
      account: "one",
      title: "Topic",
      brief: "Brief",
      day: "2026-09-15",
    },
  ];
  const p = await f.service.savePlan({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    expectedVersion: 0,
    sourceVersionId: f.sourceVersionId,
    body,
  });
  const input = {
    draftId: f.d.draftId,
    requestId: randomUUID(),
    planId: p.planId,
    accounts: [{ platform: "x", account: "one", expectedRevision: 1 }],
  };
  await expect(f.service.handoff(input)).rejects.toThrow("CONFLICT");
  await f.service.savePlan({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    expectedVersion: 1,
    sourceVersionId: f.sourceVersionId,
    body,
  });
  await expect(
    f.service.handoff({
      ...input,
      accounts: [{ ...input.accounts[0], expectedRevision: null }],
    }),
  ).rejects.toThrow("VERSION_CONFLICT");
  expect((await f.service.list()).accounts).toHaveLength(0);
});

it("OPC: real SDK HTTP result becomes a candidate on original draft; restart/replay does not resend or append twice", async () => {
  const { runtimeExecutor } = await import("../runtime/execute");
  const { createServer } = await import("node:http");
  const f = await fixture(),
    modelId = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-fixture','fixture','true',1000,32000)",
    [modelId],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [
    modelId,
    f.moduleId,
  ]);
  const d = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "mentor",
  });
  await f.service.information({
    draftId: d.draftId,
    stepId: "step-0",
    requestId: randomUUID(),
    expectedVersion: 0,
    values: {
      goal: {
        status: "confirmed",
        nature: "decision",
        value: "Teach photography",
      },
    },
  });
  const prepared = await f.service.prepareStep({
    draftId: d.draftId,
    requestId: randomUUID(),
    stepId: "step-0",
    input: "I want to teach photography.",
  });
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    let raw = "";
    for await (const c of req) raw += c;
    const request = JSON.parse(JSON.parse(raw).input);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "opc-" + prepared.executionId,
        model: request.model,
        final: true,
        cost: "0.003",
        currency: "USD",
        coverage: "request_total",
        usage: {
          sdkResponse: {
            id: "opc-" + prepared.executionId,
            object: "chat.completion",
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "Photography audience: beginners. Hypothesis awaiting confirmation.",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("local endpoint");
    const endpoint = "http://127.0.0.1:" + addr.port;
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint,
    }).execute(prepared.executionId);
    const input = {
      draftId: d.draftId,
      executionId: prepared.executionId,
      stepId: "step-0",
      requestId: randomUUID(),
    };
    const candidate = await f.service.saveResult(input);
    expect(await f.service.saveResult(input)).toEqual(candidate);
    expect(
      await f.service.saveResult({ ...input, requestId: randomUUID() }),
    ).toEqual(candidate);
    await expect(
      f.service.saveResult({ ...input, stepId: "step-1" }),
    ).rejects.toThrow("DENIED");
    await expect(
      f.service.planResult(d.draftId, prepared.executionId),
    ).rejects.toThrow("DENIED");
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint,
    }).execute(prepared.executionId);
    expect(calls).toBe(1);
    const view = await f.service.read(d.draftId);
    expect(view.snapshot.candidates).toHaveLength(1);
    expect(view.snapshot.candidates[0].body).toContain("Photography");
    expect(view.snapshot.steps["step-0"].body).toBe("");
    expect(
      (
        await sql.query(
          "select count(*)::int n from runtime_session_history where session_id=$1",
          [d.sessionId],
        )
      ).rows[0].n,
    ).toBe(2);
    await sql.query("update bill2_drafts set revoked=true where id=$1", [
      d.draftId,
    ]);
    await expect(f.service.read(d.draftId)).rejects.toThrow("DENIED");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
it("OPC: browser manual positioning, versioned week plan, handoff and authenticated recovery", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3);
  const browserModel = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-browser','fixture','true',1000,32000)",
    [browserModel],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [
    browserModel,
    f.moduleId,
  ]);
  const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  let releaseInformation = () => {};
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(u.hostname) ||
        ["data:", "blob:"].includes(u.protocol)
        ? route.continue()
        : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const ready = page.waitForResponse(
      (r) => r.url().includes("/api/trpc/settings.getSystemSettings") && r.ok(),
    );
    await page.goto(process.env.V3_LOCAL_APP + "/login?redirect=/positioning");
    await ready;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await page.waitForURL((url) => url.pathname === "/positioning", {
      timeout: 90000,
    });
    await page
      .getByRole("combobox", { name: "定位方法" })
      .selectOption(f.registration);
    await page
      .getByRole("button", { name: "我已有明确定位", exact: true })
      .click();
    await page.waitForURL((url) => url.pathname.startsWith("/positioning/"));
    const draftUrl = page.url();
    await expect
      .poll(() => page.getByRole("textbox", { name: / 工作稿$/ }).count())
      .toBe(1);
    let firstInformation = true,
      informationArrived!: () => void;
    const heldInformation = new Promise<void>((resolve) => {
      releaseInformation = resolve;
    });
    const informationReady = new Promise<void>((resolve) => {
      informationArrived = resolve;
    });
    await page.route("**/api/trpc/opc.information*", async (route) => {
      if (!firstInformation) {
        await route.continue();
        return;
      }
      firstInformation = false;
      const response = await route.fetch();
      informationArrived();
      await heldInformation;
      await route.fulfill({ response });
    });
    for (const step of f.flow.steps) {
      const article = page.locator("article").filter({
        has: page.getByRole("textbox", { name: step.title + " 工作稿" }),
      });
      const field = step.information![0];
      await article
        .getByRole("textbox", { name: field.title, exact: true })
        .fill("Confirmed test decision");
      await article
        .getByRole("combobox", { name: field.title + " 状态" })
        .selectOption("confirmed");
      await article
        .getByRole("combobox", { name: field.title + " 性质" })
        .selectOption("decision");
      await article.getByRole("button", { name: "保存信息状态" }).click();
      if (step.id === f.flow.steps[0].id) {
        await informationReady;
        expect(
          await article
            .getByRole("textbox", { name: field.title, exact: true })
            .isEnabled(),
        ).toBe(false);
        expect(
          await article
            .getByRole("textbox", { name: step.title + " 工作稿", exact: true })
            .isEnabled(),
        ).toBe(false);
        releaseInformation();
      }
      await expect
        .poll(
          () =>
            article
              .getByRole("button", { name: "确认这一步", exact: true })
              .isEnabled(),
          { timeout: 15000 },
        )
        .toBe(true);
      await article
        .getByRole("textbox", { name: step.title + " 工作稿" })
        .fill("User supplied " + step.title);
      await article
        .getByRole("button", { name: "保存工作稿", exact: true })
        .click();
      await expect
        .poll(() =>
          article
            .getByRole("button", { name: "保存工作稿", exact: true })
            .isEnabled(),
        )
        .toBe(false);
      await article
        .getByRole("button", { name: "确认这一步", exact: true })
        .click();
      await expect
        .poll(() => article.textContent(), { timeout: 15000 })
        .toContain("已确认");
      if (step.id !== f.flow.steps.at(-1)!.id) {
        await page
          .getByRole("button", { name: "继续下一步", exact: true })
          .click();
        await page.reload();
        const next = f.flow.steps[f.flow.steps.indexOf(step) + 1];
        await expect
          .poll(() =>
            page
              .getByRole("textbox", {
                name: next.title + " 工作稿",
                exact: true,
              })
              .isVisible(),
          )
          .toBe(true);
        expect(
          await page.getByRole("textbox", { name: / 工作稿$/ }).count(),
        ).toBe(1);
      }
    }
    await expect
      .poll(
        () =>
          page
            .getByRole("button", { name: "确认正式定位版本", exact: true })
            .isEnabled(),
        { timeout: 15000 },
      )
      .toBe(true);
    const lastStep = f.flow.steps.at(-1)!;
    const lastArticle = page.locator("article").filter({
      has: page.getByRole("textbox", {
        name: lastStep.title + " 工作稿",
        exact: true,
      }),
    });
    await lastArticle
      .getByRole("textbox", {
        name: lastStep.information![0].title,
        exact: true,
      })
      .fill("Updated confirmed decision before publication");
    expect(
      await page
        .getByRole("button", { name: "确认正式定位版本", exact: true })
        .isEnabled(),
    ).toBe(false);
    await page.reload();
    await expect
      .poll(
        () =>
          lastArticle
            .getByRole("textbox", {
              name: lastStep.information![0].title,
              exact: true,
            })
            .inputValue(),
        { timeout: 15000 },
      )
      .toBe("Updated confirmed decision before publication");
    await lastArticle
      .getByRole("button", { name: "保存信息状态", exact: true })
      .click();
    await expect
      .poll(
        () =>
          lastArticle
            .getByRole("button", { name: "确认这一步", exact: true })
            .isEnabled(),
        { timeout: 15000 },
      )
      .toBe(true);
    await lastArticle
      .getByRole("button", { name: "确认这一步", exact: true })
      .click();
    await expect
      .poll(() => lastArticle.textContent(), { timeout: 15000 })
      .toContain("已确认");
    await page.getByRole("button", { name: "确认正式定位版本" }).click();
    await page.getByRole("button", { name: "添加选题" }).click();
    await page
      .getByRole("textbox", { name: "account 0", exact: true })
      .fill("browser-account");
    await page
      .getByRole("textbox", { name: "title 0", exact: true })
      .fill("Browser topic");
    await page
      .getByRole("textbox", { name: "简报", exact: true })
      .fill("A clear brief");
    await page
      .getByRole("button", { name: "按已保存账号生成计划候选", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "AI 计划候选 · 尚未替换你的编辑",
        exact: true,
      })
      .waitFor();
    await page.reload();
    await page
      .getByRole("heading", {
        name: "AI 计划候选 · 尚未替换你的编辑",
        exact: true,
      })
      .waitFor();
    expect(
      await page
        .getByRole("textbox", { name: "title 0", exact: true })
        .inputValue(),
    ).toBe("Browser topic");
    await page.getByRole("button", { name: "保留原计划", exact: true }).click();
    await page.getByRole("button", { name: "保存计划版本" }).click();
    let lostHandoff = false;
    await page.route("**/api/trpc/opc.handoff*", async (route) => {
      if (!lostHandoff) {
        lostHandoff = true;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort();
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "确认账号与计划，创建选题" })
      .click();
    await page.getByRole("alert").waitFor();
    await page.reload();
    await page
      .getByRole("button", { name: "确认账号与计划，创建选题" })
      .click();
    await page.getByRole("link", { name: "进入选题工作空间" }).waitFor();
    const href = await page
      .getByRole("link", { name: "进入选题工作空间" })
      .getAttribute("href");
    await page.reload();
    await page.getByRole("link", { name: "进入选题工作空间" }).waitFor();
    expect(
      await page
        .getByRole("link", { name: "进入选题工作空间" })
        .getAttribute("href"),
    ).toBe(href);
    await context.clearCookies();
    await page.goto(
      process.env.V3_LOCAL_APP +
        "/login?redirect=" +
        encodeURIComponent(new URL(draftUrl).pathname),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await page.waitForURL(draftUrl);
    await page.getByRole("link", { name: "进入选题工作空间" }).waitFor();
    expect(
      await page
        .getByRole("link", { name: "进入选题工作空间" })
        .getAttribute("href"),
    ).toBe(href);
    expect((await f.service.list()).accounts[0].profile.goal_2.value).toBe(
      "Updated confirmed decision before publication",
    );
    expect(
      (
        await sql.query(
          "select count(*)::int n from bill2_runs where actor_id=$1",
          [f.actor],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    releaseInformation();
    await browser.close();
  }
}, 180000);
it("OPC: work item uses shared Runtime and saves non-workflow Skill artifact once; source revocation denies recovery reads", async () => {
  const { runtimeAdmissionService } = await import("../runtime/admission");
  const { runtimeExecutor } = await import("../runtime/execute");
  const { createServer } = await import("node:http");
  const f = await completed(),
    modelId = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-work','fixture','true',1000,32000)",
    [modelId],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [
    modelId,
    f.moduleId,
  ]);
  const plan = await f.service.savePlan({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    expectedVersion: 0,
    sourceVersionId: f.sourceVersionId,
    body: [
      {
        id: randomUUID(),
        platform: "x",
        account: "owner",
        title: "A topic",
        brief: "Use the confirmed positioning.",
        day: "2026-09-15",
      },
    ],
  });
  const [work] = await f.service.handoff({
    draftId: f.d.draftId,
    requestId: randomUUID(),
    planId: plan.planId,
    accounts: [{ platform: "x", account: "owner", expectedRevision: null }],
  });
  const admission = runtimeAdmissionService(f.user, admin, {
    account: "local",
    costPerCall: "0.02",
    creditsPerUsd: "1000",
    multiplier: "1",
    maxCalls: 1,
    maxOutputTokens: 1000,
    inputBytes: 32000,
    historyItems: 20,
    searchEnabled: false,
  });
  const prepared = await admission.prepare({
    sessionId: work.sessionId,
    requestId: randomUUID(),
    input: "Write the topic artifact.",
    selection: {
      kind: "skill",
      moduleId: f.moduleId,
      revisionId: f.pack.revisionId,
    },
    network: "deny",
    sources: [],
  });
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    for await (const _ of req) void _;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "work-" + prepared.executionId,
        model: "opc-work",
        final: true,
        cost: "0.003",
        currency: "USD",
        coverage: "request_total",
        usage: {
          sdkResponse: {
            id: "work-" + prepared.executionId,
            object: "chat.completion",
            created: 1,
            model: "opc-work",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Saved Skill work artifact",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("local server");
    const endpoint = "http://127.0.0.1:" + address.port;
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint,
    }).execute(prepared.executionId);
    const saved = await f.service.saveWorkResult(prepared.executionId);
    expect(await f.service.saveWorkResult(prepared.executionId)).toEqual(saved);
    expect((await f.service.workResults(work.sessionId))[0].body).toBe(
      "Saved Skill work artifact",
    );
    expect(await f.artifacts.projects()).toEqual([]);
    expect(
      (await f.artifacts.read(saved.artifactId, saved.artifactId)).workflow
        .steps,
    ).toEqual([]);
    await expect(
      f.artifacts.report(saved.artifactId, saved.artifactId),
    ).rejects.toThrow("DENIED"); // Dedicated result projection above is readable; workflow mutation/export entry stays closed.
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint,
    }).execute(prepared.executionId);
    expect(calls).toBe(1);
    expect(
      (
        await sql.query(
          "select count(*)::int n from artifact_versions where id=$1",
          [saved.artifactId],
        )
      ).rows[0].n,
    ).toBe(1);
    await sql.query("update bill2_drafts set revoked=true where id=$1", [
      f.d.draftId,
    ]);
    await expect(f.service.workResults(work.sessionId)).rejects.toThrow(
      "DENIED",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
it("OPC: revising positioning retains original version/session and invalidates only configured dependents", async () => {
  const f = await completed(3);
  const old = await f.service.read(f.d.draftId);
  const request = randomUUID();
  const revision = await f.service.revise(f.d.draftId, request, f.d.roundId);
  expect(await f.service.revise(f.d.draftId, request, f.d.roundId)).toEqual(
    revision,
  );
  const current = await f.service.read(f.d.draftId);
  expect(current.sessionId).toBe(f.d.sessionId);
  expect(current.roundId).not.toBe(f.d.roundId);
  await f.artifacts.execute({
    action: "save",
    projectId: f.d.projectId,
    roundId: current.roundId,
    requestId: randomUUID(),
    stepId: "step-1",
    expectedVersion: current.snapshot.steps["step-1"].version,
    body: "Changed decision",
    evidenceIds: [],
  });
  const next = await f.service.read(f.d.draftId);
  expect(next.snapshot.steps["step-0"].valid).toBe(true);
  expect(next.snapshot.steps["step-1"].valid).toBe(false);
  expect(next.snapshot.steps["step-2"].valid).toBe(false);
  expect(await f.artifacts.report(f.d.projectId, f.d.roundId)).toEqual(
    old.report,
  );
});
it("OPC: required information states gate confirmation and survive revisions without replacing facts", async () => {
  const f = await fixture(3),
    d = await f.service.start({
      requestId: randomUUID(),
      registration: f.registration,
      mode: "mentor",
    });
  await f.artifacts.execute({
    action: "save",
    projectId: d.projectId,
    roundId: d.roundId,
    requestId: randomUUID(),
    stepId: "step-0",
    expectedVersion: 0,
    body: "A provisional answer",
    evidenceIds: [],
  });
  for (const status of [
    "unknown",
    "unclear",
    "provisional",
    "deferred",
    "confirmed",
  ] as const) {
    const before = await f.artifacts.read(d.projectId, d.roundId);
    await f.service.information({
      draftId: d.draftId,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: before.steps["step-0"].version,
      values: {
        goal: {
          status,
          nature: "hypothesis",
          value:
            status === "deferred"
              ? "User accepts this limitation"
              : "User material",
        },
      },
    });
    const after = await f.artifacts.read(d.projectId, d.roundId),
      command = {
        action: "confirm" as const,
        projectId: d.projectId,
        roundId: d.roundId,
        requestId: randomUUID(),
        stepId: "step-0",
        expectedVersion: after.steps["step-0"].version,
        expectedReviewVersion: after.steps["step-0"].reviewVersion,
      };
    if (["deferred", "confirmed"].includes(status))
      await f.artifacts.execute(command);
    else await expect(f.artifacts.execute(command)).rejects.toThrow();
    expect(
      (await f.service.read(d.draftId)).information["step-0"].values.goal
        .status,
    ).toBe(status);
  }
  const other = await fixture();
  await expect(
    other.service.information({
      draftId: d.draftId,
      requestId: randomUUID(),
      stepId: "step-0",
      expectedVersion: 0,
      values: {},
    }),
  ).rejects.toThrow("DENIED");
});
it("OPC: plan generation uses the original SDK session and returns a separate bounded plan candidate", async () => {
  const { runtimeExecutor } = await import("../runtime/execute");
  const { createServer } = await import("node:http");
  const f = await completed(3),
    modelId = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-plan','fixture','true',1000,32000)",
    [modelId],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [
    modelId,
    f.moduleId,
  ]);
  const request = {
    draftId: f.d.draftId,
    requestId: randomUUID(),
    purpose: "plan" as const,
    stepId: "step-2",
    input: "x account test-account; start 2026-09-15",
  };
  const prepared = await f.service.prepareStep(request);
  const body = [
    {
      id: randomUUID(),
      platform: "x",
      account: "test-account",
      title: "First topic",
      brief: "Use confirmed facts.",
      day: "2026-09-15",
    },
  ];
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    for await (const _ of req) void _;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "plan-" + prepared.executionId,
        model: "opc-plan",
        final: true,
        cost: "0.003",
        currency: "USD",
        coverage: "request_total",
        usage: {
          sdkResponse: {
            id: "plan-" + prepared.executionId,
            object: "chat.completion",
            created: 1,
            model: "opc-plan",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(body) },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("local server");
    const endpoint = "http://127.0.0.1:" + address.port;
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint,
    }).execute(prepared.executionId);
    expect(
      (await f.service.planResult(f.d.draftId, prepared.executionId)).body,
    ).toEqual(body);
    expect((await f.service.read(f.d.draftId)).plans).toEqual([]);
    await expect(
      f.service.saveResult({
        draftId: f.d.draftId,
        executionId: prepared.executionId,
        stepId: "step-2",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("DENIED");
    expect((await f.service.prepareStep(request)).executionId).toBe(
      prepared.executionId,
    );
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint,
    }).execute(prepared.executionId);
    expect(calls).toBe(1);
    const other = await fixture();
    await expect(
      other.service.planResult(f.d.draftId, prepared.executionId),
    ).rejects.toThrow("DENIED");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
it.skipIf(!process.env.V3_REAL_SKILL_INPUT)(
  "OPC: original private six-step productization publishes intact resources and binds information/profile to the original Session",
  async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { saveModuleSkill } = await import("../skills/modulePublication");
    const input = JSON.parse(
      readFileSync(process.env.V3_REAL_SKILL_INPUT!, "utf8"),
    );
    const f = await fixture(),
      model = randomUUID();
    input.moduleId = randomUUID();
    input.skillId = randomUUID();
    input.revisionId = randomUUID();
    input.requestId = randomUUID();
    input.expectedVersion = 0;
    input.expectedUpdatedAt = null;
    input.module.model_id = model;
    await sql.query(
      "insert into ai_models(id,name,model_id,provider,is_active,api_key,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family) values($1,'Runtime local','qwen/qwen3.8-27b','openai','true','LOCAL_ONLY','',4096,128000,'false','openai')",
      [model],
    );
    await saveModuleSkill(admin, f.owner, input);
    const stored = await admin.rpc("admin_read_skill_module", {
      p_actor_id: f.owner,
      p_module_id: input.moduleId,
    });
    expect(stored.error).toBeNull();
    for (const file of input.files)
      expect(
        stored.data.files.find((v: any) => v.path === file.path).base64,
      ).toBe(file.base64);
    const registration = (
      await sql.query(
        "select id from artifact_workflows where module_id=$1 and revision_id=$2",
        [input.moduleId, input.revisionId],
      )
    ).rows[0].id;
    const d = await f.service.start({
      requestId: randomUUID(),
      registration,
      mode: "manual",
    });
    const first = await f.service.read(d.draftId);
    expect(first.snapshot.workflow.steps.map((s: any) => s.title)).toEqual(
      input.steps.map((s: any) => s.title),
    );
    for (const [index, step] of first.snapshot.workflow.steps.entries()) {
      const values = Object.fromEntries(
        input.steps[index].information.map((field: any) => [
          field.id,
          {
            status: "deferred",
            nature: "unknown",
            value: "隔离测试：真实研究与业务判断暂未验证，用户明确接受此局限。",
          },
        ]),
      );
      await f.service.information({
        draftId: d.draftId,
        stepId: step.id,
        requestId: randomUUID(),
        expectedVersion: 0,
        values,
      });
      await f.artifacts.execute({
        action: "save",
        projectId: d.projectId,
        roundId: d.roundId,
        stepId: step.id,
        requestId: randomUUID(),
        expectedVersion: 1,
        body:
          "隔离验证草稿：" +
          step.title +
          "。不声明真实研究或商业建议质量通过。",
        evidenceIds: [],
      });
      const current = (await f.artifacts.read(d.projectId, d.roundId)).steps[
        step.id
      ];
      await f.artifacts.execute({
        action: "confirm",
        projectId: d.projectId,
        roundId: d.roundId,
        stepId: step.id,
        requestId: randomUUID(),
        expectedVersion: current.version,
        expectedReviewVersion: current.reviewVersion,
      });
    }
    const snapshot = await f.artifacts.read(d.projectId, d.roundId);
    await f.artifacts.execute({
      action: "publish",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      expectedSteps: Object.fromEntries(
        Object.entries(snapshot.steps).map(([k, v]) => [
          k,
          { version: v.version, reviewVersion: v.reviewVersion },
        ]),
      ),
    });
    const report = (await f.service.read(d.draftId)).report;
    const profile = (
      await sql.query("select opc_profile($1) as p", [report.id])
    ).rows[0].p;
    expect(Object.keys(profile)).toHaveLength(23);
    expect(
      Object.values(profile).every(
        (p: any) =>
          p.sourceVersionId === report.id &&
          p.confirmationId &&
          p.status === "deferred",
      ),
    ).toBe(true);
    const plan = await f.service.savePlan({
      draftId: d.draftId,
      requestId: randomUUID(),
      expectedVersion: 0,
      sourceVersionId: report.id,
      body: [
        {
          id: randomUUID(),
          platform: "x",
          account: "original-local",
          title: "原方法的隔离工作项",
          brief: "仅验证原方法业务接线",
          day: "2026-09-15",
        },
      ],
    });
    const [work] = await f.service.handoff({
      draftId: d.draftId,
      requestId: randomUUID(),
      planId: plan.planId,
      accounts: [
        { platform: "x", account: "original-local", expectedRevision: null },
      ],
    });
    const material = (
      await sql.query(
        "select content from runtime_scope_material where session_id=$1",
        [work.sessionId],
      )
    ).rows[0].content;
    expect(JSON.parse(material.material)).toEqual(profile);
    expect(material.material).not.toContain("隔离验证草稿：");
    await sql.query("update ai_models set provider='fixture' where id=$1", [
      model,
    ]);
    const admitted = await f.service.prepareStep({
      draftId: d.draftId,
      requestId: randomUUID(),
      purpose: "plan",
      stepId: "step-6",
      input: JSON.stringify([
        { platform: "x", account: "original-local", day: "2026-09-15" },
      ]),
    });
    const frozen = (
      await sql.query("select payload from runtime_executions where id=$1", [
        admitted.executionId,
      ])
    ).rows[0].payload;
    expect(frozen.instructions).toContain("内容支柱");
    expect(frozen.instructions).toContain("不编造数据");
    expect(frozen.request.sessionId).toBe(d.sessionId);
    const { runtimeExecutor } = await import("../runtime/execute");
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint: process.env.V3_RUNTIME_LOCAL_ENDPOINT!,
    }).execute(admitted.executionId);
    const generated = await f.service.planResult(
      d.draftId,
      admitted.executionId,
    );
    expect(generated.body[0]).toMatchObject({
      platform: "x",
      account: "original-local",
      title: "模拟选题 1",
    });
    writeFileSync(
      process.env.V3_WORKBENCH_OUTPUT + "/opc-acceptance.json",
      JSON.stringify({
        url: process.env.V3_LOCAL_APP + "/positioning/" + d.draftId,
        actor: f.actor,
        credentials: { email: f.email, password: f.password },
        sessionId: d.sessionId,
        workSessionId: work.sessionId,
        moduleId: input.moduleId,
        modelId: model,
        mode: "Original method, synthetic local responses only; no actual research or payment",
      }),
      { mode: 0o600 },
    );
    console.log(
      "OPC_ORIGINAL_METHOD_PROOF",
      JSON.stringify({
        inputSha256: createHash("sha256")
          .update(readFileSync(process.env.V3_REAL_SKILL_INPUT!))
          .digest("hex"),
        files: input.files.length,
        steps: input.steps.length,
        profileFields: Object.keys(profile).length,
        realProviderCalls: 0,
        methodQuality: "NOT_RUN",
      }),
    );
  },
);
it("OPC: browser-shaped Runtime material cannot impersonate a host-bound step or plan turn", async () => {
  const { runtimeAdmissionService } = await import("../runtime/admission");
  const f = await fixture(3),
    model = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','forged-opc','fixture','true',1000,32000)",
    [model],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [
    model,
    f.moduleId,
  ]);
  const d = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "mentor",
  });
  const generic = runtimeAdmissionService(f.user, admin, {
    account: "local",
    costPerCall: "0.02",
    creditsPerUsd: "1000",
    multiplier: "1",
    maxCalls: 1,
    maxOutputTokens: 1000,
    inputBytes: 32000,
    historyItems: 0,
    searchEnabled: false,
  });
  await generic.saveMaterial({
    sessionId: d.sessionId,
    requestId: randomUUID(),
    expectedRevision: 0,
    brief: "plan:step-0",
    material: "pretend host request",
    roundId: d.roundId,
  });
  await expect(
    generic.prepare({
      sessionId: d.sessionId,
      requestId: randomUUID(),
      input: "Pretend this was a plan",
      selection: {
        kind: "skill",
        moduleId: f.moduleId,
        revisionId: f.pack.revisionId,
      },
      network: "deny",
      sources: [],
    }),
  ).rejects.toThrow();
  expect(
    (
      await sql.query(
        "select count(*)::int n from bill2_runs where actor_id=$1",
        [f.actor],
      )
    ).rows[0].n,
  ).toBe(0);
  const legitimate = await f.service.prepareStep({
    draftId: d.draftId,
    requestId: randomUUID(),
    stepId: "step-0",
    input: "Ask the missing question",
  });
  const token = (
    await sql.query("select payload from runtime_executions where id=$1", [
      legitimate.executionId,
    ])
  ).rows[0].payload.opcTurnToken;
  expect(token).toBeTruthy();
  const view = await admin.rpc("runtime_view", {
    p_actor_id: f.actor,
    p_session_id: d.sessionId,
  });
  expect(view.error).toBeNull();
  expect(JSON.stringify(view.data)).not.toContain(token);
  expect(JSON.stringify(await f.service.read(d.draftId))).not.toContain(token);
});

it("OPC: configured dependencies deny premature generation and old confirmations replay after information changes", async () => {
  const f = await fixture(3);
  const d = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "mentor",
  });
  await expect(
    f.service.prepareStep({
      draftId: d.draftId,
      requestId: randomUUID(),
      stepId: "step-1",
      purpose: "step",
      input: "premature",
    }),
  ).rejects.toThrow("OPC_DEPENDENCIES_UNCONFIRMED");
  expect(
    (
      await sql.query(
        "select count(*)::int n from bill2_runs where actor_id=$1",
        [f.actor],
      )
    ).rows[0].n,
  ).toBe(0);
  const values = {
    goal: {
      status: "confirmed",
      nature: "fact",
      value: "Local verified input",
    },
  };
  await f.service.information({
    draftId: d.draftId,
    stepId: "step-0",
    requestId: randomUUID(),
    expectedVersion: 0,
    values,
  });
  await f.artifacts.execute({
    action: "save",
    projectId: d.projectId,
    roundId: d.roundId,
    stepId: "step-0",
    requestId: randomUUID(),
    expectedVersion: 1,
    body: "Local working result",
    evidenceIds: [],
  });
  const state = (await f.artifacts.read(d.projectId, d.roundId)).steps[
    "step-0"
  ];
  const confirmation = {
    action: "confirm" as const,
    projectId: d.projectId,
    roundId: d.roundId,
    stepId: "step-0",
    requestId: randomUUID(),
    expectedVersion: state.version,
    expectedReviewVersion: state.reviewVersion,
  };
  const saved = await f.artifacts.execute(confirmation);
  const fresh = (await f.artifacts.read(d.projectId, d.roundId)).steps[
    "step-0"
  ];
  await f.service.information({
    draftId: d.draftId,
    stepId: "step-0",
    requestId: randomUUID(),
    expectedVersion: fresh.version,
    values: { goal: { status: "unknown", nature: "unknown", value: "" } },
  });
  expect(await f.artifacts.execute(confirmation)).toEqual(saved);
  await expect(
    f.artifacts.execute({ ...confirmation, requestId: randomUUID() }),
  ).rejects.toThrow();
});

it("OPC: browser mentor is stepwise with replies, distinct local examples and original Session recovery", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3);
  const browserModel = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-browser','fixture','true',1000,32000)",
    [browserModel],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [
    browserModel,
    f.moduleId,
  ]);
  const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });

  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(u.hostname) ||
        ["data:", "blob:"].includes(u.protocol)
        ? route.continue()
        : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const ready = page.waitForResponse(
      (r) => r.url().includes("/api/trpc/settings.getSystemSettings") && r.ok(),
    );
    await page.goto(process.env.V3_LOCAL_APP + "/login?redirect=/positioning");
    await ready;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await page.waitForURL((url) => url.pathname === "/positioning", {
      timeout: 90000,
    });
    await page
      .getByRole("combobox", { name: "定位方法" })
      .selectOption(f.registration);
    await page.getByRole("button", { name: "导师引导", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/positioning/"));

    const draftUrl = page.url();
    const draftId = new URL(draftUrl).pathname.split("/").at(-1)!;
    await expect
      .poll(() =>
        page.getByRole("textbox", { name: "给导师的回复" }).isVisible(),
      )
      .toBe(true);
    expect(
      await page
        .getByRole("textbox", {
          name: f.flow.steps[0].title + " 工作稿",
          exact: true,
        })
        .isVisible(),
    ).toBe(false);
    const nextButton = page
      .getByRole("navigation", { name: "定位步骤" })
      .getByRole("button")
      .nth(1);
    expect(await nextButton.isEnabled()).toBe(false);
    await page
      .getByRole("textbox", { name: "给导师的回复" })
      .fill("我想先明确我的受众");
    await page.reload();
    await expect
      .poll(() =>
        page.getByRole("textbox", { name: "给导师的回复" }).inputValue(),
      )
      .toBe("我想先明确我的受众");
    let loseFirstReply = true;
    await page.route("**/api/trpc/runtime.execute*", async (route) => {
      if (!loseFirstReply) return route.continue();
      loseFirstReply = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort();
    });
    await page
      .getByRole("button", { name: "请导师帮助这一步", exact: true })
      .click();
    await page.getByRole("alert").filter({ hasText: "操作未完成" }).waitFor();
    await page
      .getByRole("textbox", { name: "给导师的回复", exact: true })
      .fill("恢复期间另写的未发送内容");
    await page
      .getByRole("button", { name: "请导师帮助这一步", exact: true })
      .click();
    await page
      .getByText("【分步模拟，仅验证流程】第 1 步示例：", { exact: false })
      .waitFor();
    expect(
      await page
        .getByRole("textbox", { name: "给导师的回复", exact: true })
        .inputValue(),
    ).toBe("恢复期间另写的未发送内容");
    const d = await f.service.read(draftId);
    expect(d.sessionId).toBeTruthy();
    const first = f.flow.steps[0];
    await f.artifacts.execute({
      action: "save",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      stepId: first.id,
      body: "User confirmed first step",
      evidenceIds: [],
      expectedVersion: 0,
    });
    let state = (await f.artifacts.read(d.projectId, d.roundId)).steps[
      first.id
    ];
    await f.service.information({
      draftId,
      stepId: first.id,
      requestId: randomUUID(),
      expectedVersion: state.version,
      values: {
        goal: {
          status: "confirmed",
          nature: "decision",
          value: "A concrete user decision",
        },
      },
    });
    state = (await f.artifacts.read(d.projectId, d.roundId)).steps[first.id];
    await f.artifacts.execute({
      action: "confirm",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      stepId: first.id,
      expectedVersion: state.version,
      expectedReviewVersion: state.reviewVersion,
    });
    await page.reload();
    await expect.poll(() => nextButton.isEnabled()).toBe(true);
    await nextButton.click();
    await page
      .getByRole("textbox", { name: "给导师的回复" })
      .fill("我有两个参考账号");
    await page
      .getByRole("button", { name: "请导师帮助这一步", exact: true })
      .click();
    await page
      .getByText("【分步模拟，仅验证流程】第 2 步示例：", { exact: false })
      .waitFor();
    await page.reload();
    await page
      .getByText("【分步模拟，仅验证流程】第 2 步示例：", { exact: false })
      .waitFor();
    expect((await f.service.read(draftId)).sessionId).toBe(d.sessionId);
    expect(
      (
        await sql.query(
          "select count(*)::int n from bill2_runs where actor_id=$1",
          [f.actor],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      await page
        .getByRole("textbox", {
          name: f.flow.steps[0].title + " 工作稿",
          exact: true,
        })
        .count(),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 180000);
