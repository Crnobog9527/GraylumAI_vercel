/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { makePackage, makeWorkflow } from "../__tests__/fixtures/artifacts";
import { publishSkillPackage } from "../skills/publication";
import { opcService } from "./service";
import { workbenchService } from "../artifacts/workbench";
import { OPENING_INPUT } from "../../shared/opcQuestions";
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

/** The exact business turns in a fixture, not just "one row per request ID". */
type ExpectedMentorEffect = {
  stepId: string;
  questionId: string;
  opening: boolean;
  input: string;
};
type MentorEffectRow = {
  execution_id: string;
  request_id: string;
  billing_id: string | null;
  pre_deduct_id: string | null;
  draft_id: string | null;
  round_id: string | null;
  step_id: string | null;
  purpose: string | null;
  task: string | null;
  input: string | null;
  execution_state: string;
  billing_state: string | null;
};
async function expectExactMentorEffects(
  actorId: string,
  draftId: string,
  roundId: string,
  expected: readonly ExpectedMentorEffect[],
) {
  const readEffects = async () => (await sql.query<MentorEffectRow>(
    `select e.id::text execution_id, e.request_id::text request_id,
       b.id::text billing_id, b.pre_deduct_id::text pre_deduct_id,
       t.draft_id::text draft_id, t.round_id::text round_id, t.step_id, t.purpose,
       e.payload->'request'->'selection'->>'task' task,
       e.payload->'request'->>'input' input,
       e.state execution_state, b.state billing_state
     from runtime_executions e
     left join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id
     left join bill2_runs b on b.id=e.billing_run_id and b.actor_id=e.actor_id
     where e.actor_id=$1`,
    [actorId],
  )).rows;
  const expectedTurns = expected.map(turn => JSON.stringify({
    draftId, roundId, stepId: turn.stepId, purpose: "mentor",
    task: (turn.opening ? "opc-opening:" : "opc-question:") + turn.questionId,
    input: turn.input, executionState: "completed", billingState: "settled",
  })).sort();
  const project = (rows: MentorEffectRow[]) => rows.map(row => JSON.stringify({
    draftId: row.draft_id, roundId: row.round_id, stepId: row.step_id,
    purpose: row.purpose, task: row.task, input: row.input,
    executionState: row.execution_state, billingState: row.billing_state,
  })).sort();
  await expect.poll(async () => project(await readEffects()), { timeout: 30000 })
    .toEqual(expectedTurns);
  const rows = await readEffects();
  expect(project(rows)).toEqual(expectedTurns);
  // Also count all actor billing runs/reservations, so unlinked duplicate runs
  // cannot be hidden by the join or by using a fresh random request ID.
  expect((await sql.query("select count(*)::int n from bill2_runs where actor_id=$1", [actorId])).rows[0].n)
    .toBe(expected.length);
  expect((await sql.query("select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'", [actorId])).rows[0].n)
    .toBe(expected.length);
  expect(new Set(rows.map(row => row.request_id)).size).toBe(expected.length);
  expect(rows.every(row => Boolean(row.billing_id && row.pre_deduct_id))).toBe(true);
  expect(new Set(rows.map(row => row.billing_id)).size).toBe(expected.length);
  expect(new Set(rows.map(row => row.pre_deduct_id)).size).toBe(expected.length);
  // Identity sets are compared before/after navigation and authentication
  // recovery; a replacement execution must not pass as a restored one.
  return rows.map(row => JSON.stringify([
    row.execution_id, row.request_id, row.billing_id, row.pre_deduct_id,
  ])).sort();
}
async function fixture(n = 6, secondField = false) {
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
    "insert into profiles(id,email,role,credits) values($1,$2,'user',1000)",
    [actor, email],
  );
  await sql.query(
    "insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)",
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
    flow = makeWorkflow(n, n === 6),
    // The published module always carries an administrator model binding, the
    // same way the real product does, so the host can open a question itself.
    fixtureModel = randomUUID();
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
  if (secondField) flow.steps[0].information!.push({id:"other",title:"Second independent field",required:false,profileKey:"other"});
  await sql.query(
    "insert into skills(id,skill_key,created_by) values($1,$2,$3)",
    [pack.id, registration, owner],
  );
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Fixture default','opc-fixture-default','fixture','true',1000,32000)",
    [fixtureModel],
  );
  await sql.query(
    "insert into modules(id,title,skill_id,model_id,active) values($1,$2,$3,$4,true)",
    [moduleId, "隔离定位 " + n, pack.id, fixtureModel],
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
  ).toBe(1000);
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
      .poll(() => page.getByLabel("全程导师聊天").count(), {
        timeout: 15000,
      })
      .toBe(1);
    expect(await page.getByRole("button", { name: "保存信息状态" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "确认所填信息并整理成果" }).count()).toBe(0);
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
      const field = step.information![0];
      const article = page.locator("article").filter({
        has: page.getByRole("textbox", { name: field.title, exact: true }),
      });
      await article
        .getByRole("textbox", { name: field.title, exact: true })
        .fill("Confirmed test decision");
      if (step.id === f.flow.steps[0].id) {
        await informationReady;
        expect(
          await article
            .getByRole("textbox", { name: field.title, exact: true })
            .isEnabled(),
        ).toBe(true);
        releaseInformation();
      }
      await expect
        .poll(
          () => article.getByText("已自动保存", { exact: true }).count(),
          { timeout: 15000 },
        )
        .toBe(1);
      await article
        .getByRole("button", { name: /确认本题并继续|继续核对本题确认/, exact: true })
        .click();
      if (step.id !== f.flow.steps.at(-1)!.id) {
        const next = f.flow.steps[f.flow.steps.indexOf(step) + 1];
        const nextField = page.getByRole("textbox", {
          name: next.information![0].title,
          exact: true,
        });
        try {
          await nextField.waitFor({ state: "visible", timeout: 15000 });
        } catch {
          throw new Error(
            "next step unavailable: " +
              JSON.stringify({
                heading: await page.locator("article h2").allTextContents(),
                screen: (await page.locator("main").innerText()).slice(0, 2000),
              }),
          );
        }
        await page.reload();
        await expect
          .poll(() => page.getByLabel("全程导师聊天").count(), {
            timeout: 15000,
          })
          .toBe(1);
      }
    }
    await expect
      .poll(
        () =>
          page
            .getByRole("button", { name: "确认正式定位并生成第一周计划", exact: true })
            .isEnabled(),
        { timeout: 15000 },
      )
      .toBe(true);
    const lastStep = f.flow.steps.at(-1)!;
    const lastArticle = page.locator("article").filter({
      has: page.getByRole("textbox", {
        name: lastStep.information![0].title,
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
        .getByRole("button", { name: "确认正式定位并生成第一周计划", exact: true })
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
    await expect
      .poll(
        () =>
          lastArticle
            .getByRole("button", { name: /确认本题并继续|继续核对本题确认/, exact: true })
            .isEnabled(),
        { timeout: 15000 },
      )
      .toBe(true);
    await lastArticle
      .getByRole("button", { name: /确认本题并继续|继续核对本题确认/, exact: true })
      .click();
    await expect
      .poll(() => lastArticle.textContent(), { timeout: 15000 })
      .toContain("已确认");
    await page
      .getByRole("button", { name: "确认正式定位并生成第一周计划", exact: true })
      .click();
    await page.waitForURL(url => url.pathname.endsWith("/plan"));
    expect(await page.getByLabel("定位摘要").textContent()).toContain("Updated confirmed decision");
    expect(await page.getByLabel("当前定位步骤").count()).toBe(0);
    expect(await page.getByRole("table", {name:"第一周选题计划"}).count()).toBe(1);
    // New flow: the final confirmation itself authorizes exactly one plan
    // generation, so the candidate must appear with no generation click.
    await page
      .getByRole("heading", {
        name: "AI 计划候选 · 尚未替换你的编辑",
        exact: true,
      })
      .waitFor();
    expect(
      await page
        .getByRole("button", { name: "重新生成计划候选", exact: true })
        .count(),
    ).toBe(1);
    await page
      .getByRole("button", { name: "采用候选到计划工作稿", exact: true })
      .click();
    await page.getByRole("textbox", { name: "title 0", exact: true }).waitFor();
    expect(
      await page
        .getByRole("textbox", { name: "title 0", exact: true })
        .inputValue(),
    ).toBe("模拟选题 1");
    // Adopting the candidate ends the recovery envelope, so a reload must not
    // generate a second one.
    await page.reload();
    await expect
      .poll(
        () =>
          page
            .getByRole("heading", {
              name: "AI 计划候选 · 尚未替换你的编辑",
              exact: true,
            })
            .count(),
        { timeout: 15000 },
      )
      .toBe(0);
    // Manual editing stays available once a candidate has been adopted.
    await page
      .getByRole("textbox", { name: "title 0", exact: true })
      .fill("Browser topic");
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
    await page.getByRole("link", { name: "进入选题工作空间" }).first().waitFor();
    const href = await page
      .getByRole("link", { name: "进入选题工作空间" }).first()
      .getAttribute("href");
    await page.reload();
    await page.getByRole("link", { name: "进入选题工作空间" }).first().waitFor();
    expect(
      await page
        .getByRole("link", { name: "进入选题工作空间" }).first()
        .getAttribute("href"),
    ).toBe(href);
    await context.clearCookies();
    await page.goto(
      process.env.V3_LOCAL_APP +
        "/login?redirect=" +
        encodeURIComponent(new URL(draftUrl).pathname + "/plan"),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await page.waitForURL(draftUrl + "/plan");
    await page.getByRole("link", { name: "进入选题工作空间" }).first().waitFor();
    expect(
      await page
        .getByRole("link", { name: "进入选题工作空间" }).first()
        .getAttribute("href"),
    ).toBe(href);
    expect((await f.service.list()).accounts[0].profile.goal_2.value).toBe(
      "Updated confirmed decision before publication",
    );
    // The Agent produced the seven-row candidate that was adopted, so the
    // handoff created exactly one work item per adopted row.
    expect(
      (
        await sql.query(
          "select count(*)::int n from opc_items i join artifact_projects p on p.id=i.work_item_id where p.actor_id=$1",
          [f.actor],
        )
      ).rows[0].n,
    ).toBe(7);
    expect(
      (
        await sql.query(
          "select count(*)::int n from bill2_runs b join runtime_executions e on e.billing_run_id=b.id join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where b.actor_id=$1 and t.purpose='plan'",
          [f.actor],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    releaseInformation();
    await browser.close();
  }
}, 300000);
it("OPC: browser can correct plan inputs after a definite invalid completed response", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await completed(3);
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
    await page.goto(
      process.env.V3_LOCAL_APP +
        "/login?redirect=" +
        encodeURIComponent("/positioning/" + f.d.draftId + "/plan"),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await page.waitForURL((url) =>
      url.pathname.endsWith("/positioning/" + f.d.draftId + "/plan"),
    );
    await page.getByRole("button", { name: "添加选题" }).click();
    await page
      .getByRole("textbox", { name: "account 0", exact: true })
      .fill("manual-user-row");
    await page
      .getByRole("textbox", { name: "title 0", exact: true })
      .fill("Original user title");
    await page
      .getByRole("textbox", { name: "简报", exact: true })
      .fill("Original user brief");
    // The user supplies their own choices; the Agent produces the rows.
    const accountChoice = page.getByRole("textbox", {
      name: "具体账号",
      exact: true,
    });
    await accountChoice.fill("invalid-plan");
    const generate = page.getByRole("button", {
      name: "生成第一周计划",
      exact: true,
    });
    const invalidResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/trpc/opc.planResult") && response.ok(),
    );
    await generate.click();
    await invalidResponse;
    await expect
      .poll(() =>
        page.evaluate((id) =>
          sessionStorage.getItem("opc-plan-generation:" + id),
        f.d.draftId),
      )
      .toBeNull();
    await accountChoice.fill("corrected-plan");
    await generate.click();
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
    ).toBe("Original user title");
    const requests = await sql.query(
      "select request_id,state from runtime_executions where session_id=$1 order by created_at,id",
      [f.d.sessionId],
    );
    expect(requests.rows).toHaveLength(2);
    expect(new Set(requests.rows.map((row) => row.request_id)).size).toBe(2);
    expect(requests.rows.map((row) => row.state)).toEqual([
      "completed",
      "completed",
    ]);
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: the ordered question navigator keeps reached rows and lets a deferred question be explicitly confirmed", async () => {
  const {chromium} = await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3, true), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Question nav local','opc-question-nav','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  const startedAt = Date.now();
  const milestones: Record<string, number> = {};
  const external: string[] = [];
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const host = new URL(route.request().url()).hostname;
      if (["127.0.0.1","localhost"].includes(host)) return route.continue();
      external.push(host);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const path = "/positioning/" + draft.draftId;
    const ready = page.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), {timeout: 90000});
    await page.goto(process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path));
    await ready;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", {name:"登录", exact:true}).last().click();
    await page.waitForURL(process.env.V3_LOCAL_APP + path);
    milestones.loginLoaded = Date.now() - startedAt;

    const questionLog = page.getByRole("log", {name:"完整导师消息"});
    const opening = questionLog.getByText("导师主动引导 · 1.1", {exact:true}).locator("..").locator("p");
    // The mentor's own prose must carry the host-derived label, never the step index.
    await expect.poll(() => opening.textContent(), {timeout:30000}).toContain("第 1.1 题");
    milestones.openingVisible = Date.now() - startedAt;

    const navigator = page.getByRole("navigation", {name:"本步骤已到达的问题"});
    const rowTexts = async () =>
      (await navigator.getByRole("button").allTextContents()).map(t => t.replace(/\s+/g," ").trim());
    const confirmButton = () => page.getByRole("button", {name:"确认本题并继续", exact:true});

    await page.getByRole("textbox", {name:"已知目标 0", exact:true}).fill("做 AI 工具赛道");
    milestones.formTyped = Date.now() - startedAt;
    await confirmButton().click();
    await expect.poll(async () => (await f.service.read(draft.draftId)).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("confirmed");
    milestones.firstConfirmReadBack = Date.now() - startedAt;

    // The page's own read-back follows the confirmation, so wait for the
    // navigator to reflect the newly reached current question.
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(2);
    let rows = await rowTexts();
    expect(rows[0]).toContain("1.1");
    expect(rows[0]).toContain("已确认");
    expect(rows[1]).toContain("1.2");
    expect(rows[1]).toContain("当前");
    expect(rows.join(" | ")).not.toContain("Synthetic step 2");

    // Repeated row selection must not re-sort, remove or rename any row.
    await navigator.getByRole("button").nth(1).click();
    await navigator.getByRole("button").nth(0).click();
    await navigator.getByRole("button").nth(1).click();
    expect(await rowTexts()).toEqual(rows);

    // A deferred answer stays visible as its own state instead of "已确认".
    await page.getByRole("button", {name:"暂时跳过本题", exact:true}).click();
    await expect.poll(async () => (await f.service.read(draft.draftId)).information["step-0"].values?.other?.status, {timeout:30000}).toBe("deferred");
    milestones.deferReadBack = Date.now() - startedAt;
    await page.getByRole("navigation", {name:"定位步骤"}).getByRole("button", {name:/Synthetic step 1/}).click();
    await expect.poll(async () => (await rowTexts())[1] ?? "", {timeout:30000}).toContain("待定（已暂缓）");

    // The deferred question must be revisitable: an explicit deferred → confirmed
    // is a real action, not a redundant duplicate.
    await expect.poll(() => confirmButton().isEnabled(), {timeout:15000}).toBe(true);
    await confirmButton().click();
    await expect.poll(async () => (await f.service.read(draft.draftId)).information["step-0"].values?.other?.status, {timeout:90000}).toBe("confirmed");
    milestones.deferredThenConfirmedReadBack = Date.now() - startedAt;
    await expect.poll(async () => (await rowTexts())[1] ?? "", {timeout:30000}).toContain("已确认");

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    console.log("OPC_QUESTION_NAV_MILESTONES " + JSON.stringify({...milestones, totalMs: Date.now() - startedAt}));
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: work item uses shared Runtime and saves non-workflow Skill artifact once; source revocation denies recovery reads", async () => {
  const { runtimeAdmissionService } = await import("../runtime/admission");
  const { runtimeExecutor } = await import("../runtime/execute");
  const { createServer } = await import("node:http");
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
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
        id: "work-" + calls,
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
    const ordinary = await admission.prepare({
      sessionId: work.sessionId,
      requestId: randomUUID(),
      input: "Keep this as an ordinary conversation.",
      selection: { kind: "ordinary", modelId },
      network: "deny",
      sources: [],
    });
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint,
    }).execute(ordinary.executionId);
    const publicView = await admin.rpc("runtime_view", {
      p_actor_id: f.actor,
      p_session_id: work.sessionId,
    });
    expect(publicView.error).toBeNull();
    expect(
      publicView.data.executions.map((execution: any) => ({
        executionId: execution.executionId,
        skillExecution: execution.skillExecution,
      })),
    ).toEqual([
      { executionId: prepared.executionId, skillExecution: true },
      { executionId: ordinary.executionId, skillExecution: false },
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
      await page.goto(
        process.env.V3_LOCAL_APP +
          "/login?redirect=" +
          encodeURIComponent("/runtime?session=" + work.sessionId),
      );
      await page.getByPlaceholder("name@example.com").fill(f.email);
      await page.getByPlaceholder("输入你的密码").fill(f.password);
      await page
        .getByRole("button", { name: "登录", exact: true })
        .last()
        .click();
      await page.waitForURL((url) => url.pathname === "/runtime");
      await expect
        .poll(
          () =>
            page
              .getByRole("button", { name: "保存 Skill 成果", exact: true })
              .count(),
          { timeout: 15000 },
        )
        .toBe(1);
      await page
        .getByRole("button", { name: "保存 Skill 成果", exact: true })
        .click();
      await page.getByText("已保存成果 · 第 1 版", { exact: true }).waitFor();
    } finally {
      await browser.close();
    }
    const saved = await f.service.saveWorkResult(prepared.executionId);
    expect(await f.service.saveWorkResult(prepared.executionId)).toEqual(saved);
    await expect(f.service.saveWorkResult(ordinary.executionId)).rejects.toThrow();
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
    expect(calls).toBe(2);
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
}, 300000);
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
    // The published revision is the only authority for a field's elicitation
    // role: a declared role survives publication and read unchanged, and a
    // revision that declares nothing stays valid without inventing one.
    const storedWorkflow = (
      await sql.query("select workflow from artifact_rounds where id=$1", [d.roundId])
    ).rows[0].workflow;
    for (const [index, step] of input.steps.entries()) {
      const published = storedWorkflow.steps[index].information as any[];
      expect(published).toHaveLength(step.information.length);
      step.information.forEach((field: any, fieldIndex: number) => {
        expect(published[fieldIndex].id).toBe(field.id);
        if (field.elicitation === undefined)
          expect(published[fieldIndex]).not.toHaveProperty("elicitation");
        else expect(published[fieldIndex].elicitation).toBe(field.elicitation);
      });
    }
    for (const [index, step] of input.steps.entries()) {
      const readSchema = first.information[`step-${index + 1}`].schema as any[];
      expect(readSchema).toHaveLength(step.information.length);
      step.information.forEach((field: any, fieldIndex: number) => {
        expect(readSchema[fieldIndex].id).toBe(field.id);
        if (field.elicitation === undefined)
          expect(readSchema[fieldIndex]).not.toHaveProperty("elicitation");
        else expect(readSchema[fieldIndex].elicitation).toBe(field.elicitation);
      });
    }
    // Per-field equality above only proves agreement with whatever the input
    // declared. These counts make the input's own composition visible from
    // inside the run, so a derived copy that declared nothing cannot pass by
    // agreeing with nothing. Nothing here is hardcoded: every count comes from
    // the loaded input or from a stored/read surface.
    const roleCounts = (fields: any[]) => {
      const counts = {
        agent_proposal: 0,
        user_fact: 0,
        undeclared: 0,
        total: fields.length,
      };
      for (const field of fields)
        if (field?.elicitation === "agent_proposal") counts.agent_proposal += 1;
        else if (field?.elicitation === "user_fact") counts.user_fact += 1;
        else counts.undeclared += 1;
      return counts;
    };
    const inputCounts = roleCounts(
      input.steps.flatMap((step: any) => step.information),
    );
    const storedCounts = roleCounts(
      storedWorkflow.steps.flatMap((step: any) => step.information),
    );
    const readCounts = roleCounts(
      input.steps.flatMap(
        (_step: any, index: number) =>
          first.information[`step-${index + 1}`].schema as any[],
      ),
    );
    for (const counts of [inputCounts, storedCounts, readCounts])
      expect(
        counts.agent_proposal + counts.user_fact + counts.undeclared,
      ).toBe(counts.total);
    expect(storedCounts).toEqual(inputCounts);
    expect(readCounts).toEqual(inputCounts);
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
        // Counts only, never ids/titles/bodies: the original unmodified input
        // must report every field undeclared, a derived copy must report its
        // own explicit split.
        elicitation: {
          input: inputCounts,
          stored: storedCounts,
          read: readCounts,
        },
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
  await expect(f.service.prepareStep({draftId:d.draftId,requestId:randomUUID(),stepId:"step-1",purpose:"mentor",input:"premature discussion"})).rejects.toThrow("OPC_DEPENDENCIES_UNCONFIRMED");
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

it("OPC: one mentor conversation persists across steps, refresh and original Session recovery", async () => {
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
    // Await actual hydration, including the authenticated OPC response; URL
    // navigation alone completes before the form exists under a cold build.
    await page.getByRole("textbox", { name: f.flow.steps[0].information![0].title, exact: true })
      .waitFor({state:"visible",timeout:30000});
    expect(await page.getByRole("textbox", {name:"给导师的回复"}).isVisible()).toBe(true);
    async function expectOpening(label: string, title: string) {
      const paragraph = page.getByRole("log", { name: "完整导师消息" })
        .getByText(`导师主动引导 · ${label}`, { exact: true })
        .locator("..").locator("p");
      await expect.poll(() => paragraph.textContent(), { timeout: 30000 })
        .toContain(`“${title}”`);
    }
    // No fill, send, reload or manual refetch is allowed to reveal this opening.
    await expectOpening("1.1", f.flow.steps[0].information![0].title);
    await page.getByRole("textbox", {name:f.flow.steps[0].information![0].title,exact:true}).fill("尚未确定的用户想法");
    const order = await page.evaluate(() => {
      const form = document.querySelector('[aria-label="本步填写信息"]')!;
      const chat = document.querySelector('[aria-label="全程导师聊天"]')!;
      return Boolean(chat.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
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
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await page.getByRole("alert").filter({ hasText: "操作未完成" }).waitFor();
    expect(await page.getByRole("button", { name: "发送", exact: true }).isEnabled()).toBe(false);
    // Simulate a newer unsent buffer retained across an interrupted render.
    // Recovery must use the original envelope, not a new send identity.
    await page.evaluate((id) => {
      const key = "opc-edit:" + id;
      const saved = JSON.parse(sessionStorage.getItem(key)!);
      saved.mentorInput = "恢复期间另写的未发送内容";
      sessionStorage.setItem(key, JSON.stringify(saved));
    }, draftId);
    await page.reload();
    await page.getByRole("button", { name: "继续核对这条原请求", exact: true }).click();
    await expect.poll(() => page.getByRole("log", { name: "完整导师消息" })
      .getByText("导师 · 1.1", { exact: true }).count(), { timeout: 30000 }).toBe(1);
    expect(
      await page
        .getByRole("textbox", { name: "给导师的回复", exact: true })
        .inputValue(),
    ).toBe("恢复期间另写的未发送内容");
    const d = await f.service.read(draftId);
    expect(d.sessionId).toBeTruthy();
    expect(d.information["step-0"].values.goal).toMatchObject({value:"尚未确定的用户想法",status:"provisional"});
    for (const reply of ["我想帮助刚接触短视频的人", "我担心自己没有可以教的经验"]) {
      await page.getByRole("textbox",{name:"给导师的回复",exact:true}).fill(reply);
      await page.getByRole("button",{name:"发送",exact:true}).click();
      await expect.poll(() => page.getByRole("textbox",{name:"给导师的回复",exact:true}).inputValue(), {timeout:15000}).toBe("");
    }
    const count = await fetch(process.env.V3_LOCAL_REST!+"/__runtime_count", {headers:{"x-local-control":process.env.V3_LOCAL_CONTROL!}});
    const observed = await count.json();
    expect(observed.userRequests).toEqual(expect.arrayContaining(["我想先明确我的受众", "我想帮助刚接触短视频的人", "我担心自己没有可以教的经验"]));
    const afterChat = await f.service.read(draftId);
    const frozenChat = await sql.query("select payload from runtime_executions where actor_id=$1 order by created_at desc limit 1", [f.actor]);
    expect(frozenChat.rows[0].payload.instructions).toContain("single continuous mentor");
    expect(frozenChat.rows[0].payload.instructions).toContain("Confirmed fields do not end the conversation");
    expect(frozenChat.rows[0].payload.scopeMaterial.content.brief).toBe("mentor:step-0");
    await expect(f.service.saveResult({draftId,stepId:"step-0",executionId:afterChat.turns[0].executionId,requestId:randomUUID()})).rejects.toThrow("OPC_RESULT_DENIED");
    expect(afterChat.information["step-0"].values.goal.status).toBe("provisional");
    expect(afterChat.snapshot.candidates).toHaveLength(0);
    expect(afterChat.snapshot.steps["step-0"].valid).toBe(false);
    expect(afterChat.turns.filter((t: {stepId:string;kind:string})=>t.stepId==="step-0"&&t.kind==="mentor")).toHaveLength(3);
    const box = await page.getByRole("log",{name:"完整导师消息"}).boundingBox();
    expect(box!.height).toBeLessThanOrEqual(400);
    await page.reload();
    await expect
      .poll(
        () =>
          page
            .getByRole("log", { name: "完整导师消息" })
            .textContent(),
        { timeout: 15000 },
      )
      .toContain("我想帮助刚接触短视频的人");
    const first = f.flow.steps[0];
    await f.artifacts.execute({
      action: "save",
      projectId: d.projectId,
      roundId: d.roundId,
      requestId: randomUUID(),
      stepId: first.id,
      body: "User confirmed first step",
      evidenceIds: [],
      expectedVersion: afterChat.snapshot.steps[first.id].version,
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
    const sharedLog = page.getByRole("log", { name: "完整导师消息" });
    // The step response and Session history are separate authenticated reads.
    // Wait for the history itself before comparing it across navigation.
    await expect.poll(()=>sharedLog.textContent(),{timeout:15000}).toContain("我担心自己没有可以教的经验");
    await page
      .getByRole("textbox", { name: "给导师的回复", exact: true })
      .fill("跨步骤保留的未发送内容");
    await nextButton.click();
    const formPanel = page.locator("section[aria-label='本步填写信息']");
    // The current question carries its own hierarchical identity.
    await expect.poll(() => formPanel.textContent(), { timeout: 20000 }).toContain("2.1");
    expect(await sharedLog.textContent()).toContain("我担心自己没有可以教的经验");
    // The Agent opens the newly reached question itself; the host never
    // fabricates a user message to trigger it.
    await expectOpening("2.1", f.flow.steps[1].information![0].title);
    expect(
      await page
        .getByRole("textbox", { name: "给导师的回复", exact: true })
        .inputValue(),
    ).toBe("跨步骤保留的未发送内容");
    await page
      .getByRole("textbox", { name: "给导师的回复" })
      .fill("我有两个参考账号");
    await page
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await page.getByRole("log", { name: "完整导师消息" })
      .getByText("导师 · 2.1", { exact: true }).waitFor();
    const secondField = f.flow.steps[1].information![0];
    await expect
      .poll(() =>
        page
          .getByRole("textbox", { name: secondField.title, exact: true })
          .inputValue(),
        { timeout: 15_000 },
      )
      .toBe("我有两个参考账号");
    await expect.poll(async () =>
      (await f.service.read(draftId)).information["step-1"].values?.goal?.status,
      {timeout:15000},
    ).toBe("provisional");
    const afterSecondChat = await f.service.read(draftId);
    const secondTurn = afterSecondChat.turns.find(
      (turn: { executionId: string; stepId: string; kind: string }) =>
        turn.stepId === "step-1" && turn.kind === "mentor",
    );
    expect(secondTurn).toBeTruthy();
    const dependencies = new Set(
      (
        await sql.query(
          "select dependency_id::text id from runtime_history_dependencies where execution_id=$1",
          [secondTurn.executionId],
        )
      ).rows.map((row: { id: string }) => row.id),
    );
    for (const prior of afterChat.turns.filter(
      (turn: { executionId: string; stepId: string; kind: string }) =>
        turn.stepId === "step-0" && turn.kind === "mentor",
    ))
      expect(dependencies.has(prior.executionId)).toBe(true);
    const expectedBeforeRevision: ExpectedMentorEffect[] = [
      { stepId: "step-0", questionId: "goal", opening: true, input: OPENING_INPUT },
      { stepId: "step-1", questionId: "goal", opening: true, input: OPENING_INPUT },
      ...["我想先明确我的受众", "我想帮助刚接触短视频的人", "我担心自己没有可以教的经验"]
        .map(input => ({ stepId: "step-0", questionId: "goal", opening: false, input })),
      { stepId: "step-1", questionId: "goal", opening: false, input: "我有两个参考账号" },
    ];
    const beforeRecoveryEffects = await expectExactMentorEffects(
      f.actor, draftId, d.roundId, expectedBeforeRevision,
    );
    const conversationAfterSecondStep = await sharedLog.textContent();
    expect(conversationAfterSecondStep).toContain("我想帮助刚接触短视频的人");
    expect(conversationAfterSecondStep).toContain("我有两个参考账号");
    const stepNavigation = page.getByRole("navigation", { name: "定位步骤" });
    await stepNavigation.getByRole("button").nth(0).click();
    // Reviewing an already confirmed question restores it without dispatching.
    await expect.poll(() => page.locator("section[aria-label='本步填写信息']").textContent()).toContain("1.1");
    expect(await sharedLog.textContent()).toBe(conversationAfterSecondStep);
    await stepNavigation.getByRole("button").nth(1).click();
    expect(await sharedLog.textContent()).toBe(conversationAfterSecondStep);
    await page.reload();
    await page.getByRole("log", { name: "完整导师消息" })
      .getByText("导师 · 2.1", { exact: true }).waitFor();
    await context.clearCookies();
    await page.goto(process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(new URL(draftUrl).pathname));
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", {name:"登录",exact:true}).last().click();
    await page.waitForURL(draftUrl,{timeout:90000});
    await page.getByRole("log", { name: "完整导师消息" })
      .getByText("导师 · 2.1", { exact: true }).waitFor();
    expect((await f.service.read(draftId)).sessionId).toBe(d.sessionId);
    expect(await page.getByRole("log",{name:"完整导师消息"}).textContent()).toContain("我想帮助刚接触短视频的人");
    expect(
      await page
        .getByRole("textbox", {
          name: f.flow.steps[0].title + " 工作稿",
          exact: true,
        })
        .count(),
    ).toBe(0);
    // Four user messages plus two distinct step openings: exactly six effects,
    // with identical execution/request/billing IDs after refresh and re-login.
    expect(await expectExactMentorEffects(f.actor, draftId, d.roundId, expectedBeforeRevision))
      .toEqual(beforeRecoveryEffects);
    // A model-proposed cross-step change stays separate until explicit acceptance.
    await page.getByRole("textbox", {name:"给导师的回复"}).fill("模拟：修改第一步目标");
    await page.getByRole("button", {name:"发送",exact:true}).click();
    await expect.poll(()=>page.getByRole("textbox",{name:"给导师的回复"}).inputValue(),{timeout:15000}).toBe("");
    await page.getByText("已知目标 0：改为帮助独立开发者",{exact:true}).waitFor();
    const adopt = page.getByRole("button", {name:'采用这些修改到“'+f.flow.steps[0].title+'”',exact:true});
    await adopt.waitFor();
    expect((await f.service.read(draftId)).information["step-0"].values.goal.value).toBe("A concrete user decision");
    await adopt.click();
    await expect.poll(async() => (await f.service.read(draftId)).information["step-0"].values.goal.value).toBe("改为帮助独立开发者");
    await page.reload();
    // Explicitly reopen the revised step after reload before inspecting its
    // form; do not assume the asynchronous selection was already persisted.
    await page.getByRole("navigation", {name:"定位步骤"}).getByRole("button").nth(0).click({timeout:15000});
    await expect.poll(()=>page.getByRole("textbox",{name:f.flow.steps[0].information![0].title,exact:true}).inputValue({timeout:15000})).toBe("改为帮助独立开发者");
    expect((await f.service.read(draftId)).sessionId).toBe(d.sessionId);
    const finalEffects = await expectExactMentorEffects(f.actor, draftId, d.roundId, [
      ...expectedBeforeRevision,
      { stepId: "step-1", questionId: "goal", opening: false, input: "模拟：修改第一步目标" },
    ]);
    expect(finalEffects.filter(identity => beforeRecoveryEffects.includes(identity)))
      .toEqual(beforeRecoveryEffects);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: browser confirms the autosaved form as the step result without a duplicate model pass and recovers once", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3);
  const providerCount = async () => {
    const response = await fetch(process.env.V3_LOCAL_REST! + "/__runtime_count", {
      headers: { "x-local-control": process.env.V3_LOCAL_CONTROL! },
    });
    if (!response.ok) throw new Error("local fixture counter unavailable");
    return (await response.json()).calls as number;
  };
  const callsBefore = await providerCount();
  const browserModel = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-browser','fixture','true',1000,32000)",
    [browserModel],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [
    browserModel,
    f.moduleId,
  ]);
  const summaryModel = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'OPC organizer','opc-organizer','fixture','true',1000,32000)",
    [summaryModel],
  );
  await sql.query(
    "insert into system_settings(key,value) values('v3_summary_model_id',to_jsonb($1::text)),('v3_summary_max_tokens','1000'::jsonb) on conflict(key) do update set value=excluded.value",
    [summaryModel],
  );
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
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const ready = page.waitForResponse(
      (r) => r.url().includes("/api/trpc/settings.getSystemSettings") && r.ok(),
      { timeout: 90000 },
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

    const draftId = new URL(page.url()).pathname.split("/").at(-1)!;
    async function expectOpening(label: string, title: string) {
      const paragraph = page.getByRole("log", { name: "完整导师消息" })
        .getByText(`导师主动引导 · ${label}`, { exact: true })
        .locator("..").locator("p");
      await expect.poll(() => paragraph.textContent(), { timeout: 30000 })
        .toContain(`“${title}”`);
    }
    await expectOpening("1.1", f.flow.steps[0].information![0].title);
    await expect.poll(() => page.getByRole("button", { name: /确认本题并继续|继续核对本题确认/, exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "确认所填信息并整理成果" }).count()).toBe(0);
    await expect(
      f.service.prepareStep({
        draftId,
        stepId: f.flow.steps[0].id,
        requestId: randomUUID(),
        organizeAfter: true,
        input: "organize",
      }),
    ).rejects.toThrow("OPC_INFORMATION_REQUIRED");
    const field = f.flow.steps[0].information![0];
    await page
      .getByRole("textbox", { name: field.title, exact: true })
      .fill("用户亲自填写的经营目标");
    await expect
      .poll(() => page.getByText("已自动保存", { exact: true }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    let injectDefiniteConflict = true;
    await page.route("**/api/trpc/opc.information*", async (route) => {
      if (injectDefiniteConflict) {
        injectDefiniteConflict = false;
        const current = await f.service.read(draftId);
        await f.service.information({
          draftId,
          stepId: f.flow.steps[0].id,
          requestId: randomUUID(),
          expectedVersion: current.snapshot.steps[f.flow.steps[0].id].version,
          values: {
            goal: {
              status: "confirmed",
              nature: "decision",
              value: "用户亲自填写的经营目标",
            },
          },
        });
      }
      await route.continue();
    });
    await page
      .getByRole("button", { name: /确认本题并继续|继续核对本题确认/, exact: true })
      .click();
    const operationAlert = page
      .getByRole("alert")
      .filter({ hasText: "操作未完成" });
    await operationAlert.waitFor();
    await expect
      .poll(() =>
        page.evaluate(
          (storageKey) => sessionStorage.getItem(storageKey),
          `opc-confirm-step:${draftId}:${f.flow.steps[0].id}`,
        ),
      )
      .toBeNull();
    await page.unroute("**/api/trpc/opc.information*");
    let lost = true;
    await page.route("**/api/trpc/workbench.execute*", async (route) => {
      if (!lost) return route.continue();
      lost = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort();
    });
    const priorConflictCleared = operationAlert.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: /确认本题并继续|继续核对本题确认/, exact: true })
      .click();
    await priorConflictCleared;
    await operationAlert.waitFor();
    await expect
      .poll(() =>
        page.evaluate(
          (storageKey) => {
            const raw = sessionStorage.getItem(storageKey);
            return raw ? JSON.parse(raw).phase : null;
          },
          `opc-confirm-step:${draftId}:${f.flow.steps[0].id}`,
        ),
      )
      .toBe("save");
    await page.reload();
    await page
      .getByRole("button", { name: /确认本题并继续|继续核对本题确认/, exact: true })
      .click();
    await page
      .getByRole("textbox", {
        name: f.flow.steps[1].information![0].title,
        exact: true,
      })
      .waitFor();
    await expectOpening("2.1", f.flow.steps[1].information![0].title);
    const read = await f.service.read(draftId);
    expect(read.information[f.flow.steps[0].id].values.goal.value).toBe(
      "用户亲自填写的经营目标",
    );
    expect(read.snapshot.candidates).toHaveLength(0);
    expect(read.snapshot.steps[f.flow.steps[0].id].body).toContain(
      "用户亲自填写的经营目标",
    );
    expect(read.snapshot.steps[f.flow.steps[0].id].valid).toBe(true);
    await sql.query("update ai_models set is_active='false' where id=$1", [
      summaryModel,
    ]);
    // Saving, confirming and recovering the form do not make model calls.
    // Only the initial and newly reached question each have one opening.
    await expectExactMentorEffects(f.actor,draftId,read.roundId,[
      {stepId:"step-0",questionId:"goal",opening:true,input:OPENING_INPUT},
      {stepId:"step-1",questionId:"goal",opening:true,input:OPENING_INPUT},
    ]);
    expect(await providerCount() - callsBefore).toBe(2);
    expect(await page.getByRole("textbox", { name: f.flow.steps[0].title + " 工作稿" }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: browser stale account confirmation restarts only after definite rejection", async () => {
  const {chromium}=await import("../../../../../apps/web/node_modules/@playwright/test");
  const f=await completed(3);
  const saved=await f.service.savePlan({draftId:f.d.draftId,sourceVersionId:f.sourceVersionId,requestId:randomUUID(),expectedVersion:0,body:[{id:randomUUID(),platform:"x",account:"stale-browser",day:"2026-09-15",title:"Topic",brief:"Brief"}]});
  const request={draftId:f.d.draftId,planId:saved.planId,requestId:randomUUID(),accounts:[{platform:"x",account:"stale-browser",expectedRevision:null}]};
  await f.service.handoff(request);
  const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}),context=await browser.newContext(),page=await context.newPage();
  page.setDefaultTimeout(90000);
  try {
    const url=process.env.V3_LOCAL_APP+"/positioning/"+f.d.draftId+"/plan";
    await page.goto(process.env.V3_LOCAL_APP+"/login?redirect="+encodeURIComponent(new URL(url).pathname));
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button",{name:"登录",exact:true}).last().click();
    await page.waitForURL(url);
    const button=page.getByRole("button",{name:"确认账号与计划，创建选题",exact:true});
    await button.waitFor();
    await expect.poll(()=>button.isEnabled(),{timeout:15000}).toBe(true);
    await f.service.handoff({...request,requestId:randomUUID(),accounts:[{...request.accounts[0],expectedRevision:1}]});
    const failed=page.waitForResponse(r=>r.url().includes("/api/trpc/opc.handoff"));
    await button.click();await failed;
    await page.getByRole("alert").filter({hasText:"操作未完成"}).waitFor();
    await page.getByRole("button",{name:"重新读取状态",exact:true}).click();
    await expect.poll(()=>button.isEnabled(),{timeout:15000}).toBe(true);
    await button.click();
    await expect.poll(async()=>Number((await sql.query('select revision from opc_accounts where actor_id=$1',[f.actor])).rows[0].revision),{timeout:15000}).toBe(3);
    expect((await sql.query('select count(*)::int n from opc_items i join artifact_projects p on p.id=i.work_item_id where p.actor_id=$1',[f.actor])).rows[0].n).toBe(1);
    expect((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1',[f.actor])).rows[0].n).toBe(0);
  }finally{await browser.close();}
},180000);

it.runIf(process.env.V3_LOCAL_STAGING_HOST === "true")(
  "OPC: staging host protected browser route uses the bounded official protocol once",
  async () => {
    const { chromium } =
      await import("../../../../../apps/web/node_modules/@playwright/test");
    const f = await fixture(3),
      modelId = randomUUID(),
      key = "LOCAL_STAGING_" + randomUUID(),
      windowId = process.env.V3_RUNTIME_STAGING_WINDOW_ID!;
    expect(windowId).toMatch(/^[a-f0-9-]{36}$/);
    const callPolicy = {
      modelId,
      provider: "openrouter",
      account:
        "openrouter-key:" + createHash("sha256").update(key).digest("hex"),
      model: "test/opc-staging",
      protocol: "openrouter-chat-v1",
      upperUsd: "0.02",
      inputLimit: 8000,
      outputLimit: 100,
      automaticRetry: false,
      hiddenTools: false,
      lookupSupported: true,
      providerLimits: {
        providerSlug: "synthetic",
        contextTokens: 10000,
        promptUsdPerMillion: "2",
        completionUsdPerMillion: "0",
        requestUsd: "0",
      },
    };
    await sql.query(
      "insert into ai_models(id,name,model_id,provider,is_active,api_endpoint,api_key,max_tokens,input_limit) values($1,'Synthetic Staging OPC','test/opc-staging','openai','true','https://openrouter.ai/api/v1',$2,1000,10000)",
      [modelId, key],
    );
    await sql.query("update modules set model_id=$1 where id=$2", [
      modelId,
      f.moduleId,
    ]);
    await sql.query(
      "insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,0.02,1,now()+interval '2 hours')",
      [windowId, [f.actor], JSON.stringify([callPolicy])],
    );
    const draft = await f.service.start({
      requestId: randomUUID(),
      registration: f.registration,
      mode: "mentor",
    });
    const browser = await chromium.launch({
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    try {
      const context = await browser.newContext();
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "syntheticstaging.supabase.co") {
          const response = await route.fetch({
            url: process.env.V3_LOCAL_REST + url.pathname + url.search,
          });
          await route.fulfill({ response });
          return;
        }
        if (
          ["127.0.0.1", "localhost"].includes(url.hostname) ||
          ["data:", "blob:"].includes(url.protocol)
        ) {
          await route.continue();
          return;
        }
        await route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(90000);
      const loginReady = page.waitForResponse(
        (response) =>
          response.url().includes("settings.getSystemSettings") &&
          response.ok(),
      );
      await page.goto(
        process.env.V3_LOCAL_APP +
          "/login?redirect=" +
          encodeURIComponent("/positioning/" + draft.draftId),
      );
      await loginReady;
      await page.getByPlaceholder("name@example.com").fill(f.email);
      await page.getByPlaceholder("输入你的密码").fill(f.password);
      await page
        .getByRole("button", { name: "登录", exact: true })
        .last()
        .click();
      await page.waitForURL(
        (url) => url.pathname === "/positioning/" + draft.draftId,
      );
      await page
        .getByText("Staging 真实模型测试 · 未开放联网研究", { exact: true })
        .waitFor();
      await page
        .getByRole("textbox", { name: "给导师的回复", exact: true })
        .fill("I want to teach photography beginners.");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      // The mentor prose now carries the host-derived hierarchical label.
      await page.getByText(/【分步模拟，仅验证流程】第 1\.1 题/).waitFor();
      expect(
        (
          await sql.query(
            "select state,charged,provider_cost_usd::text cost,test_window_id from bill2_runs where actor_id=$1",
            [f.actor],
          )
        ).rows,
      ).toEqual([
        {
          state: "settled",
          charged: 3,
          cost: "0.003",
          test_window_id: windowId,
        },
      ]);
      const count = await fetch(process.env.V3_LOCAL_REST + "/__runtime_count", {
        headers: { "x-local-control": process.env.V3_LOCAL_CONTROL! },
      });
      expect(count.ok).toBe(true);
      expect((await count.json()).calls).toBe(1);
    } finally {
      await browser.close();
    }
  },
  180000,
);

for (const scenario of ["fresh", "retry", "same-field", "offline", "response-lost"]) {
  const conflict=scenario!=="fresh";
  it(`OPC: two browser tabs preserve edits (${scenario})`, async () => {
    const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
    const f = await fixture(3, true);
    const draft = await f.service.start({requestId:randomUUID(),registration:f.registration,mode:"manual"});
    const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
    let release: (()=>void) | undefined;
    try {
      const context = await browser.newContext();
      await context.route("**/*",route => ["127.0.0.1","localhost"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      const a = await context.newPage();
      a.setDefaultTimeout(20000);
      const loginReady=a.waitForResponse(r=>r.url().includes("settings.getSystemSettings") && r.ok(),{timeout:90000});
      await a.goto(process.env.V3_LOCAL_APP+"/login?redirect=/positioning",{timeout:90000,waitUntil:"domcontentloaded"});
      await loginReady;
      await a.getByPlaceholder("name@example.com").fill(f.email);
      await a.getByPlaceholder("输入你的密码").fill(f.password);
      await a.getByRole("button",{name:"登录",exact:true}).last().click();
      await a.waitForURL(url=>url.pathname==="/positioning",{timeout:90000});
      const url=process.env.V3_LOCAL_APP+"/positioning/"+draft.draftId;
      await a.goto(url);
      if(scenario==="offline" || scenario==="response-lost") {
        await a.getByRole("textbox",{name:"已知目标 0",exact:true}).waitFor();
        const requests: string[]=[];
        let blocked=true, committed=false;
        await a.route("**/api/trpc/**",async route=>{
          if(route.request().method()==="POST" && route.request().url().includes("opc.information")) {
            requests.push(route.request().postData()!);
            if(blocked) {
              if(scenario==="response-lost" && !committed) { const response=await route.fetch(); expect(response.ok()).toBe(true);committed=true; }
              return route.abort("connectionreset");
            }
          }
          return route.continue();
        });
        await a.getByRole("textbox",{name:"已知目标 0",exact:true}).fill("Recover my original edit");
        await a.getByRole("button",{name:"重试自动保存",exact:true}).waitFor();
        const original=requests[0]; expect(original).toBeTruthy();
        expect((await sql.query("select count(*)::int n from artifact_requests where project_id=$1 and action='opc_information'",[draft.projectId])).rows[0].n).toBe(scenario==="response-lost"?1:0);
        await context.clearCookies();
        const readyAgain=a.waitForResponse(r=>r.url().includes("settings.getSystemSettings") && r.ok(),{timeout:90000});
        await a.goto(process.env.V3_LOCAL_APP+"/login?redirect="+encodeURIComponent(new URL(url).pathname));
        await readyAgain;
        await a.getByPlaceholder("name@example.com").fill(f.email);
        await a.getByPlaceholder("输入你的密码").fill(f.password);
        await a.getByRole("button",{name:"登录",exact:true}).last().click();
        await a.waitForURL(url,{timeout:90000});
        await a.getByRole("button",{name:"重试自动保存",exact:true}).waitFor();
        expect(await a.getByRole("textbox",{name:"已知目标 0",exact:true}).inputValue()).toBe("Recover my original edit");
        blocked=false;
        await a.getByRole("button",{name:"重试自动保存",exact:true}).click();
        await expect.poll(async()=> (await f.service.read(draft.draftId)).information["step-0"].values?.goal?.value,{timeout:20000}).toBe("Recover my original edit");
        await expect.poll(()=>a.getByRole("button",{name:"重试自动保存",exact:true}).count()).toBe(0);
        expect(new Set(requests).size).toBe(1);
        expect((await sql.query("select count(*)::int n from artifact_requests where project_id=$1 and action='opc_information'",[draft.projectId])).rows[0].n).toBe(1);
        expect((await f.service.read(draft.draftId)).sessionId).toBe(draft.sessionId);
        return;
      }
      // B reaches its next question only after A explicitly confirms the first.
      await a.getByRole("textbox",{name:"已知目标 0",exact:true}).fill("Initially confirmed goal");
      await a.getByRole("button",{name:"确认本题并继续",exact:true}).click();
      await a.getByRole("textbox",{name:"Second independent field",exact:true}).waitFor();
      const b=await context.newPage(); b.setDefaultTimeout(20000); await b.goto(url);
      await b.getByRole("textbox",{name:"Second independent field",exact:true}).waitFor();
      // The ordered navigator names each reached row with its hierarchical
      // question number and its own answer status.
      await a.getByRole("button",{name:/^1\.1 已知目标 0 · 已确认/}).click();
      if(scenario==="same-field") await b.getByRole("button",{name:/^1\.1 已知目标 0 · 已确认/}).click();
      await a.getByRole("textbox",{name:"已知目标 0",exact:true}).waitFor();
      const held=new Promise<void>(resolve=>{release=resolve;});
      let reached!:()=>void;
      const intercepted=new Promise<void>(resolve=>{reached=resolve;});
      // Hold either B's fresh-version read or its first write, not the backend.
      let once=true;
      await b.route("**/api/trpc/**",async route=>{
        const req=route.request();
        if(once && (conflict ? req.method()==="POST" && req.url().includes("opc.information") : req.method()==="GET" && req.url().includes("opc.read"))) {
          once=false; reached(); await held;
        }
        await route.continue();
      });
      await b.getByRole("textbox",{name:scenario==="same-field" ? "已知目标 0" : "Second independent field",exact:true}).fill("B original edit");
      await Promise.race([intercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error("autosave barrier not reached")),20000))]);
      await a.getByRole("textbox",{name:"已知目标 0",exact:true}).fill("A saved independently");
      await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.goal?.value,{timeout:20000}).toBe("A saved independently");
      release!();
      if(scenario==="same-field") {
        await b.getByText("其他窗口修改了相同字段。你的输入未提交，请比较后决定。",{exact:true}).waitFor();
        expect((await f.service.read(draft.draftId)).information["step-0"].values.goal.value).toBe("A saved independently");
        await b.reload();
        await b.getByText("其他窗口修改了相同字段。你的输入未提交，请比较后决定。",{exact:true}).waitFor();
        expect(await b.getByRole("textbox",{name:"已知目标 0",exact:true}).inputValue()).toBe("B original edit");
        await b.getByRole("button",{name:"保留我的这些修改并重新保存",exact:true}).click();
        await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.goal?.value,{timeout:20000}).toBe("B original edit");
        return;
      }
      await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.other?.value,{timeout:20000}).toBe("B original edit");
      expect((await f.service.read(draft.draftId)).information["step-0"].values.goal.value).toBe("A saved independently");
    } finally { release?.(); await browser.close(); }
  },180000);
}


it("OPC: question-by-question confirmation keeps mentor, receipt recovery and hidden fields aligned", async () => {
  const {chromium} = await import("../../../../../apps/web/node_modules/@playwright/test");
  const f=await fixture(3,true), model=randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Question local','opc-question','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:"mentor"});
  for (const questionId of ["other", "unknown-question", "constructor"])
    await expect(f.service.prepareStep({draftId:draft.draftId,stepId:"step-0",purpose:"mentor",questionId,requestId:randomUUID(),input:"premature"})).rejects.toThrow("OPC_QUESTION_NOT_REACHED");
  await expect(f.service.prepareStep({draftId:draft.draftId,stepId:"step-0",purpose:"mentor",questionId:17,requestId:randomUUID(),input:"invalid"})).rejects.toThrow();
  expect((await sql.query("select count(*)::int n from bill2_runs where actor_id=$1",[f.actor])).rows[0].n).toBe(0);
  expect((await f.service.read(draft.draftId)).turns).toHaveLength(0);
  const browser=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  let release: (()=>void)|undefined;
  try {
    const url=process.env.V3_LOCAL_APP+"/positioning/"+draft.draftId;
    async function login() {
      const context=await browser.newContext();
      await context.route("**/*",route=>["127.0.0.1","localhost"].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
      const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(90000);
      const ready=page.waitForResponse(r=>r.url().includes("settings.getSystemSettings")&&r.ok(),{timeout:90000});
      await page.goto(process.env.V3_LOCAL_APP+"/login?redirect="+encodeURIComponent(new URL(url).pathname));await ready;
      await page.getByPlaceholder("name@example.com").fill(f.email);await page.getByPlaceholder("输入你的密码").fill(f.password);
      await page.getByRole("button",{name:"登录",exact:true}).last().click();await page.waitForURL(url);return {context,page};
    }
    const {page}=await login();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    const first=()=>page.getByRole("textbox",{name:"已知目标 0",exact:true});
    const second=()=>page.getByRole("textbox",{name:"Second independent field",exact:true});
    const composer=()=>page.getByRole("textbox",{name:"给导师的回复",exact:true});
    await first().waitFor();expect(await second().count()).toBe(0);
    async function expectOpening(label: string, title: string) {
      const paragraph = page.getByRole("log", { name: "完整导师消息" })
        .getByText(`导师主动引导 · ${label}`, { exact: true })
        .locator("..").locator("p");
      await expect.poll(() => paragraph.textContent(), { timeout: 30000 })
        .toContain(`“${title}”`);
    }
    // The first actual mentor message must appear while the user is idle.
    await expectOpening("1.1", "已知目标 0");
    expect(await page.locator("body").textContent()).not.toContain("Second independent field");
    expect(await page.getByRole("button",{name:"确认本题并继续",exact:true}).isVisible()).toBe(true);
    expect(await page.getByRole("button",{name:"确认本题并继续",exact:true}).evaluate(el=>Boolean(el.closest("details")))).toBe(false);
    const admissions:any[]=[];const informationWrites:string[]=[];
    page.on("request",r=>{
      if(r.method()==="POST"&&r.url().includes("opc.prepareStep")){const body=r.postDataJSON();const v=body[0]??body;admissions.push(v.json??v);}
      if(r.method()==="POST"&&r.url().includes("opc.information")) {
        informationWrites.push(r.postData()??"");
      }
    });
    async function send(text:string){await composer().fill(text);await page.getByRole("button",{name:"发送",exact:true}).click();await expect.poll(()=>composer().inputValue(),{timeout:30000}).toBe("");}
    await send("我做 AI 赛道");
    await expect.poll(()=>first().inputValue()).toBe("我做 AI 赛道");
    // Autosave includes a 700ms debounce plus a fresh read and the write.
    await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.goal?.status,{timeout:30000}).toBe("provisional");
    expect(await second().count()).toBe(0);
    await send("不知道呢");await page.getByText("还没想清楚没关系",{exact:false}).waitFor();
    expect(await first().inputValue()).toBe("我做 AI 赛道");expect(await second().count()).toBe(0);
    const held=new Promise<void>(resolve=>{release=resolve;});let reached!:()=>void;
    const intercepted=new Promise<void>(resolve=>{reached=resolve;});const confirmations:string[]=[];let hold=true;
    await page.route("**/api/trpc/opc.information*",async route=>{
      const raw=route.request().postData()??"";
      if(raw.includes('"status":"confirmed"')) {
        confirmations.push(raw);
        if(hold){hold=false;const response=await route.fetch();expect(response.ok()).toBe(true);reached();await held;return route.abort("connectionreset");}
      }
      return route.continue();
    });
    await page.getByRole("button",{name:"确认本题并继续",exact:true}).click();
    await Promise.race([intercepted,new Promise((_,reject)=>setTimeout(()=>reject(new Error("confirmation barrier not reached")),30000))]);
    expect(await second().count()).toBe(0);expect(await first().isVisible()).toBe(true);
    expect(confirmations).toHaveLength(1);release!();
    await page.getByRole("alert").filter({hasText:"操作未完成"}).waitFor();
    await page.reload();await first().waitFor();expect(await second().count()).toBe(0);
    await page.getByRole("button",{name:"继续核对本题确认",exact:true}).click();
    await second().waitFor();expect(await first().count()).toBe(0);expect(confirmations).toHaveLength(2);expect(new Set(confirmations).size).toBe(1);
    await page.unroute("**/api/trpc/opc.information*");
    // The current question carries its hierarchical identity in the form itself,
    // instead of a static guide card repeating the step name.
    const form = page.locator("section[aria-label='本步填写信息']");
    await expect.poll(() => form.textContent()).toContain("1.2");
    expect(await form.textContent()).toContain("Second independent field");
    await expectOpening("1.2", "Second independent field");
    expect(await page.getByRole("status", { name: "当前导师任务" }).count()).toBe(0);
    expect((await f.service.read(draft.draftId)).snapshot.steps["step-0"].valid).toBe(false);
    await page.getByRole("button", {name:/^1\.1 已知目标 0 · 已确认/}).click();
    expect(await first().inputValue()).toBe("我做 AI 赛道");
    expect(await page.getByRole("button", {name:"确认本题并继续",exact:true}).isEnabled()).toBe(false);
    await page.getByRole("button", {name:"继续当前待确认问题",exact:true}).click();
    await second().waitFor();
    await send("摄影课程");await expect.poll(()=>second().inputValue()).toBe("摄影课程");
    // The 700ms debounce plus authenticated read/write is not a 1000ms
    // operation. Keep an explicit upper bound and assert durable content, not
    // just that a matching HTTP request was sent.
    await expect.poll(()=>informationWrites.some(raw=>raw.includes('"other"')&&raw.includes('"摄影课程"')&&raw.includes('"status":"provisional"')),{timeout:30000}).toBe(true);
    await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.other,{timeout:30000})
      .toEqual({value:"摄影课程",nature:"hypothesis",status:"provisional"});
    const before=await f.service.read(draft.draftId);expect(before.information["step-0"].values.goal.value).toBe("我做 AI 赛道");
    expect(admissions.at(-1).questionId).toBe("other");
    const original=await f.service.prepareStep(admissions.at(-1));
    await f.service.information({draftId:draft.draftId,stepId:"step-0",requestId:randomUUID(),expectedVersion:before.snapshot.steps["step-0"].version,values:{...before.information["step-0"].values,goal:{...before.information["step-0"].values.goal,status:"provisional"}}});
    expect((await f.service.prepareStep(admissions.at(-1))).executionId).toBe(original.executionId);
    await expect(f.service.prepareStep({...admissions.at(-1),questionId:"goal"})).rejects.toThrow("OPC_REQUEST_CONFLICT");
    const revised=await f.service.read(draft.draftId);
    await f.service.information({draftId:draft.draftId,stepId:"step-0",requestId:randomUUID(),expectedVersion:revised.snapshot.steps["step-0"].version,values:before.information["step-0"].values});
    const expectedBeforeRecovery: ExpectedMentorEffect[] = [
      {stepId:"step-0",questionId:"goal",opening:true,input:OPENING_INPUT},
      {stepId:"step-0",questionId:"other",opening:true,input:OPENING_INPUT},
      {stepId:"step-0",questionId:"goal",opening:false,input:"我做 AI 赛道"},
      {stepId:"step-0",questionId:"goal",opening:false,input:"不知道呢"},
      {stepId:"step-0",questionId:"other",opening:false,input:"摄影课程"},
    ];
    const beforeRecoveryEffects=await expectExactMentorEffects(f.actor,draft.draftId,draft.roundId,expectedBeforeRecovery);
    const fresh=await login();await fresh.page.getByRole("textbox",{name:"Second independent field",exact:true}).waitFor();
    await expect.poll(()=>fresh.page.getByRole("log",{name:"完整导师消息"}).textContent()).toContain("我做 AI 赛道");
    await expect.poll(()=>fresh.page.getByRole("textbox",{name:"Second independent field",exact:true}).inputValue(),{timeout:30000}).toBe("摄影课程");
    expect((await f.service.read(draft.draftId)).information["step-0"].values.other)
      .toEqual({value:"摄影课程",nature:"hypothesis",status:"provisional"});
    await fresh.context.close();
    await page.reload();await second().waitFor();expect(await second().inputValue()).toBe("摄影课程");
    expect((await f.service.read(draft.draftId)).information["step-0"].values.other)
      .toEqual({value:"摄影课程",nature:"hypothesis",status:"provisional"});
    expect(await expectExactMentorEffects(f.actor,draft.draftId,draft.roundId,expectedBeforeRecovery))
      .toEqual(beforeRecoveryEffects);
    await page.getByRole("button",{name:"确认本题并继续",exact:true}).click();
    await page.getByRole("textbox",{name:"已知目标 1",exact:true}).waitFor();
    // Do not send another user message to make the new step's opening visible.
    await expectOpening("2.1", "已知目标 1");
    const result=await f.service.read(draft.draftId);expect(result.snapshot.steps["step-0"].valid).toBe(true);expect(result.sessionId).toBe(draft.sessionId);
    // The host opened the current question itself, and every stored turn keeps
    // the question identity it was asked under.
    const opened=result.turns.filter((turn:any)=>turn.kind==="opening");
    expect(opened.map((turn:{stepId:string;questionId:string|null})=>[turn.stepId,turn.questionId]))
      .toEqual([["step-0","goal"],["step-0","other"],["step-1","goal"]]);
    await expectExactMentorEffects(f.actor,draft.draftId,draft.roundId,[
      ...expectedBeforeRecovery,
      {stepId:"step-1",questionId:"goal",opening:true,input:OPENING_INPUT},
    ]);
    expect(result.turns.every((turn:any)=>turn.kind==="organizer"||Boolean(turn.questionId))).toBe(true);
    const runs=await sql.query("select payload from runtime_executions where actor_id=$1 order by created_at",[f.actor]);
    // The frozen mentor context carries the host-derived hierarchical label.
    expect(runs.rows.some(row=>row.payload.instructions.includes('Current information question: {"id":"other","title":"Second independent field","label":"1.2"}'))).toBe(true);
    expect(runs.rows.some(row=>row.payload.instructions.includes("opened by the host, not by the user"))).toBe(true);
    expect(errors).toEqual([]);
  } finally { release?.();await browser.close(); }
},300000);
it("OPC: the Agent opens the current question once per entry and plans without user-authored topic rows", async () => {
  const { runtimeExecutor } = await import("../runtime/execute");
  const { createServer } = await import("node:http");
  const { OPENING_INPUT, openingRequestId, questionLabel } =
    await import("../../shared/opcQuestions");
  const f = await fixture(2, true),
    model = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Opening local','opc-opening','fixture','true',1000,32000)",
    [model],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [model, f.moduleId]);
  const draft = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "mentor",
  });
  const schema = (await f.service.read(draft.draftId)).information["step-0"].schema;
  // Hierarchical identity comes from the method's declared field order.
  expect(questionLabel(0, schema, schema[0].id)).toBe("1.1");
  expect(questionLabel(0, schema, schema[1].id)).toBe("1.2");
  let calls = 0;
  const instructions: string[] = [];
  const server = createServer(async (req, res) => {
    calls++;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(JSON.parse(raw).input);
    instructions.push(
      typeof request.instructions === "string"
        ? request.instructions
        : (request.messages ?? [])
            .filter((m: { role: string }) => ["system", "developer"].includes(m.role))
            .map((m: { content: unknown }) =>
              typeof m.content === "string" ? m.content : "",
            )
            .join("\n"),
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "opening-" + calls,
        model: "opc-opening",
        final: true,
        cost: "0.003",
        currency: "USD",
        coverage: "request_total",
        usage: {
          sdkResponse: {
            id: "opening-" + calls,
            object: "chat.completion",
            created: 1,
            model: "opc-opening",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    message: "【隔离模拟】先把当前问题聊清楚。",
                    inputKind: "answer",
                    informationPatch: {},
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local server");
    const executor = runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint: "http://127.0.0.1:" + address.port,
    });
    const openingRequest = {
      draftId: draft.draftId,
      stepId: "step-0",
      purpose: "mentor" as const,
      requestId: openingRequestId(draft.draftId, draft.roundId, "step-0", schema[0].id),
      input: OPENING_INPUT,
      // The host always freezes the question it is opening with the request; the
      // turn's projected question/kind identity comes from that frozen value.
      questionId: schema[0].id,
    };
    const opening = await f.service.prepareStep(openingRequest);
    await executor.execute(opening.executionId);
    // A future question cannot be opened before the current one is confirmed.
    await expect(
      f.service.prepareStep({
        draftId: draft.draftId,
        stepId: "step-0",
        purpose: "mentor",
        requestId: randomUUID(),
        input: OPENING_INPUT,
        questionId: schema[1].id,
      }),
    ).rejects.toThrow("OPC_QUESTION_NOT_REACHED");
    // A NEW host opening that does not freeze the question it is opening is
    // malformed: it must fail closed instead of degrading into a generic mentor
    // turn, and it must not create any execution, BILL2 run or reservation.
    await expect(
      f.service.prepareStep({
        draftId: draft.draftId,
        stepId: "step-0",
        purpose: "mentor",
        requestId: randomUUID(),
        input: OPENING_INPUT,
      }),
    ).rejects.toThrow("OPC_QUESTION_NOT_REACHED");
    expect(
      (await sql.query("select count(*)::int n from runtime_executions where actor_id=$1", [f.actor])).rows[0].n,
    ).toBe(1);
    expect(
      (await sql.query("select count(*)::int n from bill2_runs where actor_id=$1", [f.actor])).rows[0].n,
    ).toBe(1);
    expect(
      (await sql.query("select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'", [f.actor])).rows[0].n,
    ).toBe(1);
    // Refresh, re-login or a second tab reuses the same entry identity.
    expect((await f.service.prepareStep(openingRequest)).executionId).toBe(
      opening.executionId,
    );
    await executor.execute(opening.executionId);
    expect(calls).toBe(1);
    const after = await f.service.read(draft.draftId);
    // The turn is owned by the draft's current round, and every other projected
    // value stays exact.
    expect(after.turns).toEqual([
      {
        executionId: opening.executionId,
        stepId: "step-0",
        questionId: schema[0].id,
        roundId: draft.roundId,
        kind: "opening",
      },
    ]);
    // The host marker is stored instead of fabricated user speech.
    const history = await admin.rpc("runtime_view", {
      p_actor_id: f.actor,
      p_session_id: draft.sessionId,
    });
    expect(history.error).toBeNull();
    expect(history.data.executions[0].input).toBe(OPENING_INPUT);
    expect(instructions[0]).toContain("opened by the host, not by the user");
    expect(instructions[0]).toContain('"elicit"');
    expect(instructions[0]).toContain("inputKind");
    // One entry is one charge.
    expect(
      (
        await sql.query("select count(*)::int n from bill2_runs where actor_id=$1", [
          f.actor,
        ])
      ).rows[0].n,
    ).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}, 180000);

it("OPC: a confirmed positioning produces an editable first-week plan candidate without user-authored rows", async () => {
  const { runtimeExecutor } = await import("../runtime/execute");
  const { createServer } = await import("node:http");
  const f = await completed(2),
    model = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Plan local','opc-plan-free','fixture','true',1000,32000)",
    [model],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [model, f.moduleId]);
  // The user supplies only their own choices: no topic row is required.
  const request = {
    draftId: f.d.draftId,
    requestId: randomUUID(),
    purpose: "plan" as const,
    stepId: "step-1",
    input: JSON.stringify({
      confirmedPositioning: { "已知目标 0": "A concrete user decision" },
      platforms: [],
      accounts: [],
      startDate: "2026-09-21",
      days: 7,
    }),
  };
  const prepared = await f.service.prepareStep(request);
  const body = [
    {
      id: randomUUID(),
      platform: "x",
      account: "proposed-handle",
      title: "Agent proposed topic",
      brief: "Generated from the confirmed positioning; the account name is only a proposal.",
      day: "2026-09-21",
    },
    {
      id: randomUUID(),
      platform: "x",
      account: "proposed-handle",
      title: "Agent proposed topic 2",
      brief: "Second proposed topic.",
      day: "2026-09-23",
    },
  ];
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    for await (const _ of req) void _;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "plan-free-" + prepared.executionId,
        model: "opc-plan-free",
        final: true,
        cost: "0.003",
        currency: "USD",
        coverage: "request_total",
        usage: {
          sdkResponse: {
            id: "plan-free-" + prepared.executionId,
            object: "chat.completion",
            created: 1,
            model: "opc-plan-free",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(body) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local server");
    await runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint: "http://127.0.0.1:" + address.port,
    }).execute(prepared.executionId);
    const candidate = await f.service.planResult(f.d.draftId, prepared.executionId);
    expect(candidate.body).toEqual(body);
    expect(candidate.sourceVersionId).toBe(f.sourceVersionId);
    // A proposal is a plan version only: no account or work item exists yet.
    expect(
      (
        await sql.query("select count(*)::int n from opc_accounts where actor_id=$1", [
          f.actor,
        ])
      ).rows[0].n,
    ).toBe(0);
    const saved = await f.service.savePlan({
      draftId: f.d.draftId,
      requestId: randomUUID(),
      expectedVersion: 0,
      sourceVersionId: f.sourceVersionId,
      body: candidate.body,
    });
    expect(saved.version).toBe(1);
    const read = await f.service.read(f.d.draftId);
    expect(read.plans[0].body).toEqual(body);
    expect(
      (
        await sql.query("select count(*)::int n from artifact_projects where actor_id=$1 and work_kind='account'", [
          f.actor,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}, 180000);
it("OPC: a revised round opens the same question under its own identity without reusing or duplicating the original", async () => {
  const { runtimeExecutor } = await import("../runtime/execute");
  const { createServer } = await import("node:http");
  const { OPENING_INPUT, openingRequestId } = await import("../../shared/opcQuestions");
  const f = await fixture(2), model = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Round local','opc-round','fixture','true',1000,32000)",
    [model],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [model, f.moduleId]);
  const draft = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "mentor",
  });
  const roundA = draft.roundId;
  const schema = (await f.service.read(draft.draftId)).information["step-0"].schema;
  const questionId = schema[0].id;
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    for await (const _ of req) void _;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "round-" + calls,
        model: "opc-round",
        final: true,
        cost: "0.003",
        currency: "USD",
        coverage: "request_total",
        usage: {
          sdkResponse: {
            id: "round-" + calls,
            object: "chat.completion",
            created: 1,
            model: "opc-round",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    message: "【隔离模拟】第 " + calls + " 次开场。",
                    inputKind: "answer",
                    informationPatch: {},
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local server");
    const executor = runtimeExecutor({
      database: admin,
      actor: async () => f.actor,
      endpoint: "http://127.0.0.1:" + address.port,
    });
    const requestFor = (roundId: string) => ({
      draftId: draft.draftId,
      stepId: "step-0",
      purpose: "mentor" as const,
      requestId: openingRequestId(draft.draftId, roundId, "step-0", questionId),
      input: OPENING_INPUT,
      questionId,
    });
    const roundARequest = requestFor(roundA);
    const openingA = await f.service.prepareStep(roundARequest);
    // Prepared but not yet executed: an unresolved request is already owned by
    // its own identity, so a retry adopts it instead of creating another
    // execution, run or reservation.
    expect((await f.service.prepareStep(roundARequest)).executionId).toBe(openingA.executionId);
    expect(
      (await sql.query("select count(*)::int n from runtime_executions where actor_id=$1", [f.actor])).rows[0].n,
    ).toBe(1);
    expect(
      (await sql.query("select count(*)::int n from bill2_runs where actor_id=$1", [f.actor])).rows[0].n,
    ).toBe(1);
    expect(calls).toBe(0);
    await executor.execute(openingA.executionId);
    expect(calls).toBe(1);
    // The original round's request stays retryable and recoverable as itself.
    expect((await f.service.prepareStep(roundARequest)).executionId).toBe(openingA.executionId);
    await executor.execute(openingA.executionId);
    expect(calls).toBe(1);
    // Publish round A so a revision is allowed, exactly as the product requires.
    for (const step of f.flow.steps) {
      await f.artifacts.execute({
        action: "save", projectId: draft.projectId, roundId: roundA,
        requestId: randomUUID(), stepId: step.id, body: "Round A " + step.title,
        evidenceIds: [], expectedVersion: 0,
      });
      const state = (await f.artifacts.read(draft.projectId, roundA)).steps[step.id];
      await f.service.information({
        draftId: draft.draftId, stepId: step.id, requestId: randomUUID(),
        expectedVersion: state.version,
        values: { goal: { status: "confirmed", nature: "decision", value: "A concrete user decision" } },
      });
      const updated = (await f.artifacts.read(draft.projectId, roundA)).steps[step.id];
      await f.artifacts.execute({
        action: "confirm", projectId: draft.projectId, roundId: roundA,
        requestId: randomUUID(), stepId: step.id,
        expectedVersion: updated.version, expectedReviewVersion: updated.reviewVersion,
      });
    }
    const published = await f.artifacts.read(draft.projectId, roundA);
    await f.artifacts.execute({
      action: "publish", projectId: draft.projectId, roundId: roundA,
      requestId: randomUUID(),
      expectedSteps: Object.fromEntries(
        Object.entries(published.steps).map(([k, v]) => [k, { version: v.version, reviewVersion: v.reviewVersion }]),
      ),
    });
    const revised = await f.service.revise(draft.draftId, randomUUID(), roundA);
    const roundB = revised.roundId;
    expect(roundB).not.toBe(roundA);
    expect((await f.service.read(draft.draftId)).roundId).toBe(roundB);
    // A revision legitimately needs a fresh opening for the same step/question.
    const roundBRequest = requestFor(roundB);
    expect(roundBRequest.requestId).not.toBe(roundARequest.requestId);
    const openingB = await f.service.prepareStep(roundBRequest);
    expect(openingB.executionId).not.toBe(openingA.executionId);
    await executor.execute(openingB.executionId);
    expect(calls).toBe(2);
    // The older round keeps its own identity: it replays to its own execution
    // and never adopts the revised round's turn.
    expect((await f.service.prepareStep(roundARequest)).executionId).toBe(openingA.executionId);
    await executor.execute(openingA.executionId);
    expect(calls).toBe(2);
    const after = await f.service.read(draft.draftId);
    const openings = after.turns.filter((turn: any) => turn.kind === "opening");
    expect(openings).toHaveLength(2);
    expect(new Set(openings.map((turn: any) => turn.questionId))).toEqual(new Set([questionId]));
    expect(new Set(openings.map((turn: any) => turn.roundId))).toEqual(new Set([roundA, roundB]));
    expect(new Set(openings.map((turn: any) => turn.executionId))).toEqual(
      new Set([openingA.executionId, openingB.executionId]),
    );
    // Each opening owns exactly one execution, one BILL2 run and one reservation.
    expect(
      (await sql.query("select count(*)::int n from runtime_executions where actor_id=$1", [f.actor])).rows[0].n,
    ).toBe(2);
    expect(
      (await sql.query("select count(*)::int n from bill2_runs where actor_id=$1", [f.actor])).rows[0].n,
    ).toBe(2);
    expect(
      (await sql.query("select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'", [f.actor])).rows[0].n,
    ).toBe(2);
    // The revised opening material belongs to the revised round.
    expect(
      (
        await sql.query(
          "select count(*)::int n from opc_turns t where t.draft_id=$1 and t.purpose='mentor' and t.round_id=$2",
          [draft.draftId, roundB],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await sql.query(
          "select count(*)::int n from opc_turns t where t.draft_id=$1 and t.purpose='mentor' and t.round_id=$2",
          [draft.draftId, roundA],
        )
      ).rows[0].n,
    ).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}, 180000);
it("OPC: a revision makes the page open the current question again in the new round without duplicating the original", async () => {
  const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(2);
  const draft = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "mentor",
  });
  const roundA = draft.roundId;
  const draftUrl = process.env.V3_LOCAL_APP + "/positioning/" + draft.draftId;
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function login() {
      const ready = page.waitForResponse(
        (r) => r.url().includes("settings.getSystemSettings") && r.ok(),
        { timeout: 90000 },
      );
      await page.goto(
        process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(new URL(draftUrl).pathname),
      );
      await ready;
      await page.getByPlaceholder("name@example.com").fill(f.email);
      await page.getByPlaceholder("输入你的密码").fill(f.password);
      await page.getByRole("button", { name: "登录", exact: true }).last().click();
      await page.waitForURL(draftUrl, { timeout: 90000 });
    }
    const openingFor = (label: string) =>
      page.getByRole("log", { name: "完整导师消息" })
        .getByText(`导师主动引导 · ${label}`, { exact: true });
    await login();
    // Round A opens its current question while the user is idle.
    await expect.poll(() => openingFor("1.1").count(), { timeout: 30000 }).toBe(1);
    const afterRoundA = await f.service.read(draft.draftId);
    expect(afterRoundA.roundId).toBe(roundA);
    const roundAOpening = afterRoundA.turns.find((turn: any) => turn.kind === "opening");
    expect(roundAOpening?.roundId).toBe(roundA);
    // Publish round A, then revise it, exactly as the product flow does.
    for (const step of f.flow.steps) {
      await f.artifacts.execute({
        action: "save", projectId: draft.projectId, roundId: roundA,
        requestId: randomUUID(), stepId: step.id, body: "Round A " + step.title,
        evidenceIds: [], expectedVersion: 0,
      });
      const state = (await f.artifacts.read(draft.projectId, roundA)).steps[step.id];
      await f.service.information({
        draftId: draft.draftId, stepId: step.id, requestId: randomUUID(),
        expectedVersion: state.version,
        values: { goal: { status: "confirmed", nature: "decision", value: "A concrete user decision" } },
      });
      const updated = (await f.artifacts.read(draft.projectId, roundA)).steps[step.id];
      await f.artifacts.execute({
        action: "confirm", projectId: draft.projectId, roundId: roundA,
        requestId: randomUUID(), stepId: step.id,
        expectedVersion: updated.version, expectedReviewVersion: updated.reviewVersion,
      });
    }
    const published = await f.artifacts.read(draft.projectId, roundA);
    await f.artifacts.execute({
      action: "publish", projectId: draft.projectId, roundId: roundA,
      requestId: randomUUID(),
      expectedSteps: Object.fromEntries(
        Object.entries(published.steps).map(([k, v]) => [k, { version: v.version, reviewVersion: v.reviewVersion }]),
      ),
    });
    const revised = await f.service.revise(draft.draftId, randomUUID(), roundA);
    const roundB = revised.roundId;
    expect(roundB).not.toBe(roundA);
    // The user revisits and changes the answer, so the question is open again.
    const roundBState = (await f.artifacts.read(draft.projectId, roundB)).steps["step-0"];
    await f.service.information({
      draftId: draft.draftId, stepId: "step-0", requestId: randomUUID(),
      expectedVersion: roundBState.version,
      values: { goal: { status: "provisional", nature: "decision", value: "修订后的定位目标" } },
    });
    await page.reload();
    // The revised round must be opened again; the older round's reply must not
    // suppress it and must not be reused for it.
    await expect.poll(() => openingFor("1.1").count(), { timeout: 30000 }).toBe(2);
    const afterRoundB = await f.service.read(draft.draftId);
    expect(afterRoundB.roundId).toBe(roundB);
    const openings = afterRoundB.turns.filter((turn: any) => turn.kind === "opening");
    expect(new Set(openings.map((turn: any) => turn.roundId))).toEqual(new Set([roundA, roundB]));
    expect(new Set(openings.map((turn: any) => turn.executionId)).size).toBe(2);
    const identities = async () =>
      (
        await sql.query(
          "select e.id::text id, e.request_id::text request_id, b.id::text billing_id, b.pre_deduct_id::text pre_deduct_id from runtime_executions e join bill2_runs b on b.id=e.billing_run_id where e.actor_id=$1 order by e.id",
          [f.actor],
        )
      ).rows.map((row: any) => JSON.stringify(row)).sort();
    const beforeReload = await identities();
    expect(beforeReload).toHaveLength(2);
    // Refresh and re-login must not add a second execution, run or reservation.
    await page.reload();
    await expect.poll(() => openingFor("1.1").count(), { timeout: 30000 }).toBe(2);
    await context.clearCookies();
    await login();
    await expect.poll(() => openingFor("1.1").count(), { timeout: 30000 }).toBe(2);
    expect(await identities()).toEqual(beforeReload);
    expect(
      (await sql.query("select count(*)::int n from bill2_runs where actor_id=$1", [f.actor])).rows[0].n,
    ).toBe(2);
    expect(
      (await sql.query("select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'", [f.actor])).rows[0].n,
    ).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: a published revision's per-field elicitation reaches the read schema and the mentor directive", async () => {
  const { saveModuleSkill } = await import("../skills/modulePublication");
  const f = await fixture(2);
  const publishRevision = async (
    steps: Array<{ title: string; resources: string[]; information: Array<Record<string, unknown>> }>,
  ) => {
    const pack = makePackage();
    const model = randomUUID();
    // Publication validates the administrator model binding; the runtime
    // admission below needs the same row switched to the fixture protocol.
    await sql.query(
      "insert into ai_models(id,name,model_id,provider,is_active,api_key,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family) values($1,'Stage B local','qwen/qwen3.8-27b','openai','true','LOCAL_ONLY','',4096,128000,'false','openai')",
      [model],
    );
    const moduleId = randomUUID();
    await saveModuleSkill(admin, f.owner, {
      moduleId, skillId: pack.id, revisionId: pack.revisionId, requestId: pack.requestId,
      expectedUpdatedAt: null, expectedVersion: 0, directoryName: "synthetic-method", kind: "document",
      files: pack.files, steps, resourcePlanReviewed: true,
      module: {
        title: "Stage B method", description: null, full_description: null, model_id: model,
        platform: "all", category: "analysis", icon: "Wand2", image_url: null,
        badge_type: null, badge_text: null, credits_display: null, sort_order: 0,
        active: true, is_featured: false, features: null, examples: null, preparation_questions: null,
      },
    } as any);
    await sql.query("update ai_models set provider='fixture' where id=$1", [model]);
    const registration = (
      await sql.query("select id from artifact_workflows where module_id=$1 and revision_id=$2", [
        moduleId, pack.revisionId,
      ])
    ).rows[0].id;
    return { registration, moduleId, model };
  };
  const directiveFor = async (executionId: string) =>
    (await sql.query("select payload from runtime_executions where id=$1", [executionId])).rows[0]
      .payload.instructions as string;
  // One admission per draft keeps every session free; the directive is frozen
  // at admission, so no provider call is needed to inspect it.
  const directiveForQuestion = async (
    registration: string,
    questionId: string,
    confirm: Array<{ id: string; title: string; required: boolean; profileKey?: string }> = [],
  ) => {
    const started = await f.service.start({
      requestId: randomUUID(), registration, mode: "mentor",
    });
    if (confirm.length) {
      await f.service.information({
        draftId: started.draftId, stepId: "step-1", requestId: randomUUID(), expectedVersion: 0,
        values: Object.fromEntries(
          (await f.service.read(started.draftId)).information["step-1"].schema.map(
            (field: { id: string }) => [
              field.id,
              confirm.some((entry) => entry.id === field.id)
                ? { status: "confirmed", nature: "fact", value: "用户确认的自有事实" }
                : { status: "unknown", nature: "unknown", value: "" },
            ],
          ),
        ),
      });
    }
    const prepared = await f.service.prepareStep({
      draftId: started.draftId, stepId: "step-1", purpose: "mentor",
      requestId: randomUUID(), input: "请开始", questionId,
    });
    return { started, instructions: await directiveFor(prepared.executionId) };
  };

  // A revision that declares both roles explicitly. The method-information
  // contract still requires a distinct profileKey per declared field.
  const declared = await publishRevision([
    {
      title: "需求确认",
      resources: ["references/step-0.md"],
      information: [
        { id: "owned_fact", title: "用户自有事实", required: true, profileKey: "owned_fact", elicitation: "user_fact" },
        { id: "agent_deliverable", title: "导师成果建议", required: true, profileKey: "agent_deliverable", elicitation: "agent_proposal" },
      ],
    },
    { title: "成果", resources: ["SKILL.md"], information: [
      { id: "summary", title: "结论", required: true, profileKey: "summary", elicitation: "agent_proposal" },
    ] },
  ]);
  const readDraft = await f.service.start({
    requestId: randomUUID(), registration: declared.registration, mode: "mentor",
  });
  const read = await f.service.read(readDraft.draftId);
  // The stored workflow keeps both declared values.
  const storedWorkflow = (
    await sql.query("select workflow from artifact_rounds where id=$1", [readDraft.roundId])
  ).rows[0].workflow;
  expect(storedWorkflow.steps[0].information).toEqual([
    { id: "owned_fact", title: "用户自有事实", required: true, profileKey: "owned_fact", elicitation: "user_fact" },
    { id: "agent_deliverable", title: "导师成果建议", required: true, profileKey: "agent_deliverable", elicitation: "agent_proposal" },
  ]);
  // The read projection exposes the same roles.
  expect(read.information["step-1"].schema).toEqual([
    { id: "owned_fact", title: "用户自有事实", required: true, profileKey: "owned_fact", elicitation: "user_fact" },
    { id: "agent_deliverable", title: "导师成果建议", required: true, profileKey: "agent_deliverable", elicitation: "agent_proposal" },
  ]);
  const fact = await directiveForQuestion(declared.registration, "owned_fact");
  expect(fact.instructions).toContain('"id":"owned_fact"');
  expect(fact.instructions).toContain('"elicit":"user_fact"');
  expect(fact.instructions).not.toContain('"elicit":"agent_proposal"');
  const proposal = await directiveForQuestion(declared.registration, "agent_deliverable", [
    { id: "owned_fact", title: "用户自有事实", required: true, profileKey: "owned_fact" },
  ]);
  expect(proposal.instructions).toContain('"id":"agent_deliverable"');
  expect(proposal.instructions).toContain('"elicit":"agent_proposal"');
  expect(proposal.instructions).not.toContain('"elicit":"user_fact"');

  // An older revision without the property stays valid and resolves to user_fact.
  const legacy = await publishRevision([
    {
      title: "需求确认",
      resources: ["references/step-0.md"],
      information: [{ id: "position", title: "一句话核心商业定位", required: true, profileKey: "position" }],
    },
    { title: "成果", resources: ["SKILL.md"], information: [
      { id: "summary", title: "结论", required: true, profileKey: "legacy_summary" },
    ] },
  ]);
  const legacyDraft = await f.service.start({
    requestId: randomUUID(), registration: legacy.registration, mode: "mentor",
  });
  expect((await f.service.read(legacyDraft.draftId)).information["step-1"].schema).toEqual([
    { id: "position", title: "一句话核心商业定位", required: true, profileKey: "position" },
  ]);
  const legacyFact = await directiveForQuestion(legacy.registration, "position");
  // The name `position` used to be classified as a deliverable; it must now
  // resolve to a user-owned fact because the revision declares nothing.
  expect(legacyFact.instructions).toContain('"id":"position"');
  expect(legacyFact.instructions).toContain('"elicit":"user_fact"');
  expect(legacyFact.instructions).not.toContain('"elicit":"agent_proposal"');
}, 180000);
/**
 * The state the new final-confirmation button acts on: every positioning step
 * confirmed and the round not published yet. No mentor turn is involved, so the
 * only money this draft can spend is its own plan generation.
 */
async function finalized(n = 3) {
  const f = await fixture(n);
  const d = await f.service.start({
    requestId: randomUUID(),
    registration: f.registration,
    mode: "manual",
  });
  for (const step of f.flow.steps) {
    await f.artifacts.execute({
      action: "save", projectId: d.projectId, roundId: d.roundId,
      requestId: randomUUID(), stepId: step.id,
      body: "User confirmed " + step.title, evidenceIds: [], expectedVersion: 0,
    });
    const state = (await f.artifacts.read(d.projectId, d.roundId)).steps[step.id];
    await f.service.information({
      draftId: d.draftId, stepId: step.id, requestId: randomUUID(),
      expectedVersion: state.version,
      values: {
        goal: { status: "confirmed", nature: "decision", value: "A concrete user decision" },
      },
    });
    const updated = (await f.artifacts.read(d.projectId, d.roundId)).steps[step.id];
    await f.artifacts.execute({
      action: "confirm", projectId: d.projectId, roundId: d.roundId,
      requestId: randomUUID(), stepId: step.id,
      expectedVersion: updated.version, expectedReviewVersion: updated.reviewVersion,
    });
  }
  return { ...f, d };
}
/** A fixture-backed model bound to the module under test. */
async function planFixtureModel(moduleId: string) {
  const model = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-browser','fixture','true',1000,32000)",
    [model],
  );
  await sql.query("update modules set model_id=$1 where id=$2", [model, moduleId]);
  return model;
}
/**
 * Exact plan-purpose money and identity for one actor: nothing here is derived
 * from a request the test itself made up.
 */
async function planIdentity(actor: string, draftId: string) {
  const count = async (q: string, params: unknown[]) =>
    Number((await sql.query(q, params)).rows[0].n);
  return {
    executions: await count(
      "select count(*)::int n from runtime_executions where actor_id=$1", [actor]),
    planExecutions: await count(
      "select count(*)::int n from runtime_executions e join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where e.actor_id=$1 and t.purpose='plan'",
      [actor],
    ),
    planRuns: await count(
      "select count(*)::int n from bill2_runs b join runtime_executions e on e.billing_run_id=b.id join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where b.actor_id=$1 and t.purpose='plan'",
      [actor],
    ),
    reserves: await count(
      "select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'",
      [actor],
    ),
    plans: await count("select count(*)::int n from opc_plans where draft_id=$1", [draftId]),
    accounts: await count(
      "select count(*)::int n from opc_accounts where actor_id=$1", [actor]),
    workItems: await count(
      "select count(*)::int n from artifact_projects where actor_id=$1 and work_kind='account'",
      [actor],
    ),
  };
}
/** Execution/billing/pre-deduct identity rows, compared before and after recovery. */
async function planIdentityRows(actor: string) {
  return (await sql.query(
    `select e.id::text execution_id, e.request_id::text request_id,
       b.id::text billing_id, b.pre_deduct_id::text pre_deduct_id
     from runtime_executions e
     left join bill2_runs b on b.id=e.billing_run_id
     where e.actor_id=$1`,
    [actor],
  )).rows.map((row) =>
    JSON.stringify([row.execution_id, row.request_id, row.billing_id, row.pre_deduct_id]),
  ).sort();
}
/** The envelope the positioning page freezes after a successful publish. */
function planEnvelopeFor(
  f: { d: { draftId: string; roundId: string } },
  options: { requestId?: string; sourceRoundId?: string; accounts?: string[] } = {},
) {
  return {
    v: 2,
    sourceRoundId: options.sourceRoundId ?? f.d.roundId,
    request: {
      draftId: f.d.draftId,
      requestId: options.requestId ?? randomUUID(),
      purpose: "plan",
      stepId: "step-1",
      input: JSON.stringify({
        confirmedPositioning: { "已知目标 0": "A concrete user decision" },
        platforms: [],
        accounts: options.accounts ?? [],
        startDate: "2026-09-21",
        days: 7,
      }),
    },
  };
}
/**
 * Logs a browser page into an already published draft's plan page. The
 * envelope is seeded afterwards so each case controls exactly what automatic
 * recovery is allowed to see.
 */
async function planBrowser(
  f: { email: string; password: string; d: { draftId: string } },
  options: {
    envelope?: Record<string, unknown> | null;
    clearBuffer?: boolean;
    buffer?: Record<string, unknown> | null;
  } = {},
) {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
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
  const path = "/positioning/" + f.d.draftId + "/plan";
  await page.goto(
    process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path),
  );
  await page.getByPlaceholder("name@example.com").fill(f.email);
  await page.getByPlaceholder("输入你的密码").fill(f.password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.waitForURL((url) => url.pathname.endsWith(path));
  const key = "opc-plan-generation:" + f.d.draftId;
  await page.evaluate(
    ({ key, envelope, clearBuffer, buffer, draftId }) => {
      sessionStorage.removeItem(key);
      if (envelope) sessionStorage.setItem(key, JSON.stringify(envelope));
      if (clearBuffer) sessionStorage.removeItem("opc-edit:" + draftId);
      if (buffer)
        sessionStorage.setItem("opc-edit:" + draftId, JSON.stringify(buffer));
    },
    {
      key,
      envelope: options.envelope ?? null,
      clearBuffer: options.clearBuffer ?? false,
      buffer: options.buffer ?? null,
      draftId: f.d.draftId,
    },
  );
  return { browser, context, page, key };
}
const CANDIDATE_HEADING = "AI 计划候选 · 尚未替换你的编辑";
it("OPC: Stage C1 the final positioning confirmation itself generates one plan candidate", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await finalized(3);
  await planFixtureModel(f.moduleId);
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
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
  const draftPath = "/positioning/" + f.d.draftId;
  const envelopeKey = "opc-plan-generation:" + f.d.draftId;
  try {
    await page.goto(
      process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(draftPath),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath));
    const finalButton = page.getByRole("button", {
      name: "确认正式定位并生成第一周计划",
      exact: true,
    });
    await expect.poll(() => finalButton.isEnabled(), { timeout: 30000 }).toBe(true);
    // Nothing is authorized before the user confirms: no envelope, and no plan
    // work of any kind. (The positioning page may open its mentor question on
    // its own; that is not plan work and is excluded by the plan-purpose joins.)
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    const before = await planIdentity(f.actor, f.d.draftId);
    expect(before.planExecutions).toBe(0);
    expect(before.planRuns).toBe(0);
    await finalButton.click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath + "/plan"));
    // The user clicks nothing else: no generation button, no topic row.
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    expect(await page.getByRole("textbox", { name: "title 0", exact: true }).count()).toBe(0);
    // The envelope is retained while the candidate waits for a decision.
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).not.toBeNull();
    const after = await planIdentity(f.actor, f.d.draftId);
    // Exactly one plan execution, one BILL2 run and one reserve came from the
    // confirmation itself, and nothing else was created.
    expect(after.planExecutions - before.planExecutions).toBe(1);
    expect(after.planRuns - before.planRuns).toBe(1);
    expect(after.reserves - before.reserves).toBe(1);
    expect(after.plans).toBe(0);
    expect(after.accounts).toBe(0);
    expect(after.workItems).toBe(0);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: Stage C2 a lost reply keeps one plan identity across refresh and re-login", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const envelope = planEnvelopeFor(f);
  const { browser, context, page, key } = await planBrowser(f, { envelope });
  try {
    let releases = 0;
    await page.route("**/api/trpc/opc.planResult*", async (route) => {
      // The server admitted and finished the work; every client reply is lost,
      // including any automatic query retry, so the page cannot confirm the
      // outcome on its own.
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      releases += 1;
      await route.abort();
    });
    await page.reload();
    await expect.poll(() => page.getByText("这次生成的结果暂时无法确认").count(), {
      timeout: 30000,
    }).toBe(1);
    expect(releases).toBeGreaterThan(0);
    const afterLoss = await planIdentity(f.actor, f.d.draftId);
    expect(afterLoss.planExecutions).toBe(1);
    expect(afterLoss.planRuns).toBe(1);
    expect(afterLoss.reserves).toBe(1);
    expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).not.toBeNull();
    const identity = await planIdentityRows(f.actor);
    expect(identity).toHaveLength(1);
    // A reload with no local candidate must replay the same request, not make
    // a new one: the buffer is cleared first so only recovery can help.
    await page.unroute("**/api/trpc/opc.planResult*");
    await page.evaluate(
      (id) => sessionStorage.removeItem("opc-edit:" + id),
      f.d.draftId,
    );
    await page.reload();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(afterLoss);
    expect(await planIdentityRows(f.actor)).toEqual(identity);
    expect(
      JSON.parse(
        (await page.evaluate((k) => sessionStorage.getItem(k), key)) as string,
      ).request.requestId,
    ).toBe(envelope.request.requestId);
    // Re-login on a fresh session recovers the same identity again.
    await context.clearCookies();
    await page.goto(
      process.env.V3_LOCAL_APP +
        "/login?redirect=" +
        encodeURIComponent("/positioning/" + f.d.draftId + "/plan"),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL((url) => url.pathname.endsWith("/plan"));
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(afterLoss);
    expect(await planIdentityRows(f.actor)).toEqual(identity);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: Stage C3 adopting or dismissing the candidate is a local edit, never a call", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const { browser, page, key } = await planBrowser(f, {
    envelope: planEnvelopeFor(f, { accounts: ["c3-account"] }),
  });
  try {
    await page.reload();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    const generated = await planIdentity(f.actor, f.d.draftId);
    expect(generated.planRuns).toBe(1);
    // Dismissing ends the envelope without touching the working rows.
    await page.getByRole("button", { name: "保留原计划", exact: true }).click();
    await expect
      .poll(() => page.evaluate((k) => sessionStorage.getItem(k), key), { timeout: 15000 })
      .toBeNull();
    expect(await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).count()).toBe(0);
    expect(await page.getByRole("textbox", { name: "title 0", exact: true }).count()).toBe(0);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(generated);
    // A second, user-authorized generation adopts instead.
    await page.evaluate(
      ({ k, value }) => sessionStorage.setItem(k, JSON.stringify(value)),
      { k: key, value: planEnvelopeFor(f, { accounts: ["c3-account"] }) },
    );
    await page.reload();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    const second = await planIdentity(f.actor, f.d.draftId);
    expect(second.planRuns).toBe(2);
    await page.getByRole("button", { name: "采用候选到计划工作稿", exact: true }).click();
    await expect
      .poll(() => page.evaluate((k) => sessionStorage.getItem(k), key), { timeout: 15000 })
      .toBeNull();
    expect(await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).count()).toBe(0);
    const titles = await page.getByRole("textbox", { name: /^title / }).all();
    expect(titles).toHaveLength(7);
    expect(await page.getByRole("textbox", { name: "title 0", exact: true }).inputValue()).toBe("模拟选题 1");
    // Adopting is local: no model call, no plan row, no account, no work item.
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(second);
    await page.getByRole("button", { name: "保存计划版本" }).click();
    await expect
      .poll(async () => (await planIdentity(f.actor, f.d.draftId)).plans, { timeout: 30000 })
      .toBe(1);
    const saved = await planIdentity(f.actor, f.d.draftId);
    expect(saved.executions).toBe(second.executions);
    expect(saved.planRuns).toBe(second.planRuns);
    expect(saved.reserves).toBe(second.reserves);
    expect(saved.accounts).toBe(0);
    expect(saved.workItems).toBe(0);
    // Handoff stays a separate explicit action that has not happened yet.
    await expect
      .poll(
        () =>
          page
            .getByRole("button", {
              name: "确认账号与计划，创建选题",
              exact: true,
            })
            .count(),
        { timeout: 30000 },
      )
      .toBe(1);
    expect((await planIdentity(f.actor, f.d.draftId)).workItems).toBe(0);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: Stage C4 an already published draft spends nothing by waiting or refreshing", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const { browser, page, key } = await planBrowser(f);
  try {
    expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).toBeNull();
    const generate = page.getByRole("button", { name: "生成第一周计划", exact: true });
    await generate.waitFor();
    await page.reload();
    await generate.waitFor();
    // Give an automatic generation every chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await page.reload();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual({
      executions: 0, planExecutions: 0, planRuns: 0, reserves: 0,
      plans: 0, accounts: 0, workItems: 0,
    });
    expect(await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).count()).toBe(0);
    // Only the explicit button may create one request.
    await generate.click();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual({
      executions: 1, planExecutions: 1, planRuns: 1, reserves: 1,
      plans: 0, accounts: 0, workItems: 0,
    });
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: Stage C5 a retained request from another round is archived, never executed", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const staleRequestId = randomUUID();
  const { browser, page, key } = await planBrowser(f, {
    envelope: planEnvelopeFor(f, {
      requestId: staleRequestId,
      sourceRoundId: randomUUID(),
    }),
  });
  try {
    await page.reload();
    await page.getByText("上一轮定位留下的生成请求已在本机归档").waitFor();
    // The stale request is released and archived verbatim, and never executed.
    expect(await page.evaluate((k) => sessionStorage.getItem(k), key)).toBeNull();
    const archived = await page.evaluate((k) => {
      const found: string[] = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const name = sessionStorage.key(i);
        if (name && name.startsWith(k + ":stale:")) found.push(name);
      }
      return found.map((name) => sessionStorage.getItem(name) as string);
    }, key);
    expect(archived).toHaveLength(1);
    expect(JSON.parse(archived[0]).request.requestId).toBe(staleRequestId);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual({
      executions: 0, planExecutions: 0, planRuns: 0, reserves: 0,
      plans: 0, accounts: 0, workItems: 0,
    });
    // The bounded notice offers an explicit regenerate path for this round.
    await page.getByRole("button", { name: "生成第一周计划", exact: true }).click();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual({
      executions: 1, planExecutions: 1, planRuns: 1, reserves: 1,
      plans: 0, accounts: 0, workItems: 0,
    });
    // No migration: the new request is a new identity, not the archived one.
    const fresh = JSON.parse(
      (await page.evaluate((k) => sessionStorage.getItem(k), key)) as string,
    );
    expect(fresh.request.requestId).not.toBe(staleRequestId);
    expect(fresh.sourceRoundId).toBe(f.d.roundId);
  } finally {
    await browser.close();
  }
}, 300000);
/** The frozen plan requests this actor actually sent, in send order. */
async function planRequests(actor: string) {
  return (await sql.query(
    `select e.request_id::text request_id, e.payload->'request'->>'input' input
     from runtime_executions e
     join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id
     where e.actor_id=$1 and t.purpose='plan'
     order by e.created_at, e.id`,
    [actor],
  )).rows;
}
it("OPC: Stage C6 explicit regeneration honours changed constraints and a new identity", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const { browser, page, key } = await planBrowser(f, {
    envelope: planEnvelopeFor(f, { accounts: ["c6-account"] }),
  });
  const bufferOf = async () =>
    JSON.parse(
      (await page.evaluate(
        (id) => sessionStorage.getItem("opc-edit:" + id),
        f.d.draftId,
      )) as string,
    );
  try {
    await page.reload();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    const first = await planIdentity(f.actor, f.d.draftId);
    expect(first.planRuns).toBe(1);
    const sent = await planRequests(f.actor);
    expect(sent).toHaveLength(1);
    const firstRequestId = sent[0].request_id;
    expect(JSON.parse(sent[0].input).accounts).toEqual(["c6-account"]);
    expect(JSON.parse(sent[0].input).platforms).toEqual([]);
    expect((await bufferOf()).planCandidateRequestId).toBe(firstRequestId);
    // The user changes two optional constraints, then explicitly regenerates.
    await page.getByRole("textbox", { name: "目标平台", exact: true }).fill("douyin");
    await page.getByRole("textbox", { name: "开始日期", exact: true }).fill("2026-10-05");
    await page
      .getByRole("button", { name: "重新生成计划候选", exact: true })
      .click();
    await expect
      .poll(async () => (await planRequests(f.actor)).length, { timeout: 90000 })
      .toBe(2);
    const after = await planRequests(f.actor);
    // The new constraints really reached the model, on a new identity.
    expect(JSON.parse(after[1].input).platforms).toEqual(["douyin"]);
    expect(JSON.parse(after[1].input).startDate).toBe("2026-10-05");
    expect(after[1].request_id).not.toBe(firstRequestId);
    // Exactly one more generation was paid for.
    const second = await planIdentity(f.actor, f.d.draftId);
    expect(second.planExecutions - first.planExecutions).toBe(1);
    expect(second.planRuns - first.planRuns).toBe(1);
    expect(second.reserves - first.reserves).toBe(1);
    // Only the candidate changed: the working rows were never overwritten.
    expect(await page.getByRole("textbox", { name: "title 0", exact: true }).count()).toBe(0);
    await expect
      .poll(() => page.getByText("douyin").count(), { timeout: 30000 })
      .toBeGreaterThan(0);
    const buffer = await bufferOf();
    expect(buffer.planCandidateRequestId).toBe(after[1].request_id);
    expect(buffer.planCandidateSourceRoundId).toBe(f.d.roundId);
    expect(
      JSON.parse(
        (await page.evaluate((k) => sessionStorage.getItem(k), key)) as string,
      ).request.requestId,
    ).toBe(after[1].request_id);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: Stage C7 a stale round candidate neither suppresses nor impersonates the current round", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const staleRoundId = randomUUID();
  const staleRequestId = randomUUID();
  const staleCandidate = [
    {
      id: randomUUID(),
      platform: "x",
      account: "stale-round-a",
      title: "上一轮候选",
      brief: "上一轮生成的候选，不得作为当前轮展示",
      day: "2026-01-01",
    },
  ];
  const { browser, page } = await planBrowser(f, {
    envelope: planEnvelopeFor(f),
    buffer: {
      planCandidate: staleCandidate,
      planCandidateSourceRoundId: staleRoundId,
      planCandidateRequestId: staleRequestId,
      items: [],
      dirtyPlan: false,
    },
  });
  const bufferOf = async () =>
    JSON.parse(
      (await page.evaluate(
        (id) => sessionStorage.getItem("opc-edit:" + id),
        f.d.draftId,
      )) as string,
    );
  try {
    await page.reload();
    // The round-A candidate is not rendered as this round's candidate, and it
    // does not stop the round-B envelope from executing exactly once.
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    expect(await page.getByText("上一轮候选").count()).toBe(0);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual({
      executions: 1, planExecutions: 1, planRuns: 1, reserves: 1,
      plans: 0, accounts: 0, workItems: 0,
    });
    const generated = await bufferOf();
    expect(generated.planCandidateSourceRoundId).toBe(f.d.roundId);
    expect(generated.planCandidateRequestId).not.toBe(staleRequestId);
    expect(
      (generated.planCandidate as Array<{ title: string }>).map((i) => i.title),
    ).not.toContain("上一轮候选");
    expect(generated.planCandidate).toHaveLength(7);
    // Repair B4, through the real revise button: a successful revision archives
    // the previous round's candidate so it cannot become current again.
    await page.goto(process.env.V3_LOCAL_APP + "/positioning/" + f.d.draftId);
    await page.evaluate(
      ({ id, candidate, roundId }) =>
        sessionStorage.setItem(
          "opc-edit:" + id,
          JSON.stringify({
            planCandidate: candidate,
            planCandidateSourceRoundId: roundId,
            planCandidateRequestId: "round-a-request",
            items: [],
            dirtyPlan: false,
          }),
        ),
      { id: f.d.draftId, candidate: staleCandidate, roundId: f.d.roundId },
    );
    const revise = page.getByRole("button", {
      name: "修订定位，保留原版本",
      exact: true,
    });
    await expect.poll(() => revise.isEnabled(), { timeout: 30000 }).toBe(true);
    await revise.click();
    await expect
      .poll(
        async () => {
          const buffer = await bufferOf();
          return [
            Boolean(buffer.planCandidate),
            (buffer.planCandidateArchive?.body ?? []).length,
            buffer.planCandidateArchive?.roundId ?? null,
          ];
        },
        { timeout: 30000 },
      )
      .toEqual([false, 1, f.d.roundId]);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: Stage C8 an ambiguous explicit regeneration recovers B behind candidate A without creating C", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const { browser, context, page, key } = await planBrowser(f, {
    envelope: planEnvelopeFor(f, { accounts: ["c8-account"] }),
  });
  const bufferOf = async () =>
    JSON.parse(
      (await page.evaluate(
        (id) => sessionStorage.getItem("opc-edit:" + id),
        f.d.draftId,
      )) as string,
    );
  const envelopeOf = async () =>
    JSON.parse(
      (await page.evaluate((k) => sessionStorage.getItem(k), key)) as string,
    );
  const rowsOf = async () =>
    (await planIdentityRows(f.actor)).map((row) => JSON.parse(row) as string[]);
  try {
    // Candidate A: the confirmation's own authorization, confirmed normally.
    await page.reload();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    const first = await planRequests(f.actor);
    expect(first).toHaveLength(1);
    const aRequestId = first[0].request_id;
    expect(JSON.parse(first[0].input).accounts).toEqual(["c8-account"]);
    expect(JSON.parse(first[0].input).platforms).toEqual([]);
    expect((await bufferOf()).planCandidateRequestId).toBe(aRequestId);
    expect((await envelopeOf()).request.requestId).toBe(aRequestId);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual({
      executions: 1, planExecutions: 1, planRuns: 1, reserves: 1,
      plans: 0, accounts: 0, workItems: 0,
    });
    const rowsA = await rowsOf();
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0][1]).toBe(aRequestId);
    expect(await page.getByText("c8-account").count()).toBeGreaterThan(0);

    // B is a real second authorization: the user changes two optional
    // constraints and clicks the regeneration control. The server admits,
    // executes and reserves B, but every client reply for its plan result is
    // fetched and then dropped, so the page cannot confirm what it paid for.
    let releases = 0;
    await page.route("**/api/trpc/opc.planResult*", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      releases += 1;
      await route.abort();
    });
    await page.getByRole("textbox", { name: "目标平台", exact: true }).fill("douyin");
    await page.getByRole("textbox", { name: "开始日期", exact: true }).fill("2026-10-05");
    await page
      .getByRole("button", { name: "重新生成计划候选", exact: true })
      .click();
    await expect
      .poll(async () => (await planRequests(f.actor)).length, { timeout: 90000 })
      .toBe(2);
    await expect.poll(() => releases, { timeout: 90000 }).toBeGreaterThan(0);
    const sent = await planRequests(f.actor);
    const bRequestId = sent[1].request_id;
    expect(bRequestId).not.toBe(aRequestId);
    // B really carries the changed constraints.
    expect(JSON.parse(sent[1].input).platforms).toEqual(["douyin"]);
    expect(JSON.parse(sent[1].input).startDate).toBe("2026-10-05");
    // The old candidate A is still what the user sees; the retained envelope
    // already names the newer, unconfirmed request B.
    expect((await bufferOf()).planCandidateRequestId).toBe(aRequestId);
    expect(await page.getByText("c8-account").count()).toBeGreaterThan(0);
    expect(await page.getByText("douyin").count()).toBe(0);
    const lost = await envelopeOf();
    expect(lost.request.requestId).toBe(bRequestId);
    expect(lost.sourceRoundId).toBe(f.d.roundId);
    expect(JSON.parse(lost.request.input).platforms).toEqual(["douyin"]);
    const afterLoss = await planIdentity(f.actor, f.d.draftId);
    expect(afterLoss.planExecutions).toBe(2);
    expect(afterLoss.planRuns).toBe(2);
    expect(afterLoss.reserves).toBe(2);
    const rowsAB = await rowsOf();
    expect(rowsAB).toHaveLength(2);
    expect(rowsAB.map((row) => row[1]).sort()).toEqual([aRequestId, bRequestId].sort());
    const bBefore = rowsAB.find((row) => row[1] === bRequestId)!;
    expect(bBefore.every((value) => typeof value === "string" && value.length > 0)).toBe(true);

    // Explicit recovery of the same unresolved intent must reuse B, not create
    // a third request C that would be a third charge.
    await page
      .getByRole("button", { name: "重新生成计划候选", exact: true })
      .click();
    await expect.poll(() => releases, { timeout: 90000 }).toBeGreaterThan(1);
    expect((await envelopeOf()).request.requestId).toBe(bRequestId);
    expect((await envelopeOf()).request.input).toBe(lost.request.input);
    expect((await bufferOf()).planCandidateRequestId).toBe(aRequestId);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await planRequests(f.actor)).map((row) => row.request_id)).toEqual([
      aRequestId,
      bRequestId,
    ]);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(afterLoss);
    expect(await rowsOf()).toEqual(rowsAB);

    // With the interception removed, a reload recovers B on its own identity
    // instead of stopping at the visible fallback candidate A.
    await page.unroute("**/api/trpc/opc.planResult*");
    await page.reload();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    await expect
      .poll(async () => (await bufferOf()).planCandidateRequestId, { timeout: 30000 })
      .toBe(bRequestId);
    const recovered = await envelopeOf();
    expect(recovered.request.requestId).toBe(bRequestId);
    expect(JSON.parse(recovered.request.input).platforms).toEqual(["douyin"]);
    expect(await page.getByText("douyin").count()).toBeGreaterThan(0);
    expect(await page.getByText("c8-account").count()).toBe(0);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(afterLoss);
    const rowsRecovered = await rowsOf();
    expect(rowsRecovered).toEqual(rowsAB);
    expect(rowsRecovered.find((row) => row[1] === bRequestId)).toEqual(bBefore);
    expect((await planRequests(f.actor)).map((row) => row.request_id)).toEqual([
      aRequestId,
      bRequestId,
    ]);

    // A fresh login recovers the same identity once more and still cannot
    // create a third request.
    await context.clearCookies();
    await page.goto(
      process.env.V3_LOCAL_APP +
        "/login?redirect=" +
        encodeURIComponent("/positioning/" + f.d.draftId + "/plan"),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL((url) => url.pathname.endsWith("/plan"));
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    await expect
      .poll(async () => (await bufferOf()).planCandidateRequestId, { timeout: 30000 })
      .toBe(bRequestId);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(afterLoss);
    expect(await rowsOf()).toEqual(rowsAB);
    expect((await planRequests(f.actor)).map((row) => row.request_id)).toEqual([
      aRequestId,
      bRequestId,
    ]);
  } finally {
    await browser.close();
  }
}, 300000);
/**
 * The retained `opc-confirm:<draftId>` request owns a business intent: the
 * draft, the plan version and the normalized platform/account set. A lost
 * reply must keep replaying that exact intent, while a NEW current intent must
 * be able to form its own explicit request instead of being refused locally
 * with `confirmation pending` forever.
 */
it("OPC: a retained handoff request does not block a newly saved current plan", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await completed(3);
  const planA = await f.service.savePlan({
    draftId: f.d.draftId,
    sourceVersionId: f.sourceVersionId,
    requestId: randomUUID(),
    expectedVersion: 0,
    body: [
      {
        id: randomUUID(),
        platform: "x",
        account: "f1-retained",
        day: "2026-09-15",
        title: "Plan A topic",
        brief: "Plan A brief",
      },
    ],
  });
  const key = "opc-confirm:" + f.d.draftId;
  const path = "/positioning/" + f.d.draftId + "/plan";
  const handoffHistory = async () =>
    (
      await sql.query(
        "select request_id::text request_id, payload, result from opc_handoffs where actor_id=$1",
        [f.actor],
      )
    ).rows as Array<{
      request_id: string;
      payload: { draftId: string; planId: string; accounts: unknown[] };
      result: Array<{ workItemId: string; sessionId: string }>;
    }>;
  const currentPlan = async () =>
    (
      await sql.query(
        "select id::text id, version::int version from opc_plans where draft_id=$1 order by version desc limit 1",
        [f.d.draftId],
      )
    ).rows[0] as { id: string; version: number };
  const workItemCount = async () =>
    Number(
      (
        await sql.query(
          "select count(*)::int n from opc_items i join artifact_projects p on p.id=i.work_item_id where p.actor_id=$1",
          [f.actor],
        )
      ).rows[0].n,
    );
  const accountRevision = async () =>
    Number(
      (
        await sql.query("select revision::int r from opc_accounts where actor_id=$1", [
          f.actor,
        ])
      ).rows[0].r,
    );
  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
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
  /** The exact retained request body, or null when the key is gone. */
  const retainedRequest = async () =>
    (await page.evaluate(
      (k) => sessionStorage.getItem(k) ?? "null",
      key,
    )) as string;
  let lostHandoffs = 0;
  try {
    await page.goto(
      process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL((url) => url.pathname.endsWith(path));
    const confirm = page.getByRole("button", {
      name: "确认账号与计划，创建选题",
      exact: true,
    });
    await confirm.waitFor();
    await expect.poll(() => confirm.isEnabled(), { timeout: 15000 }).toBe(true);
    // Steps 1-4. Plan A's handoff really completes on the server while the
    // browser loses the successful reply, so the page keeps request A as an
    // unresolved authorization for plan A.
    await page.route("**/api/trpc/opc.handoff*", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      lostHandoffs += 1;
      await route.abort();
    });
    await confirm.click();
    await expect.poll(() => lostHandoffs, { timeout: 90000 }).toBe(1);
    await expect
      .poll(async () => (await retainedRequest()) !== "null", { timeout: 30000 })
      .toBe(true);
    const retainedA = JSON.parse(await retainedRequest());
    expect(retainedA.planId).toBe(planA.planId);
    expect(retainedA.draftId).toBe(f.d.draftId);
    expect(retainedA.accounts).toEqual([
      { platform: "x", account: "f1-retained", expectedRevision: null },
    ]);
    const historyA = await handoffHistory();
    expect(historyA.map((row) => row.request_id)).toEqual([
      retainedA.requestId,
    ]);
    expect(historyA[0].payload.planId).toBe(planA.planId);
    expect(historyA[0].result).toHaveLength(1);
    // Step 5. Change the editable working plan and explicitly save plan B.
    await page
      .getByRole("textbox", { name: "title 0", exact: true })
      .fill("Plan B topic");
    await page.getByRole("button", { name: "保存计划版本" }).click();
    await expect
      .poll(async () => (await currentPlan()).version, { timeout: 30000 })
      .toBe(2);
    const planB = await currentPlan();
    expect(planB.id).not.toBe(planA.planId);
    // The page itself must have re-read plan B and cleared its dirty state
    // before the reload, otherwise a reload correctly restores the pending
    // local edits this test is not exercising.
    await page
      .getByRole("heading", { name: "确认采用定位与计划第 2 版", exact: true })
      .waitFor();
    // Step 6. Reload so plan B and the current account revision are what the
    // page shows, while request A is still retained.
    await page.reload();
    await confirm.waitFor();
    await expect.poll(() => confirm.isEnabled(), { timeout: 15000 }).toBe(true);
    expect(JSON.parse(await retainedRequest()).requestId).toBe(
      retainedA.requestId,
    );
    // Steps 7-8. Confirming plan B is a new explicit authorization. A local
    // `confirmation pending` refusal would issue no HTTP request at all, so the
    // second interception is the proof the repair removed the deadlock.
    await confirm.click();
    await expect.poll(() => lostHandoffs, { timeout: 90000 }).toBe(2);
    const retainedB = JSON.parse(await retainedRequest());
    expect(retainedB.planId).toBe(planB.id);
    expect(retainedB.requestId).not.toBe(retainedA.requestId);
    expect(retainedB.accounts).toEqual([
      { platform: "x", account: "f1-retained", expectedRevision: 1 },
    ]);
    const historyB = await handoffHistory();
    expect(historyB).toHaveLength(2);
    expect(historyB.map((row) => row.request_id).sort()).toEqual(
      [retainedA.requestId, retainedB.requestId].sort(),
    );
    expect(
      historyB.find((row) => row.request_id === retainedB.requestId)!.payload
        .planId,
    ).toBe(planB.id);
    expect(await workItemCount()).toBe(2);
    expect(await accountRevision()).toBe(2);
    // The same-intent path still replays: B's unresolved request recovers its
    // own committed result instead of creating anything new.
    await page.unroute("**/api/trpc/opc.handoff*");
    await page.reload();
    await confirm.waitFor();
    await expect.poll(() => confirm.isEnabled(), { timeout: 15000 }).toBe(true);
    await confirm.click();
    await expect
      .poll(async () => await retainedRequest(), { timeout: 30000 })
      .toBe("null");
    await page.getByRole("link", { name: "进入选题工作空间" }).first().waitFor();
    expect(
      await page.getByRole("link", { name: "进入选题工作空间" }).count(),
    ).toBe(2);
    expect((await handoffHistory()).map((row) => row.request_id).sort()).toEqual(
      historyB.map((row) => row.request_id).sort(),
    );
    expect(await workItemCount()).toBe(2);
    // H3 for the version dimension: another writer saves a newer plan while this
    // confirmation is in flight. The save runs strictly before the server sees
    // the pending handoff, so the answer is a definite `OPC_VERSION_CONFLICT`
    // rollback rather than a timing race. That transaction must leave no
    // handoff history and release the local request for the current plan.
    let planC: { planId: string; version: number } | null = null;
    await page.route("**/api/trpc/opc.handoff*", async (route) => {
      planC ??= await f.service.savePlan({
        draftId: f.d.draftId,
        sourceVersionId: f.sourceVersionId,
        requestId: randomUUID(),
        expectedVersion: 2,
        body: [
          {
            id: randomUUID(),
            platform: "x",
            account: "f1-retained",
            day: "2026-09-16",
            title: "Plan C topic",
            brief: "Plan C brief",
          },
        ],
      });
      await route.continue();
    });
    await confirm.click();
    await page.getByRole("alert").filter({ hasText: "操作未完成" }).waitFor();
    expect(planC).not.toBeNull();
    expect(planC!.planId).not.toBe(planB.id);
    expect(await handoffHistory()).toHaveLength(2);
    expect(await workItemCount()).toBe(2);
    await expect
      .poll(async () => await retainedRequest(), { timeout: 30000 })
      .toBe("null");
    await page.unroute("**/api/trpc/opc.handoff*");
    await expect.poll(() => confirm.isEnabled(), { timeout: 15000 }).toBe(true);
    await confirm.click();
    await expect
      .poll(async () => (await handoffHistory()).length, { timeout: 90000 })
      .toBe(3);
    const historyC = await handoffHistory();
    const requestC = historyC.find(
      (row) =>
        row.request_id !== retainedA.requestId &&
        row.request_id !== retainedB.requestId,
    )!;
    expect(requestC.payload.planId).toBe(planC!.planId);
    expect(await workItemCount()).toBe(3);
    expect(await accountRevision()).toBe(3);
    // Step 9. The current handoff result stays visible after a reload.
    await page.reload();
    await page.getByRole("link", { name: "进入选题工作空间" }).first().waitFor();
    expect(
      await page.getByRole("link", { name: "进入选题工作空间" }).count(),
    ).toBe(3);
    // Handoff itself is a financial no-op: no model execution, BILL2 run or
    // reservation is introduced by any of the three explicit confirmations.
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual({
      executions: 0,
      planExecutions: 0,
      planRuns: 0,
      reserves: 0,
      plans: 3,
      accounts: 1,
      workItems: 1,
    });
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: an upstream reconfirmation can be resubmitted and never hides already answered questions", async () => {
  const {chromium} = await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3, true), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Reconfirm local','opc-reconfirm','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  const startedAt = Date.now();
  const marks: Record<string, number> = {};
  const external: string[] = [];
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const host = new URL(route.request().url()).hostname;
      if (["127.0.0.1","localhost"].includes(host)) return route.continue();
      external.push(host);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const path = "/positioning/" + draft.draftId;
    const ready = page.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), {timeout: 90000});
    await page.goto(process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path));
    await ready;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", {name:"登录", exact:true}).last().click();
    await page.waitForURL(process.env.V3_LOCAL_APP + path);

    const read = async () => await f.service.read(draft.draftId);
    const stepState = async (stepId: string) => (await read()).snapshot.steps[stepId] as {valid: boolean};
    // Each configured step owns its own field title.
    const goalOf = (n: number) => page.getByRole("textbox", {name:"已知目标 " + n, exact:true});
    const confirmButton = () => page.getByRole("button", {name:"确认本题并继续", exact:true});
    const navigator = page.getByRole("navigation", {name:"本步骤已到达的问题"});
    const stepPill = (n: number) =>
      page.getByRole("navigation", {name:"定位步骤"}).getByRole("button", {name:new RegExp("^" + n + "\\. ")});
    const rowTexts = async () =>
      (await navigator.getByRole("button").allTextContents()).map(t => t.replace(/\s+/g," ").trim());

    // Step 0: confirm the first question, defer the optional one, so step 0 is valid.
    await goalOf(0).fill("初始定位");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(2);
    await page.getByRole("button", {name:"暂时跳过本题", exact:true}).click();
    await expect.poll(async () => (await read()).information["step-0"].values?.other?.status, {timeout:30000}).toBe("deferred");
    await expect.poll(async () => (await stepState("step-0")).valid, {timeout:30000}).toBe(true);

    // Step 1 must be confirmed BEFORE the upstream change, so it can be invalidated.
    await stepPill(2).click();
    await goalOf(1).waitFor();
    await goalOf(1).fill("第二步定位");
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-1")).valid, {timeout:60000}).toBe(true);
    marks.step1Confirmed = Date.now() - startedAt;

    // Q-F2: going back and editing the first answer must not shrink the review list.
    await stepPill(1).click();
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(2);
    const pinned = await rowTexts();
    await navigator.getByRole("button", {name:/^1\.1 /}).click();
    await goalOf(0).fill("修改后的定位");
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("provisional");
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(2);
    await expect.poll(async () => (await rowTexts())[0] ?? "", {timeout:30000}).toContain("待核对");
    const afterEdit = await rowTexts();
    expect(afterEdit.map(t => t.split(" ")[0])).toEqual(pinned.map(t => t.split(" ")[0]));
    expect(afterEdit[0]).toContain("待核对");
    expect(afterEdit[1]).toContain("待定（已暂缓）");
    marks.rowsKeptAfterEdit = Date.now() - startedAt;
    // A refresh keeps the same durable rows.
    await page.reload();
    await expect.poll(async () => (await rowTexts()).length, {timeout:90000}).toBe(2);

    // Q-F1: resubmit the upstream step without changing anything else; that
    // invalidates the confirmed downstream step.
    await navigator.getByRole("button", {name:/^1\.1 /}).click();
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-0")).valid, {timeout:90000}).toBe(true);
    await expect.poll(async () => (await stepState("step-1")).valid, {timeout:60000}).toBe(false);
    marks.downstreamInvalidated = Date.now() - startedAt;

    // The downstream answers are still resolved, but the step needs an explicit
    // reconfirmation; the button must be actionable and the resubmit must stick.
    await stepPill(2).click();
    await expect.poll(async () => confirmButton().isEnabled(), {timeout:30000}).toBe(true);
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-1")).valid, {timeout:90000}).toBe(true);
    marks.downstreamReconfirmed = Date.now() - startedAt;
    expect((await read()).information["step-1"].values?.goal?.value).toBe("第二步定位");
    // A valid step with an unchanged answer offers no duplicate submit.
    await stepPill(2).click();
    await goalOf(1).waitFor();
    await expect.poll(async () => confirmButton().isEnabled(), {timeout:30000}).toBe(false);

    // Q-F3: finish the workflow and check the completion copy does not promise a
    // dialog that does not exist yet.
    await stepPill(3).click();
    await goalOf(2).waitFor();
    await goalOf(2).fill("第三步定位");
    await confirmButton().click();
    await expect.poll(async () => (await stepState("step-2")).valid, {timeout:90000}).toBe(true);
    const completion = page.getByText("全部问题已确认或已明确暂缓", {exact:false}).first();
    await completion.waitFor();
    const completionText = await page.locator("body").textContent();
    expect(completionText).not.toContain("再次明确同意");
    expect(completionText).not.toContain("才会询问是否生成");
    await expect.poll(() => page.getByRole("button", {name:"确认正式定位并生成第一周计划", exact:true}).count(), {timeout:30000}).toBe(1);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    console.log("OPC_QF_MILESTONES " + JSON.stringify({...marks, totalMs: Date.now() - startedAt}));
  } finally {
    await browser.close();
  }
}, 300000);
