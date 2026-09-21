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
import type { Page } from "../../../../../apps/web/node_modules/@playwright/test";
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
  /** Optional per-turn scope; defaults to the call's draft/round. */
  scope?: Readonly<{ draftId: string; roundId: string }>;
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
    draftId: turn.scope?.draftId ?? draftId,
    roundId: turn.scope?.roundId ?? roundId,
    stepId: turn.stepId, purpose: "mentor",
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
async function mentorMessageCheck(
  page: Page,
  actorId: string,
  executionId: string,
): Promise<() => Promise<void>> {
  const rows = (await sql.query<{ body: string | null }>(
    "select coalesce(result->>'body', primary_result->>'body') body from runtime_executions where actor_id=$1 and id=$2",
    [actorId, executionId],
  )).rows;
  expect(rows).toHaveLength(1);
  const payload: unknown = JSON.parse(rows[0].body ?? "null");
  if (!payload || typeof payload !== "object" || !("message" in payload) ||
      typeof payload.message !== "string" || !payload.message.trim())
    throw new Error("expected this execution's completed public message");
  const normalise = (value: string) => value.replace(/\s+/g, " ").trim();
  const expected = normalise(payload.message);
  const paragraph = page.locator(
    `[data-execution-id="${executionId}"] [data-message-role="assistant"] p`,
  );
  return async () => {
    await expect.poll(() => paragraph.count(), { timeout: 60000 }).toBe(1);
    await paragraph.waitFor({ state: "visible", timeout: 60000 });
    await expect.poll(async () => normalise(
      (await paragraph.textContent({ timeout: 5000 })) ?? "",
    ), { timeout: 60000 }).toBe(expected);
  };
}

async function fixture(
  n = 6, secondField = false, extraFields = 0,
  configure?: (flow: ReturnType<typeof makeWorkflow>) => void,
) {
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
  // Configurable extra fields let a focused case exercise more than the two
  // default questions of the first step without a second fixture.
  for (let i = 0; i < extraFields; i++)
    flow.steps[0].information!.push({
      id: "extra" + i,
      title: "Extra field " + i,
      required: false,
      profileKey: "extra_" + i,
    });
  configure?.(flow);
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
  await planFixtureModel(f.moduleId);
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
    await page.getByLabel("业务名称",{exact:true}).fill("已有定位测试业务");
    await page
      .getByRole("button", { name: "我已有定位 · 结构化录入", exact: true })
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
    await page.getByText("直接填写完整策略", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "信息不够，让 Agent 帮我补齐", exact: true }).count()).toBe(1);
    expect(Number((await sql.query("select count(*)::int n from runtime_executions where actor_id=$1", [f.actor])).rows[0].n)).toBe(0);
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
            .getByRole("button", { name: "确认正式定位", exact: true })
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
        .getByRole("button", { name: "确认正式定位", exact: true })
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
      .getByRole("button", { name: "确认正式定位", exact: true })
      .click();
    // The current B1 entry opens the topic conversation. This legacy plan
    // remains directly recoverable, but opening it never inherits the topic
    // consent or starts a model call on its own.
    await page
      .getByRole("dialog", { name: "是否继续生成第一周选题" })
      .getByRole("button", { name: "稍后", exact: true })
      .click();
    await page.goto(draftUrl + "/plan");
    expect(await page.getByLabel("定位摘要").textContent()).toContain("Updated confirmed decision");
    expect(await page.getByLabel("当前定位步骤").count()).toBe(0);
    expect(await page.getByRole("table", {name:"第一周选题计划"}).count()).toBe(1);
    expect(Number((await sql.query("select count(*)::int n from runtime_executions where actor_id=$1", [f.actor])).rows[0].n)).toBe(0);
    await page.getByRole("button", { name: "生成第一周计划", exact: true }).click();
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
    const expectedPlanPath = new URL(draftUrl).pathname + "/plan";
    await page.waitForURL(url => url.pathname === expectedPlanPath);
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
it("OPC: deferred required information preserves draft progress but cannot publish a formal positioning", async () => {
  const f = await fixture(3);
  const d = await f.service.start({ requestId: randomUUID(), registration: f.registration, mode: "manual" });
  for (const step of f.flow.steps) {
    const before = await f.service.read(d.draftId);
    const values = Object.fromEntries(step.information!.map(field => [field.id, {
      status: "deferred", nature: "unknown", value: "用户明确说明目前缺少这项必需信息。",
    }]));
    await f.service.information({ draftId: d.draftId, stepId: step.id, requestId: randomUUID(), expectedVersion: before.snapshot.steps[step.id].version, values });
    const saved = await f.service.read(d.draftId);
    await f.artifacts.execute({ action: "save", projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(), stepId: step.id, expectedVersion: saved.snapshot.steps[step.id].version, body: "暂缓原因已保留", evidenceIds: [] });
    const ready = await f.service.read(d.draftId);
    await f.artifacts.execute({ action: "confirm", projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(), stepId: step.id, expectedVersion: ready.snapshot.steps[step.id].version, expectedReviewVersion: ready.snapshot.steps[step.id].reviewVersion });
  }
  const ready = await f.service.read(d.draftId);
  expect(Object.values(ready.snapshot.steps).every((step: any) => step.valid)).toBe(true);
  await expect(f.artifacts.execute({
    action: "publish", projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(),
    expectedSteps: Object.fromEntries(Object.entries(ready.snapshot.steps).map(([id, step]: [string, any]) => [id, { version: step.version, reviewVersion: step.reviewVersion }])),
  })).rejects.toThrow("ARTIFACT_REVIEW_REQUIRED");
  expect((await f.service.read(d.draftId)).snapshot.state).toBe("draft");
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
  await planFixtureModel(f.moduleId);
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
    await page.getByLabel("业务名称",{exact:true}).fill("导师引导测试业务");
    await page.getByRole("button", { name: "我从零开始 · Agent 引导", exact: true }).click();
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
    expect(afterChat.turns.filter((t: {stepId:string;kind:string})=>
      t.stepId==="step-0" && ["mentor", "organizer"].includes(t.kind))).toHaveLength(3);
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
        turn.stepId === "step-1" && ["mentor", "organizer"].includes(turn.kind),
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
        turn.stepId === "step-0" && ["mentor", "organizer"].includes(turn.kind),
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
    await expect.poll(async() => (await f.service.read(draftId)).information["step-0"].values.goal.value, {timeout:30000}).toBe("改为帮助独立开发者");
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
    await send("摄影课程");
    // Wait for the durable projection under a bounded timeout, then for the UI
    // to show it. The former 1 s UI poll failed intermittently while the
    // request/execute/result-read chain was still in flight.
    await expect.poll(async()=>(await f.service.read(draft.draftId)).information["step-0"].values?.other?.value ?? "",{timeout:30000}).toBe("摄影课程");
    await expect.poll(()=>second().inputValue(),{timeout:30000}).toBe("摄影课程");
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
async function finalized(n = 3, withTopics = false) {
  const f = await fixture(
    n,
    false,
    0,
    withTopics ? (flow) => { flow.planResources = ["SKILL.md"]; } : undefined,
  );
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
  const summaryModel = randomUUID();
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Runtime local','opc-browser','fixture','true',1000,32000)",
    [model],
  );
  await sql.query(
    "insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'OPC organizer',$2,'fixture','true',1000,32000)",
    [summaryModel, "opc-organizer-" + summaryModel],
  );
  await sql.query(
    "insert into system_settings(key,value) values('v3_summary_model_id',to_jsonb($1::text)),('v3_summary_max_tokens','1000'::jsonb) on conflict(key) do update set value=excluded.value",
    [summaryModel],
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
    // The consent marker: these cases seed the envelope that only an explicit
    // "继续生成第一周选题" may write, so they keep proving that a lost reply
    // replays its own identity instead of paying twice.
    v: 3,
    sourceRoundId: options.sourceRoundId ?? f.d.roundId,
    consentedAt: new Date("2026-09-20T07:00:00.000Z").toISOString(),
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
it("OPC: Stage C1 the final positioning confirmation asks first and spends nothing until an explicit continue generates one candidate", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  // This draft's method declares topic resources, so the explicit consent may
  // bind the topic workspace.
  const f = await finalized(3, true);
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
      name: "确认正式定位",
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
    // Confirming the positioning publishes the version and asks. It must not
    // create a generation request by itself.
    const dialog = page.getByRole("dialog", { name: "是否继续生成第一周选题" });
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.count()).toBe(0);
    expect((await topicIdentity(f.actor)).topicExecutions).toBe(0);
    await page.getByRole('button', { name: '继续生成第一周选题', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭选题询问', exact: true }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    expect((await topicIdentity(f.actor)).binds).toBe(0);
    await page.getByRole('button', { name: '继续生成第一周选题', exact: true }).click();
    await dialog.getByRole("button", { name: "稍后", exact: true }).click();
    await expect.poll(() => dialog.count(), { timeout: 15000 }).toBe(0);
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    // A refresh, a re-login or the re-entry control are not consent either.
    await page.reload();
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .waitFor();
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    const asked = await planIdentity(f.actor, f.d.draftId);
    expect(asked.planExecutions).toBe(0);
    expect(asked.planRuns).toBe(0);
    expect(asked.reserves).toBe(0);
    // The explicit continue enters the bound topic workspace. It binds the
    // confirmed version, the pinned method revision and a dedicated Session,
    // and starts the one explicitly accepted first turn.
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath + "/topics"));
    await page
      .getByRole("heading", { name: "第一周选题工作对话", exact: true })
      .waitFor();
    // One canonical reading of the binding row. Mentor Session, topic Session,
    // bind request, frozen source version and creation time are different
    // fields; the earlier failure compared a bind request id with a round id.
    const bindingState = async () =>
      (
        await sql.query(
          "select w.session_id::text topic_session, w.request_id::text bind_request, w.source_version_id::text source_version, w.created_at::text created_at, s.scope topic_scope from opc_topic_workspaces w join runtime_sessions s on s.id=w.session_id and s.actor_id=w.actor_id where w.draft_id=$1 and w.actor_id=$2",
          [f.d.draftId, f.actor],
        )
      ).rows as Array<Record<string, unknown>>;
    const boundRows = await bindingState();
    expect(boundRows).toHaveLength(1);
    const bound = boundRows[0]!;
    // Bound to the confirmed version of this round, in its own Session.
    expect(
      (
        await sql.query(
          "select round_id::text r from artifact_versions where id=$1",
          [bound.source_version],
        )
      ).rows[0].r,
    ).toBe(f.d.roundId);
    expect(bound.topic_scope).toEqual({
      kind: "positioning_topic",
      draftId: f.d.draftId,
    });
    expect(await page.evaluate((k) => sessionStorage.getItem(k), envelopeKey)).toBeNull();
    const after = await planIdentity(f.actor, f.d.draftId);
    // Opening runs under topic purpose, separate from legacy plan generation.
    expect(after.planExecutions - before.planExecutions).toBe(0);
    expect(after.planRuns - before.planRuns).toBe(0);
    await expect.poll(async () => (await topicIdentity(f.actor)).topicExecutions, { timeout: 30000 }).toBe(1);
    // Re-entering with the same confirmed source recovers the very same
    // binding: same Session, same bind identity, no second workspace.
    await page.goto(process.env.V3_LOCAL_APP + draftPath);
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath + "/topics"));
    await page
      .getByRole("heading", { name: "第一周选题工作对话", exact: true })
      .waitFor();
    const againRows = await bindingState();
    expect(againRows).toHaveLength(1);
    // The identical row: same topic Session, same bind request identity, same
    // frozen source version and the same creation time.
    expect(againRows[0]).toEqual(bound);
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
it("OPC: Stage C5 an unadmitted old-round request stays recoverable and never becomes current generation", async () => {
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
    await page.getByRole('heading', { name: '本机保留了一条早先的生成请求', exact: true }).waitFor();
    const original = await page.evaluate(k => sessionStorage.getItem(k), key);
    expect(JSON.parse(original!).request.requestId).toBe(staleRequestId);
    await page.getByRole('button', { name: '继续这条原请求', exact: true }).click();
    await expect.poll(async () => (await page.getByRole('status').allTextContents()).join(' ')).toContain('服务端尚无可恢复执行');
    expect(await page.evaluate(k => sessionStorage.getItem(k), key)).toBe(original);
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
    await expect.poll(() => page.getByRole("button", {name:"确认正式定位", exact:true}).count(), {timeout:30000}).toBe(1);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    console.log("OPC_QF_MILESTONES " + JSON.stringify({...marks, totalMs: Date.now() - startedAt}));
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: clicking a review row opens that reached question without advancing progression or spending", async () => {
  const {chromium} = await import("../../../../../apps/web/node_modules/@playwright/test");
  // Five questions in the first step: q1, q2, q3, q4 reached, q5 never reached.
  const f = await fixture(3, false, 4), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Review select local','opc-review-select','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  const startedAt = Date.now();
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
    const counts = async () => (await sql.query(
      `select (select count(*)::int from runtime_executions where actor_id=$1) executions,
              (select count(*)::int from bill2_runs where actor_id=$1) runs,
              (select count(*)::int from credit_transactions where user_id=$1 and reason_code='bill2_reserve') reserves`,
      [f.actor],
    )).rows[0] as {executions:number; runs:number; reserves:number};
    const field = (title: string) => page.getByRole("textbox", {name:title, exact:true});
    const heading = () =>
      page.locator("section[aria-label='本步填写信息']").getByRole("heading", {level:3});
    const confirmButton = () => page.getByRole("button", {name:"确认本题并继续", exact:true});
    const navigator = page.getByRole("navigation", {name:"本步骤已到达的问题"});
    const rowTexts = async () =>
      (await navigator.getByRole("button").allTextContents()).map(t => t.replace(/\s+/g," ").trim());
    const row = (label: string) => navigator.getByRole("button", {name:new RegExp("^" + label.replace(".","\\.") + " ")});

    // q1, q2 confirmed; q3 deferred; that reaches q4 and never q5.
    await field("已知目标 0").fill("客户定位");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.2");
    await field("Extra field 0").fill("第二条事实");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.extra0?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.3");
    await page.getByRole("button", {name:"暂时跳过本题", exact:true}).click();
    await expect.poll(async () => (await read()).information["step-0"].values?.extra1?.status, {timeout:30000}).toBe("deferred");
    await expect.poll(async () => (await read()).information["step-0"].values?.extra2?.status, {timeout:30000}).not.toBe("confirmed");
    await expect.poll(async () => (await rowTexts()).length, {timeout:60000}).toBe(4);
    expect((await rowTexts()).join(" | ")).not.toContain("Extra field 3");

    // Edit q1 and let its real autosave land: rows must stay q1..q4.
    await row("1.1").click();
    await field("已知目标 0").fill("客户定位（修改）");
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("provisional");
    await expect.poll(async () => (await rowTexts()).length, {timeout:30000}).toBe(4);
    await expect.poll(async () => (await rowTexts())[0] ?? "", {timeout:30000}).toContain("待核对");
    const rowsWhileEditing = await rowTexts();
    expect(rowsWhileEditing.map(t => t.split(" ")[0])).toEqual(["1.1","1.2","1.3","1.4"]);
    expect(rowsWhileEditing[1]).toContain("已确认");
    expect(rowsWhileEditing[2]).toContain("待定（已暂缓）");
    // Wait for every related opening/request to reach a verifiable terminal
    // state, then freeze the exact identity set as the review-only baseline.
    await expect.poll(async () => Number((await sql.query(
      "select count(*)::int n from runtime_executions where actor_id=$1 and state not in ('completed','failed','cancelled')",
      [f.actor],
    )).rows[0].n), {timeout:60000}).toBe(0);
    const identitySignature = async () => (await sql.query(
      "select coalesce(string_agg(id::text||':'||state||':'||coalesce(request_id::text,''), ',' order by created_at,id),'') s from runtime_executions where actor_id=$1",
      [f.actor],
    )).rows[0].s as string;
    const settled = await counts();
    const settledIdentity = await identitySignature();

    // Clicking q3 must display q3, not jump back to the pending q1.
    await row("1.3").click();
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.3");
    await expect.poll(async () => field("Extra field 1").count(), {timeout:30000}).toBe(1);
    expect(await field("Extra field 1").inputValue()).toBe("用户明确选择暂不提供此选填信息。");
    await expect.poll(() => row("1.3").getAttribute("aria-current"), {timeout:15000}).toBe("true");
    // Clicking q4 must display q4 as well.
    await row("1.4").click();
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.4");
    await expect.poll(async () => field("Extra field 2").count(), {timeout:30000}).toBe(1);
    expect(await field("Extra field 2").inputValue()).toBe("");
    await expect.poll(() => row("1.4").getAttribute("aria-current"), {timeout:15000}).toBe("true");
    // The pending progression question is still q1, and a review-only selection
    // may not confirm, defer or spend.
    expect((await read()).information["step-0"].values?.goal?.status).toBe("provisional");
    await expect.poll(() => confirmButton().isEnabled(), {timeout:15000}).toBe(false);
    await expect.poll(async () => page.getByText("这是回看较早的问题", {exact:false}).count(), {timeout:15000}).toBeGreaterThan(0);
    expect(await counts()).toEqual(settled);
    expect(await identitySignature()).toBe(settledIdentity);
    // Only the "当前" marker follows the selection; identity, order and the
    // answer states of every row stay unchanged.
    const stripCurrent = (rows: string[]) => rows.map(t => t.replace(" · 当前", ""));
    expect(stripCurrent(await rowTexts())).toEqual(stripCurrent(rowsWhileEditing));

    // Refresh keeps the same rows and the same click behaviour.
    await page.reload();
    await expect.poll(async () => (await rowTexts()).length, {timeout:90000}).toBe(4);
    await row("1.4").click();
    await expect.poll(async () => heading().textContent(), {timeout:60000}).toContain("1.4");
    expect(await counts()).toEqual(settled);

    // Reconfirming the pending q1 continues normally.
    await row("1.1").click();
    await field("已知目标 0").waitFor();
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:60000}).toBe("confirmed");
    expect((await read()).snapshot.steps["step-0"].valid).toBe(false);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    console.log("OPC_QF2_MILESTONES " + JSON.stringify({
      rowsReached: rowsWhileEditing.length,
      settled,
      totalMs: Date.now() - startedAt,
    }));
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: a legally reached question keeps its explicit confirm and mentor send while review stays display-only", async () => {
  const {chromium} = await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3, false, 4), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Legal action local','opc-legal-action','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  const startedAt = Date.now();
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
    const field = (title: string) => page.getByRole("textbox", {name:title, exact:true});
    const composer = () => page.getByRole("textbox", {name:"给导师的回复", exact:true});
    const heading = () => page.locator("section[aria-label='本步填写信息']").getByRole("heading", {level:3});
    const confirmButton = () => page.getByRole("button", {name:"确认本题并继续", exact:true});
    const navigator = page.getByRole("navigation", {name:"本步骤已到达的问题"});
    const rowTexts = async () =>
      (await navigator.getByRole("button").allTextContents()).map(t => t.replace(/\s+/g," ").trim());
    const row = (label: string) => navigator.getByRole("button", {name:new RegExp("^" + label.replace(".","\\.") + " ")});
    const executions = async () => (await sql.query(
      "select id::text id, request_id::text \"requestId\", state, payload->'request'->'selection'->>'task' task from runtime_executions where actor_id=$1 order by created_at, id",
      [f.actor],
    )).rows as Array<{id:string;requestId:string;state:string;task:string|null}>;

    // q1/q2 confirmed, q3 has a substantive answer but is deferred, q4 pending.
    await field("已知目标 0").fill("客户定位");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.2");
    await field("Extra field 0").fill("第二条事实");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.extra0?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.3");
    await field("Extra field 1").fill("第三条实质答案");
    await page.getByRole("button", {name:"暂时跳过本题", exact:true}).click();
    await expect.poll(async () => (await read()).information["step-0"].values?.extra1?.status, {timeout:30000}).toBe("deferred");
    await expect.poll(async () => (await rowTexts()).length, {timeout:60000}).toBe(4);
    expect((await rowTexts()).join(" | ")).not.toContain("Extra field 3");

    // q3 is a legal, already reached question: revisiting it must keep the
    // explicit actions available (this is the Q-F2-ACTION regression).
    await row("1.3").click();
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.3");
    expect(await field("Extra field 1").inputValue()).toBe("第三条实质答案");
    await expect.poll(() => confirmButton().isEnabled(), {timeout:30000}).toBe(true);
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.extra1?.status, {timeout:60000}).toBe("confirmed");
    expect((await read()).information["step-0"].values?.extra1?.value).toBe("第三条实质答案");
    expect((await read()).information["step-0"].values?.extra2?.status).not.toBe("confirmed");
    expect((await rowTexts()).join(" | ")).not.toContain("Extra field 3");

    // An explicit mentor send on a legal reached question is allowed and freezes
    // that question's identity in the request.
    await row("1.3").click();
    await field("Extra field 1").waitFor();
    const before = await executions();
    const settledActorCounts = (await sql.query(
      `select (select count(*)::int from runtime_executions where actor_id=$1) executions,
              (select count(*)::int from bill2_runs where actor_id=$1) runs,
              (select count(*)::int from credit_transactions where user_id=$1 and reason_code='bill2_reserve') reserves,
              (select count(*)::int from runtime_executions e left join bill2_runs b on b.id=e.billing_run_id where e.actor_id=$1 and b.id is null) unlinked`,
      [f.actor],
    )).rows[0];
    const submittedRequestIds: string[] = [];
    page.on("request", request => {
      if (request.method() !== "POST" || !request.url().includes("opc.prepareStep")) return;
      const match = /"requestId":"([0-9a-f-]{36})"/.exec(request.postData() ?? "");
      if (match) submittedRequestIds.push(match[1]);
    });
    await composer().fill("补充一条关于第三条的说明");
    await expect.poll(() => page.getByRole("button", {name:"发送", exact:true}).isEnabled(), {timeout:30000}).toBe(true);
    await page.getByRole("button", {name:"发送", exact:true}).click();
    await expect.poll(async () => (await executions()).length, {timeout:60000}).toBe(before.length + 1);
    const after = await executions();
    const newRow = after.find(row => !before.some(prev => prev.id === row.id));
    expect(newRow?.task).toBe("opc-question:extra1");
    // Admission identity is not a completed turn: wait for the terminal state and
    // verify the exact execution/request/billing identities, the reserve, and the
    // user-visible reply before this counts as conversation proof.
    await expect.poll(async () => ((await executions()).find(row => row.id === newRow!.id)?.state ?? ""), {timeout:90000}).toBe("completed");
    const sentIdentity = (await sql.query(
      `select e.state, b.id::text billing_id, b.state billing_state, b.pre_deduct_id::text pre_deduct_id
         from runtime_executions e left join bill2_runs b on b.id=e.billing_run_id
        where e.actor_id=$1 and e.id=$2`,
      [f.actor, newRow!.id],
    )).rows[0] as {state:string;billing_id:string|null;billing_state:string|null;pre_deduct_id:string|null};
    expect(sentIdentity.state).toBe("completed");
    expect(sentIdentity.billing_id).toBeTruthy();
    // The deterministic synthetic fixture settles; a pending/unknown cost would
    // mean the accounting path did not finish.
    expect(sentIdentity.billing_state).toBe("settled");
    expect(sentIdentity.pre_deduct_id).toBeTruthy();
    // The execution is tied to the request id the browser actually submitted.
    expect(newRow!.requestId).toBe(submittedRequestIds.at(-1));
    // Exactly one mentor turn exists for that request, on the selected question.
    expect((await sql.query(
      "select count(*)::int n from opc_turns t where t.draft_id=$1 and t.step_id='step-0' and t.purpose='mentor' and t.request_id=$2",
      [draft.draftId, newRow!.requestId],
    )).rows[0].n).toBe(1);
    expect((await sql.query(
      "select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve' and source_id=$2",
      [f.actor, sentIdentity.billing_id],
    )).rows[0].n).toBe(1);
    // The visible reply must belong to THIS execution's assistant bubble and be
    // the authorized completed public message — an input echo is not enough.
    const storedReply = String((await sql.query(
      "select coalesce(result->>'body', primary_result->>'body') body from runtime_executions where actor_id=$1 and id=$2",
      [f.actor, newRow!.id],
    )).rows[0].body ?? "");
    const assistantBubble = page.locator(
      `[data-execution-id="${newRow!.id}"] [data-message-role="assistant"]`,
    );
    const userBubble = page.locator(
      `[data-execution-id="${newRow!.id}"] [data-message-role="user"]`,
    );
    await expect.poll(async () => (await assistantBubble.textContent()) ?? "", {timeout:60000})
      .toContain("【分步模拟，仅验证流程】");
    const assistantText = ((await assistantBubble.textContent()) ?? "").trim();
    expect(assistantText.length).toBeGreaterThan(20);
    expect(assistantText).not.toContain("这条回复还在核对原请求");
    expect(assistantText).not.toContain("这条回复未发给模型");
    expect((await userBubble.textContent()) ?? "").toContain("补充一条关于第三条的说明");
    expect(assistantText).not.toBe(((await userBubble.textContent()) ?? "").trim());
    let storedMessage = storedReply;
    try {
      const parsedStored = JSON.parse(storedReply) as { message?: unknown };
      if (typeof parsedStored?.message === "string") storedMessage = parsedStored.message;
    } catch { /* a plain-text body is already the message */ }
    expect(storedMessage.trim().length).toBeGreaterThan(20);
    // Compare the whole public message, normalising only whitespace.
    const normalise = (value: string) => value.replace(/\s+/g, " ").trim();
    const bubbleParagraph = normalise(
      (await assistantBubble.locator("p").first().textContent()) ?? assistantText,
    );
    expect(bubbleParagraph).toBe(normalise(storedMessage));
    // Actor-wide identity accounting: exactly one new execution/run/reserve and
    // every one of them is linked, so an unlinked extra run cannot hide.
    const actorAfter = await sql.query(
      `select (select count(*)::int from runtime_executions where actor_id=$1) executions,
              (select count(*)::int from bill2_runs where actor_id=$1) runs,
              (select count(*)::int from credit_transactions where user_id=$1 and reason_code='bill2_reserve') reserves,
              (select count(*)::int from runtime_executions e left join bill2_runs b on b.id=e.billing_run_id where e.actor_id=$1 and b.id is null) unlinked`,
      [f.actor],
    );
    expect(actorAfter.rows[0]).toEqual({
      executions: settledActorCounts.executions + 1,
      runs: settledActorCounts.runs + 1,
      reserves: settledActorCounts.reserves + 1,
      unlinked: settledActorCounts.unlinked,
    });
    expect((await executions()).filter(row => row.task === "opc-question:extra1")).toHaveLength(1);
    expect((await read()).information["step-0"].values?.extra2?.status).not.toBe("confirmed");
    expect((await rowTexts()).join(" | ")).not.toContain("Extra field 3");

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    console.log("OPC_QF2_ACTION_MILESTONES " + JSON.stringify({
      executionsBefore: before.length,
      executionsAfter: after.length,
      newTask: newRow?.task ?? null,
      totalMs: Date.now() - startedAt,
    }));
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: an immutable information snapshot reconstructs the reached frontier when the next question never opened", async () => {
  const {chromium} = await import("../../../../../apps/web/node_modules/@playwright/test");
  const f = await fixture(3, false, 4), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Frontier local','opc-frontier','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const host = new URL(route.request().url()).hostname;
      return ["127.0.0.1","localhost"].includes(host) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(90000);
    const path = "/positioning/" + draft.draftId;
    const ready = page.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), {timeout: 90000});
    await page.goto(process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path));
    await ready;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", {name:"登录", exact:true}).last().click();
    await page.waitForURL(process.env.V3_LOCAL_APP + path);
    await page.route("**/api/trpc/opc.prepareStep*", async route => {
      const raw = route.request().postData() ?? "";
      return raw.includes("extra2") ? route.abort() : route.continue();
    });
    const read = async () => await f.service.read(draft.draftId);
    const field = (title: string) => page.getByRole("textbox", {name:title, exact:true});
    const heading = () => page.locator("section[aria-label='本步填写信息']").getByRole("heading", {level:3});
    const confirmButton = () => page.getByRole("button", {name:"确认本题并继续", exact:true});
    const navigator = page.getByRole("navigation", {name:"本步骤已到达的问题"});
    const rowTexts = async () =>
      (await navigator.getByRole("button").allTextContents()).map(t => t.replace(/\s+/g," ").trim());
    const row = (label: string) => navigator.getByRole("button", {name:new RegExp("^" + label.replace(".","\\.") + " ")});
    const snapshots = async () => (await sql.query(
      "select (response->>'version')::int version, payload->'values' values from artifact_requests where project_id=$1 and round_id=$2 and action='opc_information' order by (response->>'version')::int",
      [draft.projectId, draft.roundId],
    )).rows as Array<{version:number; values:Record<string,{status?:string}>}>;
    const schemaIds = ["goal","extra0","extra1","extra2","extra3"];
    const isResolved = (values:Record<string,{status?:string}>, id:string) =>
      ["confirmed","deferred"].includes(values[id]?.status ?? "");
    const settled = (values:Record<string,{status?:string}>) =>
      values.goal?.status === "confirmed" && values.extra0?.status === "confirmed" && values.extra1?.status === "deferred";

    await field("已知目标 0").fill("客户定位");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.2");
    await field("Extra field 0").fill("第二条事实");
    await confirmButton().click();
    await expect.poll(async () => (await read()).information["step-0"].values?.extra0?.status, {timeout:30000}).toBe("confirmed");
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.3");
    await field("Extra field 1").fill("第三条实质答案");
    await page.getByRole("button", {name:"暂时跳过本题", exact:true}).click();
    await expect.poll(async () => (await read()).information["step-0"].values?.extra1?.status, {timeout:30000}).toBe("deferred");
    await expect.poll(async () => (await rowTexts()).length, {timeout:60000}).toBe(4);
    const q4Turns = Number((await sql.query(
      "select count(*)::int n from opc_turns t join runtime_executions e on e.session_id=t.session_id and e.request_id=t.request_id where t.draft_id=$1 and t.step_id='step-0' and t.round_id=$2 and e.payload->'request'->'selection'->>'task'='opc-opening:extra2'",
      [draft.draftId, draft.roundId],
    )).rows[0].n);
    expect(q4Turns).toBe(0);
    const turnsBeforeRecovery = Number((await sql.query(
      "select count(*)::int n from opc_turns t where t.draft_id=$1 and t.step_id='step-0' and t.round_id=$2",
      [draft.draftId, draft.roundId],
    )).rows[0].n);

    const preEdit = await snapshots();
    const snapshot = preEdit.find(s => settled(s.values));
    expect(snapshot).toBeTruthy();
    expect(schemaIds.filter(id => isResolved(snapshot!.values, id))).toEqual(["goal","extra0","extra1"]);
    const nextUnresolved = schemaIds.findIndex(id => !isResolved(snapshot!.values, id));
    expect(schemaIds[nextUnresolved]).toBe("extra2");
    expect(schemaIds[nextUnresolved + 1]).toBe("extra3");

    await row("1.1").click();
    await field("已知目标 0").fill("客户定位（修改）");
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("provisional");
    await page.reload();
    // With the bounded historical reach from this round's snapshots, the empty
    // and never-opened q4 stays reviewable after the earlier edit.
    await expect.poll(async () => (await rowTexts()).length, {timeout:90000}).toBe(4);
    expect((await rowTexts())[3]).toContain("Extra field 2");
    expect((await rowTexts()).join(" | ")).not.toContain("Extra field 3");
    expect((await snapshots()).some(s => settled(s.values))).toBe(true);
    // q4 is selectable and readable, but passive recovery must not make it
    // confirmable or create any new execution/opening for it.
    await row("1.4").click();
    await expect.poll(async () => heading().textContent(), {timeout:30000}).toContain("1.4");
    expect(await field("Extra field 2").inputValue()).toBe("");
    await expect.poll(() => row("1.4").getAttribute("aria-current"), {timeout:15000}).toBe("true");
    await expect.poll(() => confirmButton().isEnabled(), {timeout:15000}).toBe(false);
    expect((await read()).information["step-0"].values?.goal?.status).toBe("provisional");
    // Passive recovery created no new turn/execution for q4.
    expect(Number((await sql.query(
      "select count(*)::int n from opc_turns t where t.draft_id=$1 and t.step_id='step-0' and t.round_id=$2",
      [draft.draftId, draft.roundId],
    )).rows[0].n)).toBe(turnsBeforeRecovery);

    await row("1.1").click();
    await field("已知目标 0").fill("客户定位（再次修改）");
    await expect.poll(async () => (await read()).information["step-0"].values?.goal?.status, {timeout:30000}).toBe("provisional");
    const recovered = (await snapshots()).find(s => settled(s.values));
    expect(recovered).toBeTruthy();
    expect(schemaIds.findIndex(id => !isResolved(recovered!.values, id))).toBe(3);
    // Repeated later edits (more than fields x 2) must not lose the historical
    // maximum, and the reach must stay stable.
    for (let i = 0; i < 10; i++) {
      await row("1.1").click();
      const goalInput = field("已知目标 0");
      await goalInput.waitFor();
      const nextValue = "客户定位（多次修改 " + i + "）";
      await goalInput.fill(nextValue);
      // Wait for the typed value first, then for its persisted value.
      await expect.poll(async () => await goalInput.inputValue(), {timeout:30000}).toBe(nextValue);
      await expect.poll(async () =>
        (await read()).information["step-0"].values?.goal?.value ?? "", {timeout:60000},
      ).toBe(nextValue);
    }
    await page.reload();
    await expect.poll(async () => (await rowTexts()).length, {timeout:90000}).toBe(4);
    expect((await rowTexts()).join(" | ")).not.toContain("Extra field 3");
    // Another actor's stronger-looking history must not influence this frontier.
    const other = await fixture(3, false, 0);
    const otherDraft = await other.service.start({requestId: randomUUID(), registration: other.registration, mode: "mentor"});
    const otherVersion = (await other.service.read(otherDraft.draftId)).snapshot.steps["step-0"].version;
    await other.service.information({
      draftId: otherDraft.draftId, stepId: "step-0", requestId: randomUUID(), expectedVersion: otherVersion,
      values: { goal: { status: "confirmed", nature: "fact", value: "另一个账号的定位" } },
    });
    expect((await read()).information["step-0"].values?.goal?.status).toBe("provisional");
    expect((await rowTexts()).length).toBe(4);
    const foreignRequests = Number((await sql.query(
      "select count(*)::int n from artifact_requests where project_id=$1 and round_id<>$2",
      [draft.projectId, draft.roundId],
    )).rows[0].n);
    expect(foreignRequests).toBe(0);
    // The reach helper is internal: it is not callable through the public RPC
    // surface, and another step's own reach is not polluted by this step.
    const deniedReach = await admin.rpc("opc_historical_reach", {
      p_actor_id: f.actor,
      p_draft_id: draft.draftId,
      p_step_id: "step-0",
    });
    expect(deniedReach.error).toBeTruthy();
    expect(
      ((await read()).information["step-1"] as { reached?: string[] }).reached ?? [],
    ).toEqual([]);
    // Real logout/login (a fresh context, not another reload) keeps the four
    // server-backed rows and hides q5.
    const relogin = await browser.newContext();
    await relogin.route("**/*", route => {
      const host = new URL(route.request().url()).hostname;
      return ["127.0.0.1","localhost"].includes(host) ? route.continue() : route.abort();
    });
    const page2 = await relogin.newPage();
    page2.setDefaultTimeout(30000);
    page2.setDefaultNavigationTimeout(90000);
    const ready2 = page2.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), {timeout: 90000});
    await page2.goto(process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(path));
    await ready2;
    await page2.getByPlaceholder("name@example.com").fill(f.email);
    await page2.getByPlaceholder("输入你的密码").fill(f.password);
    await page2.getByRole("button", {name:"登录", exact:true}).last().click();
    await page2.waitForURL(process.env.V3_LOCAL_APP + path);
    const rowsAfterRelogin = async () =>
      (await page2.getByRole("navigation", {name:"本步骤已到达的问题"}).getByRole("button").allTextContents())
        .map(t => t.replace(/\s+/g," ").trim());
    await expect.poll(async () => (await rowsAfterRelogin()).length, {timeout:90000}).toBe(4);
    expect((await rowsAfterRelogin()).join(" | ")).not.toContain("Extra field 3");
    await relogin.close();
    console.log("OPC_FRONTIER_EVIDENCE " + JSON.stringify({
      snapshotsBeforeEdit: preEdit.length,
      settledSnapshotVersion: snapshot!.version,
      recoveredSnapshotVersion: recovered!.version,
      frontier: "extra2",
      nextUnreached: "extra3",
      q4Turns,
      rowsAfterEditRefresh: (await rowTexts()).length,
    }));
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: the historical reach projection is idempotent, permission-scoped and contamination-safe", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  // Five fields keeps q4/q5 unreached, so a foreign stronger frontier would be
  // visible if it leaked and a rejected write could really extend reach.
  const f = await fixture(3, false, 4), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Reach local','opc-reach','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const draft = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const stepVersion = async (stepId: string) =>
    (await f.service.read(draft.draftId)).snapshot.steps[stepId].version;
  const reachOf = async (stepId: string) =>
    ((await f.service.read(draft.draftId)).information[stepId] as { reached?: string[] }).reached ?? [];

  // Reproduce the previous read contract for real: restore 0110 (no `reached`),
  // then create records under it before applying 0111.
  const migration = (name: string) => readFileSync(
    resolve(import.meta.dirname, "../../../../db/migrations/" + name),
    "utf8",
  );
  // The whole transition runs under one failure-safe cleanup: any failure —
  // including the first swap — restores the current read definition, and the
  // original error is preserved (the restore never masks it).
  try {
  await sql.query(migration("0110_opc_turn_round_ownership.sql"));
  const priorRead = await f.service.read(draft.draftId);
  expect(Object.hasOwn(priorRead.information["step-0"], "reached")).toBe(false);

  await f.service.information({
    draftId: draft.draftId, stepId: "step-0", requestId: randomUUID(),
    expectedVersion: await stepVersion("step-0"),
    values: {
      goal: { status: "confirmed", nature: "fact", value: "客户定位" },
      extra0: { status: "deferred", nature: "unknown", value: "暂缓的原因" },
      extra1: { status: "unknown", nature: "unknown", value: "" },
      extra2: { status: "unknown", nature: "unknown", value: "" },
      extra3: { status: "unknown", nature: "unknown", value: "" },
    },
  });
  const before = await f.service.read(draft.draftId);
  const beforeKeys = Object.keys(before).sort();
  const beforeSteps = JSON.stringify(before.snapshot.steps);
  const beforeValues = JSON.stringify(before.information["step-0"].values);
  expect(Object.hasOwn(before.information["step-0"], "reached")).toBe(false);

  // Upgrade: the prior records must survive and the new reach must appear.
  await sql.query(migration("0111_opc_historical_reach.sql"));
  const after = await f.service.read(draft.draftId);
  expect(Object.keys(after).sort()).toEqual(beforeKeys);
  expect(JSON.stringify(after.snapshot.steps)).toBe(beforeSteps);
  expect(JSON.stringify(after.information["step-0"].values)).toBe(beforeValues);
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);

  // Restore the prior contract and re-apply 0111 without losing records.
  await sql.query(migration("0110_opc_turn_round_ownership.sql"));
  const restored = await f.service.read(draft.draftId);
  expect(Object.hasOwn(restored.information["step-0"], "reached")).toBe(false);
  expect(JSON.stringify(restored.snapshot.steps)).toBe(beforeSteps);
  expect(JSON.stringify(restored.information["step-0"].values)).toBe(beforeValues);
  await sql.query(migration("0111_opc_historical_reach.sql"));
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  expect(JSON.stringify((await f.service.read(draft.draftId)).snapshot.steps)).toBe(beforeSteps);
  } finally {
    try {
      await sql.query(migration("0111_opc_historical_reach.sql"));
    } catch (restoreError) {
      console.error("reach read-contract restore failed", String(restoreError));
      throw restoreError;
    }
  }

  // Revoked scope is denied with the exact code through the normal read entry,
  // and the flag is restored even if the assertion fails.
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  try {
    await sql.query("update bill2_drafts set revoked=true where id=$1", [draft.draftId]);
    await expect(f.service.read(draft.draftId)).rejects.toThrow("OPC_DENIED");
  } finally {
    await sql.query("update bill2_drafts set revoked=false where id=$1", [draft.draftId]);
  }
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);

  // Grants: the helper is internal-only and the read entry stays service-role only.
  const privilege = async (role: string, fn: string) => Number((await sql.query(
    "select has_function_privilege($1,$2,'EXECUTE')::int p", [role, fn],
  )).rows[0].p);
  expect(await privilege("service_role","opc_query(uuid,uuid)")).toBe(1);
  expect(await privilege("anon","opc_query(uuid,uuid)")).toBe(0);
  expect(await privilege("authenticated","opc_query(uuid,uuid)")).toBe(0);
  for (const role of ["anon","authenticated","service_role"])
    expect(await privilege(role,"opc_historical_reach(uuid,uuid,text)")).toBe(0);

  // Denied entry point: another authenticated actor cannot read this draft, and
  // its own longer, stronger frontier must not leak into this draft.
  const other = await fixture(3, false, 4);
  const otherDraft = await other.service.start({requestId: randomUUID(), registration: other.registration, mode: "mentor"});
  const otherVersion = (await other.service.read(otherDraft.draftId)).snapshot.steps["step-0"].version;
  await other.service.information({
    draftId: otherDraft.draftId, stepId: "step-0", requestId: randomUUID(), expectedVersion: otherVersion,
    values: {
      goal: { status: "confirmed", nature: "fact", value: "别的账号第一步" },
      extra0: { status: "confirmed", nature: "fact", value: "别的账号第二步" },
      extra1: { status: "confirmed", nature: "fact", value: "别的账号第三步" },
      extra2: { status: "confirmed", nature: "fact", value: "别的账号第四步" },
      extra3: { status: "unknown", nature: "unknown", value: "" },
    },
  });
  await expect(other.service.read(draft.draftId)).rejects.toThrow();
  expect(((await other.service.read(otherDraft.draftId)).information["step-0"] as { reached?: string[] }).reached)
    .toEqual(["goal","extra0","extra1","extra2","extra3"]);
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);

  // Absent history falls back honestly instead of claiming a frontier.
  const fresh = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  expect(((await f.service.read(fresh.draftId)).information["step-0"] as { reached?: string[] }).reached ?? [])
    .toEqual([]);

  // Contamination control: another step with the same field id and a longer
  // prefix must not extend this step's reach.
  await f.service.information({
    draftId: draft.draftId, stepId: "step-1", requestId: randomUUID(),
    expectedVersion: await stepVersion("step-1"),
    values: { goal: { status: "confirmed", nature: "fact", value: "第二步已确认" } },
  });
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  expect(await reachOf("step-1")).toEqual(["goal"]);

  // A definitely rejected write cannot add reach.
  await expect(f.service.information({
    draftId: draft.draftId, stepId: "step-0", requestId: randomUUID(), expectedVersion: 999,
    values: {
      goal: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra0: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra1: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra2: { status: "confirmed", nature: "fact", value: "不应写入" },
      extra3: { status: "confirmed", nature: "fact", value: "不应写入" },
    },
  })).rejects.toThrow();
  expect(await reachOf("step-0")).toEqual(["goal","extra0","extra1"]);
  expect(Number((await sql.query(
    "select count(*)::int n from artifact_requests where project_id=$1 and round_id=$2 and action='opc_information' and payload->>'stepId'='step-0'",
    [draft.projectId, draft.roundId],
  )).rows[0].n)).toBe(1);
  console.log("OPC_REACH_COMPAT " + JSON.stringify({
    rowsForStep: 1,
    reach: ["goal","extra0","extra1"],
    otherStepReach: ["goal"],
  }));
}, 300000);

it("OPC: a second published revision drives new drafts while an existing draft stays pinned", async () => {
  const f = await fixture(3, false, 4), model = randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit) values($1,'Revision local','opc-revision','fixture','true',1000,32000)",[model]);
  await sql.query("update modules set model_id=$1 where id=$2",[model,f.moduleId]);
  const first = await f.service.start({requestId: randomUUID(), registration: f.registration, mode: "mentor"});
  const schemaOf = async (draftId: string, stepId: string) =>
    (await f.service.read(draftId)).information[stepId].schema as Array<{id:string;title:string;elicitation?:string}>;
  const reachOfStep = async (draftId: string, stepId: string) =>
    ((await f.service.read(draftId)).information[stepId] as { reached?: string[] }).reached ?? [];
  const versionOf = async (draftId: string, stepId: string) =>
    (await f.service.read(draftId)).snapshot.steps[stepId].version;

  const firstSchema = await schemaOf(first.draftId, "step-0");
  expect(firstSchema.map(field => field.id)).toEqual(["goal","extra0","extra1","extra2","extra3"]);
  await f.service.information({
    draftId: first.draftId, stepId: "step-0", requestId: randomUUID(),
    expectedVersion: await versionOf(first.draftId, "step-0"),
    values: {
      goal: { status: "confirmed", nature: "fact", value: "第一步目标" },
      extra0: { status: "deferred", nature: "unknown", value: "第一步暂缓" },
      extra1: { status: "unknown", nature: "unknown", value: "" },
      extra2: { status: "unknown", nature: "unknown", value: "" },
      extra3: { status: "unknown", nature: "unknown", value: "" },
    },
  });
  expect(await reachOfStep(first.draftId, "step-0")).toEqual(["goal","extra0","extra1"]);

  // Publish a second revision of the same module: renamed, reordered, fewer
  // fields, a repeated title across steps and one agent_proposal role.
  // Republish the SAME skill: the factory keeps the outer id, the descriptor
  // packageId, the file hashes and the prior version coherent (a hand-patched
  // identity would be rejected as INVALID_PACKAGE before any publication).
  const pack2 = makePackage(f.pack.id, true), registration2 = "opc2-" + randomUUID(), flow2 = makeWorkflow(3, false);
  expect(pack2.id).toBe(f.pack.id);
  expect(pack2.descriptor.packageId).toBe(pack2.id);
  expect(pack2.revisionId).not.toBe(f.pack.revisionId);
  expect(pack2.expectedVersion).toBe(1);
  expect(pack2.descriptor.packageHash).toBe(
    (await import("../skills/loader")).packageHash(pack2.descriptor),
  );
  flow2.steps.forEach((step, index) => {
    step.information = index === 0
      ? [
          { id: "extra1", title: "重复标题", required: false, profileKey: "r_extra1" },
          { id: "goal", title: "Renamed goal", required: true, profileKey: "r_goal" },
          { id: "extra0", title: "重复标题", required: false, profileKey: "r_extra0", elicitation: "agent_proposal" },
        ]
      : [{ id: "goal", title: "重复标题", required: true, profileKey: "r_goal_" + index }];
  });
  await publishSkillPackage(admin, f.owner, pack2);
  await sql.query(
    "insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)",
    [registration2, f.moduleId, pack2.id, pack2.revisionId, flow2, "第二版定位"],
  );
  const secondRequestId = randomUUID();
  let second: {draftId: string; roundId?: string};
  try {
    second = await f.service.start({requestId: secondRequestId, registration: registration2, mode: "mentor"});
  } catch (error) {
    // Observe (never replace) the same request so the failed action's identity is
    // preserved while the raw database error is surfaced for a local test.
    const raw = await sql.query(
      "select opc_start($1,$2,$3,$4) result", [f.actor, secondRequestId, registration2, "mentor"],
    ).then(() => "replayed without error").catch((cause) => String((cause as Error).message));
    throw new Error("second registration refused: " + String((error as Error).message) + " | raw: " + raw);
  }
  const secondSchema = await schemaOf(second!.draftId, "step-0");
  expect(secondSchema.map(field => field.id)).toEqual(["extra1","goal","extra0"]);
  expect(secondSchema.map(field => field.title)).toEqual(["重复标题","Renamed goal","重复标题"]);
  expect(secondSchema[2].elicitation).toBe("agent_proposal");
  expect((await schemaOf(second!.draftId, "step-1")).map(field => field.title)).toEqual(["重复标题"]);
  // The existing draft stays pinned to its original revision.
  const pinned = await schemaOf(first.draftId, "step-0");
  expect(pinned.map(field => field.id)).toEqual(["goal","extra0","extra1","extra2","extra3"]);
  expect(pinned.some(field => field.title === "Renamed goal")).toBe(false);
  console.log("OPC_REVISION_PIN " + JSON.stringify({
    secondOrder: secondSchema.map(field => field.id),
    pinnedOrder: pinned.map(field => field.id),
  }));
  // A: browser evidence — ONE login, then switch drafts directly (staged
  // diagnostics so a failure points at a specific await).
  const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
  const t0 = Date.now();
  const mark = (phase: string) => console.log("A_MS " + phase + " " + (Date.now() - t0) + "ms");
  mark("browser launch begin");
  const browser = await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:true});
  mark("browser launch end");
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    return ["127.0.0.1","localhost"].includes(host) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(60000);
  const reads: Array<{path:string;draftId:string|null;ok:boolean}> = [];
  page.on("response", response => {
    if (!response.url().includes("opc.read")) return;
    const url = decodeURIComponent(response.url());
    reads.push({
      path: new URL(response.url()).pathname,
      draftId: /"draftId":\s*"([0-9a-f-]{36})"/.exec(url)?.[1] ?? null,
      ok: response.ok(),
    });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const formHeading = () =>
    page.locator("section[aria-label='本步填写信息']").getByRole("heading", {level:3}).first();
  const headingText = async () => {
    try {
      return (((await formHeading().textContent({timeout:5000})) ?? "")).replace(/\s+/g," ").trim();
    } catch { return ""; }
  };
  try {
    mark("login document begin");
    const settings = page.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), {timeout:60000});
    await page.goto(process.env.V3_LOCAL_APP + "/login");
    await settings;
    mark("settings ready");
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    expect(await page.getByPlaceholder("name@example.com").inputValue()).toBe(f.email);
    mark("form filled");
    await page.getByRole("button", {name:"登录", exact:true}).last().click();
    mark("login submitted");
    await page.waitForURL(url => !url.pathname.startsWith("/login"), {timeout:60000});
    mark("auth navigated");
    const openDraft = async (draftId: string, label: string) => {
      mark(label + " goto begin");
      await page.goto(process.env.V3_LOCAL_APP + "/positioning/" + draftId);
      await page.waitForURL(url => url.pathname === "/positioning/" + draftId, {timeout:60000});
      mark(label + " url ok");
      await formHeading().waitFor({timeout:60000});
      mark(label + " form ready");
    };
    await openDraft(first.draftId, "old");
    await expect.poll(headingText, {timeout:60000}).toContain("Extra field 1");
    expect(await page.getByRole("textbox", {name:"Extra field 1", exact:true}).count()).toBe(1);
    // Positively verify the entry's only legal opening (step-0/extra1) rather
    // than waiting for an empty non-terminal set: the helper asserts the exact
    // actor-wide effect set, completed execution, settled billing and non-empty
    // request/execution/run/pre-deduct identities, then returns the identity set.
    const oldOpening = [{
      stepId: "step-0",
      questionId: "extra1",
      opening: true,
      input: OPENING_INPUT,
    }];
    const oldIdentity = await expectExactMentorEffects(f.actor, first.draftId, first.roundId, oldOpening);
    expect(oldIdentity).toHaveLength(1);
    const [openingExecutionId] = JSON.parse(oldIdentity[0]) as [string, string, string, string];
    const expectOpeningVisible = await mentorMessageCheck(page, f.actor, openingExecutionId);
    await expectOpeningVisible();
    mark("old opening settled");
    await page.reload();
    await formHeading().waitFor({timeout:60000});
    mark("old reload");
    expect(await headingText()).toContain("Extra field 1");
    // The same execution's same public body must come back after the reload.
    await expectOpeningVisible();
    expect(await expectExactMentorEffects(f.actor, first.draftId, first.roundId, oldOpening))
      .toEqual(oldIdentity);
    const oldValuesBeforeNew = structuredClone((await f.service.read(first.draftId)).information["step-0"].values);
    await openDraft(second!.draftId, "new");
    await expect.poll(headingText, {timeout:60000}).toContain("重复标题");
    expect(await page.locator("section[aria-label='本步填写信息']").getByRole("heading", {level:3}).count()).toBe(1);
    expect(await page.getByRole("textbox", {name:"重复标题", exact:true}).count()).toBe(1);
    expect(await page.getByRole("textbox", {name:"Renamed goal", exact:true}).count()).toBe(0);
    // Drive the new revision through its own buttons: 1.1 defer, 1.2 answer,
    // then 1.3 must show the agent_proposal guidance and its pending proposal.
    const secondRead = async () => await f.service.read(second!.draftId);
    // Four-opening baseline before the cross-step action (shared helper, scopes).
    const secondRoundId: unknown = (await secondRead()).roundId;
    if (typeof secondRoundId !== "string" || !secondRoundId)
      throw new Error("expected the new draft's persisted roundId");
    const oldScope = {draftId: first.draftId, roundId: first.roundId};
    const newScope = {draftId: second!.draftId, roundId: secondRoundId};
    const allExpected: ExpectedMentorEffect[] = [
      {scope: oldScope, stepId: "step-0", questionId: "extra1", opening: true, input: OPENING_INPUT},
      {scope: newScope, stepId: "step-0", questionId: "extra1", opening: true, input: OPENING_INPUT},
      {scope: newScope, stepId: "step-0", questionId: "goal", opening: true, input: OPENING_INPUT},
      {scope: newScope, stepId: "step-0", questionId: "extra0", opening: true, input: OPENING_INPUT},
      {scope: newScope, stepId: "step-1", questionId: "goal", opening: true, input: OPENING_INPUT},
    ];
    const checkEffects = (count: number) => expectExactMentorEffects(
      f.actor, first.draftId, first.roundId, allExpected.slice(0, count),
    );
    await checkEffects(2);
    await page.getByRole("button", {name:"暂时跳过本题", exact:true}).click();
    await expect.poll(async () => (await secondRead()).information["step-0"].values?.extra1?.status, {timeout:60000}).toBe("deferred");
    await expect.poll(headingText, {timeout:60000}).toContain("Renamed goal");
    expect(await page.getByRole("textbox", {name:"Renamed goal", exact:true}).count()).toBe(1);
    await checkEffects(3);
    await page.getByRole("textbox", {name:"Renamed goal", exact:true}).fill("具体事实：我做 AI 工具内容");
    await page.getByRole("button", {name:"确认本题并继续", exact:true}).click();
    await expect.poll(async () => (await secondRead()).information["step-0"].values?.goal?.status, {timeout:60000}).toBe("confirmed");
    await expect.poll(headingText, {timeout:60000}).toContain("1.3");
    await expect.poll(async () => (await page.getByText("这是导师要给出的成果建议", {exact:false}).count()), {timeout:60000}).toBeGreaterThan(0);
    expect(await page.locator("section[aria-label='本步填写信息']").getByRole("heading", {level:3}).count()).toBe(1);
    expect(await page.getByRole("textbox", {name:"重复标题", exact:true}).count()).toBe(1);
    // The mentor fixture deterministically proposes this text for the current
    // question and the host keeps it unconfirmed: assert the exact value, the
    // provisional status, and that the user actually sees it in the form.
    const expectedProposal =
      "建议草稿：围绕“重复标题”给出一个可直接使用的具体方案，依据已确认的信息，不声称做过真实研究。";
    await expect.poll(async () => {
      const proposal = (await secondRead()).information["step-0"].values?.extra0;
      return {value: proposal?.value ?? "", status: proposal?.status ?? ""};
    }, {timeout: 60000}).toEqual({value: expectedProposal, status: "provisional"});
    const proposalBox = page.locator("section[aria-label='本步填写信息']").getByRole("textbox", {name:"重复标题", exact:true});
    await expect.poll(() => proposalBox.count(), {timeout: 60000}).toBe(1);
    await expect.poll(() => proposalBox.inputValue(), {timeout: 60000}).toBe(expectedProposal);
    mark("new progressed to 1.3");

    await checkEffects(4);
    // Advance across steps: confirm the pending proposal so step-0 becomes valid
    // and the next step opens its own same-titled field.
    await page.getByRole("button", {name:"确认本题并继续", exact:true}).click();
    await expect.poll(async () => (await secondRead()).information["step-0"].values?.extra0?.status, {timeout:60000}).toBe("confirmed");
    await expect.poll(async () => (await secondRead()).snapshot.steps["step-0"].valid, {timeout:60000}).toBe(true);
    await expect.poll(async () => await page.getByRole("navigation",{name:"定位步骤"}).getByRole("button",{name:/^2\./}).getAttribute("aria-current"), {timeout:60000}).toBe("step");
    await expect.poll(async () => (await page.locator("section[aria-label='本步填写信息']").getByRole("heading",{level:3}).first().textContent()) ?? "", {timeout:60000}).toContain("2.1");
    mark("new at step-1");
    // The next step's own user_fact question must stay empty: the earlier step's
    // suggestion must not leak across the repeated title.
    await expect.poll(async () => (await secondRead()).information["step-1"].values?.goal?.value ?? "", {timeout:60000}).toBe("");
    expect(await page.locator("section[aria-label='本步填写信息']").getByRole("textbox", {name:"重复标题", exact:true}).inputValue()).toBe("");
    const stableIdentities = await checkEffects(5);
    const openingTurns = ((await secondRead()).turns as Array<{
      roundId: string; stepId: string; questionId: string; kind: string; executionId: string;
    }>).filter(turn => turn.roundId === secondRoundId && turn.stepId === "step-1" &&
      turn.questionId === "goal" && turn.kind === "opening");
    expect(openingTurns).toHaveLength(1);
    const expectNewOpeningVisible = await mentorMessageCheck(page, f.actor, openingTurns[0].executionId);
    await expectNewOpeningVisible();
    // A completed five-opening baseline, then the same page and same message.
    await page.reload();
    const refreshedForm = page.locator("section[aria-label='本步填写信息']");
    await expect.poll(() => refreshedForm.getByRole("heading", {level:3}).count()).toBe(1);
    await expect.poll(() => refreshedForm.getByRole("heading", {level:3}).textContent()).toMatch(/^2\.1 重复标题/);
    expect(await page.getByRole("navigation", {name:"定位步骤"})
      .getByRole("button", {name:/^2\./}).getAttribute("aria-current")).toBe("step");
    expect(await refreshedForm.getByRole("textbox", {name:"重复标题", exact:true}).inputValue()).toBe("");
    await expectNewOpeningVisible();
    expect(await checkEffects(5)).toEqual(stableIdentities);
    mark("new refreshed");
    const newValues = (await secondRead()).information["step-0"].values;
    expect(newValues.goal.value).toBe("具体事实：我做 AI 工具内容");
    expect({value:newValues.extra0.value, status:newValues.extra0.status})
      .toEqual({value:expectedProposal, status:"confirmed"});
    await openDraft(first.draftId, "old revisit");
    expect(await headingText()).toContain("Extra field 1");
    expect((await f.service.read(first.draftId)).information["step-0"].values).toEqual(oldValuesBeforeNew);
    expect(await checkEffects(5)).toEqual(stableIdentities);
    const rounds = (await sql.query(
      `select d.draft_id::text draft_id, r.revision_id::text revision_id from opc_drafts d
       join artifact_rounds r on r.id=d.round_id where d.draft_id in ($1,$2)`,
      [first.draftId, second!.draftId],
    )).rows as Array<{draft_id:string;revision_id:string}>;
    expect(rounds.find(r => r.draft_id === first.draftId)?.revision_id).toBe(f.pack.revisionId);
    expect(rounds.find(r => r.draft_id === second!.draftId)?.revision_id).toBe(pack2.revisionId);
    expect(pageErrors).toEqual([]);
    mark("A complete");
    console.log("OPC_REVISION_PIN_BROWSER " + JSON.stringify({
      reads, pageErrors, oldRevision: f.pack.revisionId, newRevision: pack2.revisionId,
    }));
  } catch (error) {
    console.error("A_FAILURE " + JSON.stringify({
      message: String((error as Error).message).slice(0, 300),
      pathname: (() => { try { return new URL(page.url()).pathname; } catch { return "unavailable"; } })(),
      heading: await headingText(),
      reads, pageErrors,
    }));
    throw error;
  } finally {
    mark("browser close begin");
    await browser.close();
    mark("browser close end");
  }
}, 300000);

it("OPC: published revision stays immutable while its revised round owns reach and openings", async () => {
  const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
  const ids = ["goal", "extra0", "extra1", "extra2", "extra3"];
  const f = await fixture(3, false, 0, flow => {
    for (const step of flow.steps.slice(0, 2)) {
      step.information = ids.map(id => ({
        id, title: "B " + id, required: id === "goal",
        profileKey: step.id.replace(/-/g, "_") + "_" + id,
      }));
    }
  });
  const draft = await f.service.start({
    requestId: randomUUID(), registration: f.registration, mode: "mentor",
  });
  const { draftId, projectId, sessionId, roundId: r1 } = draft as {
    draftId: string; projectId: string; sessionId: string; roundId: string;
  };
  for (const id of [draftId, projectId, sessionId, r1]) {
    if (typeof id !== "string" || !id) throw new Error("missing B fixture identity");
  }
  const read = () => f.service.read(draftId);
  const app = process.env.V3_LOCAL_APP;
  if (!app) throw new Error("V3_LOCAL_APP required");
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const pageErrors: string[] = [], externalRequests: string[] = [];
  let phase = "setup";
  let page: Page | undefined;
  type Values = Record<string, {
    status: "confirmed" | "provisional" | "unknown";
    nature: "fact" | "unknown"; value: string;
  }>;
  const opening = (roundId: string): ExpectedMentorEffect => ({
    scope: { draftId, roundId }, stepId: "step-0", questionId: "goal",
    opening: true, input: OPENING_INPUT,
  });
  const writeValues = async (stepId: string, values: Values) => {
    const before = await f.artifacts.read(projectId, (await read()).roundId);
    const saved = await f.service.information({
      draftId, stepId, requestId: randomUUID(),
      expectedVersion: before.steps[stepId].version, values,
    });
    const after = await read();
    expect(after.information[stepId].values).toEqual(values);
    expect(after.snapshot.steps[stepId].version).toBe(saved.version);
    expect(saved.version).toBe(before.steps[stepId].version + 1);
    return after;
  };
  const prefix = (count: number): Values => Object.fromEntries(ids.map((id, index) => [id,
    index < count
      ? { status: "confirmed" as const, nature: "fact" as const, value: "B evidence " + id }
      : { status: "unknown" as const, nature: "unknown" as const, value: "" },
  ]));
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const target = new URL(route.request().url());
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
        externalRequests.push(target.origin);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const newPage = async () => {
      const next = await context.newPage();
      next.setDefaultTimeout(30000);
      next.on("pageerror", error => pageErrors.push(error.message));
      return next;
    };
    page = await newPage();
    phase = "login";
    const settings = page.waitForResponse(
      response => response.url().includes("settings.getSystemSettings") && response.ok(),
      { timeout: 60000 },
    );
    await page.goto(app + "/login");
    await settings;
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    expect(await page.getByPlaceholder("name@example.com").inputValue()).toBe(f.email);
    expect(await page.getByPlaceholder("输入你的密码").inputValue()).toBe(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 60000 });

    phase = "R1 opening";
    await page.goto(app + "/positioning/" + draftId);
    const oldIdentities = await expectExactMentorEffects(f.actor, draftId, r1, [opening(r1)]);
    expect(oldIdentities).toHaveLength(1);
    const [oldExecution] = JSON.parse(oldIdentities[0]) as [string, string, string, string];
    const oldMessage = await mentorMessageCheck(page, f.actor, oldExecution);
    await oldMessage();
    await page.close();
    page = undefined;

    // No live page during preparation: only the two deliberate openings cost.
    phase = "R1 save confirm publish";
    for (const step of f.flow.steps) {
      const before = await f.artifacts.read(projectId, r1);
      await f.artifacts.execute({
        action: "save", projectId, roundId: r1, requestId: randomUUID(),
        stepId: step.id, body: "B published body " + step.id, evidenceIds: [],
        expectedVersion: before.steps[step.id].version,
      });
      const values: Values = Object.fromEntries((step.information ?? []).map(field => [field.id, {
        status: "confirmed" as const, nature: "fact" as const,
        value: "B R1 " + step.id + " " + field.id,
      }]));
      await writeValues(step.id, values);
      const state = (await f.artifacts.read(projectId, r1)).steps[step.id];
      await f.artifacts.execute({
        action: "confirm", projectId, roundId: r1, requestId: randomUUID(), stepId: step.id,
        expectedVersion: state.version, expectedReviewVersion: state.reviewVersion,
      });
    }
    const confirmed = await f.artifacts.read(projectId, r1);
    await f.artifacts.execute({
      action: "publish", projectId, roundId: r1, requestId: randomUUID(),
      expectedSteps: Object.fromEntries(Object.entries(confirmed.steps).map(([id, state]) => [id, {
        version: state.version, reviewVersion: state.reviewVersion,
      }])),
    });
    const reportBefore = structuredClone(await f.artifacts.report(projectId, r1));
    expect(reportBefore.available).toBe(true);
    const versionId = reportBefore.id;
    if (typeof versionId !== "string" || !versionId) throw new Error("R1 version required");
    const versionJSON = async () => {
      const rows = (await sql.query<{ body: Record<string, unknown> }>(
        "select to_jsonb(v) body from artifact_versions v where v.id=$1 and v.round_id=$2",
        [versionId, r1],
      )).rows;
      expect(rows).toHaveLength(1);
      return rows[0].body;
    };
    const roundSteps = async (roundId: string) => {
      const rows = (await sql.query<{ steps: Record<string, { confirmationId?: string; valid?: boolean }> }>(
        "select steps from artifact_rounds where id=$1 and project_id=$2", [roundId, projectId],
      )).rows;
      expect(rows).toHaveLength(1);
      return rows[0].steps;
    };
    const versionBefore = structuredClone(await versionJSON());
    const stepsBefore = structuredClone(await roundSteps(r1));
    expect((await read()).information["step-0"].reached).toEqual(ids);
    expect((await read()).information["step-1"].reached).toEqual(ids);

    phase = "published page and explicit revise";
    page = await newPage();
    await page.goto(app + "/positioning/" + draftId);
    const reviseButton = page.getByRole("button", { name: "修订定位，保留原版本", exact: true });
    await reviseButton.waitFor({ state: "visible" });
    expect((await read()).snapshot.state).toBe("published");
    await expect.poll(() => page!.getByRole("button", { name: "确认本题并继续", exact: true }).isDisabled())
      .toBe(true);
    await reviseButton.click();
    await expect.poll(async () => (await read()).roundId, { timeout: 60000 }).not.toBe(r1);
    const revised = await read();
    const r2: unknown = revised.roundId;
    if (typeof r2 !== "string" || !r2) throw new Error("R2 identity required");
    expect(revised.snapshot.state).toBe("draft");
    expect({ draftId: revised.draftId, projectId: revised.projectId, sessionId: revised.sessionId })
      .toEqual({ draftId, projectId, sessionId });
    const revisedSteps = await roundSteps(r2);
    for (const step of f.flow.steps) {
      expect(revisedSteps[step.id].valid).toBe(true);
      expect(revisedSteps[step.id].confirmationId).toBeTruthy();
      expect(revisedSteps[step.id].confirmationId).not.toBe(stepsBefore[step.id].confirmationId);
    }
    expect(await expectExactMentorEffects(f.actor, draftId, r1, [opening(r1)])).toEqual(oldIdentities);
    await page.close();
    page = undefined;

    phase = "round and step isolation";
    const short = await writeValues("step-0", prefix(1));
    expect(short.information["step-0"].reached).toEqual(["goal", "extra0"]);
    const long = await writeValues("step-1", prefix(5));
    expect(long.information["step-1"].reached).toEqual(ids);
    expect(long.information["step-0"].reached).toEqual(["goal", "extra0"]);
    const pending = prefix(0);
    pending.goal = { status: "provisional", nature: "fact", value: "B R2 revised goal" };
    const current = await writeValues("step-0", pending);
    expect(current.information["step-0"].reached).toEqual(["goal", "extra0"]);

    phase = "R2 opening and edit";
    page = await newPage();
    await page.goto(app + "/positioning/" + draftId);
    const allExpected = [opening(r1), opening(r2)];
    const identities = await expectExactMentorEffects(f.actor, draftId, r1, allExpected);
    const newIdentities = identities.filter(identity => !oldIdentities.includes(identity));
    expect(newIdentities).toHaveLength(1);
    const [newExecution] = JSON.parse(newIdentities[0]) as [string, string, string, string];
    expect(newExecution).not.toBe(oldExecution);
    const currentMessage = await mentorMessageCheck(page, f.actor, newExecution);
    await currentMessage();
    const form = page.locator("section[aria-label='本步填写信息']");
    const heading = form.getByRole("heading", { level: 3 });
    const box = form.getByRole("textbox", { name: "B goal", exact: true });
    const nav = page.getByRole("navigation", { name: "本步骤已到达的问题" });
    const expectCurrent = async (value: string) => {
      await expect.poll(() => heading.count()).toBe(1);
      await expect.poll(() => heading.textContent()).toMatch(/^1\.1 B goal/);
      await expect.poll(() => box.inputValue()).toBe(value);
      await expect.poll(() => nav.getByRole("button").count()).toBe(2);
      expect(await nav.getByRole("button", { name: /B extra1/ }).count()).toBe(0);
      expect((await read()).information["step-0"].reached).toEqual(["goal", "extra0"]);
    };
    await expectCurrent(pending.goal.value);
    const beforeEdit = await f.artifacts.read(projectId, r2);
    const edited = "B R2 edited by browser";
    await box.fill(edited);
    await expect.poll(async () => (await read()).information["step-0"].values.goal.value,
      { timeout: 30000 }).toBe(edited);
    await expect.poll(async () => (await read()).snapshot.steps["step-0"].version,
      { timeout: 30000 }).toBe(beforeEdit.steps["step-0"].version + 1);
    expect((await read()).information["step-0"].values.goal.status).toBe("provisional");
    await expectCurrent(edited);
    phase = "R2 reload and R1 immutability";
    await page.reload();
    await expectCurrent(edited);
    await currentMessage();
    expect(await expectExactMentorEffects(f.actor, draftId, r1, allExpected)).toEqual(identities);
    expect(await versionJSON()).toEqual(versionBefore);
    expect(await roundSteps(r1)).toEqual(stepsBefore);
    expect(await f.artifacts.report(projectId, r1)).toEqual(reportBefore);
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
    console.log("OPC_REVISION_ISOLATION " + JSON.stringify({
      draftId, projectId, sessionId, r1, r2, versionId,
      openings: 2, runs: 2, reserves: 2, reached: ["goal", "extra0"],
    }));
  } catch (error) {
    console.error("B_FAILURE", { phase, message: String(error), pathname: page ? new URL(page.url()).pathname : null });
    throw error;
  } finally {
    await browser.close();
  }
}, 300000);

it("OPC: two real tabs retain review, resolve edits and recover one reply after real logout", async () => {
  const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
  const fields = ["goal", "extra0", "extra1", "extra2", "extra3"];
  const f = await fixture(3, false, 0, flow => {
    flow.steps[0].information = fields.map(id => ({
      id, title: "C " + id, required: id === "goal", profileKey: "c_" + id,
    }));
  });
  await planFixtureModel(f.moduleId);
  const started = await f.service.start({
    requestId: randomUUID(), registration: f.registration, mode: "mentor",
  });
  const { draftId, projectId, sessionId, roundId } = started as {
    draftId: string; projectId: string; sessionId: string; roundId: string;
  };
  for (const id of [draftId, projectId, sessionId, roundId]) {
    if (typeof id !== "string" || !id) throw new Error("missing C fixture identity");
  }
  const app = process.env.V3_LOCAL_APP;
  if (!app || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(app).hostname))
    throw new Error("C requires the existing loopback runner");
  const origin = new URL(app).origin;
  const draftPath = "/positioning/" + draftId;
  const read = () => f.service.read(draftId);
  type Answer = {
    value: string; status: "confirmed" | "deferred" | "unknown" | "provisional";
    nature: "fact" | "unknown";
  };
  const seeded: Record<string, Answer> = {
    goal: { value: "C original goal", status: "confirmed", nature: "fact" },
    extra0: { value: "C known audience", status: "confirmed", nature: "fact" },
    extra1: { value: "C needs source material", status: "deferred", nature: "fact" },
    extra2: { value: "", status: "unknown", nature: "unknown" },
    extra3: { value: "", status: "unknown", nature: "unknown" },
  };
  // Make q4 durably reached without ever admitting an opening for it, then
  // edit q1 back to provisional. Only the existing information RPC is used.
  await f.service.information({
    draftId, stepId: "step-0", requestId: randomUUID(),
    expectedVersion: (await read()).snapshot.steps["step-0"].version, values: seeded,
  });
  const values = structuredClone(seeded);
  values.goal = { ...values.goal, value: "C editable goal", status: "provisional" };
  await f.service.information({
    draftId, stepId: "step-0", requestId: randomUUID(),
    expectedVersion: (await read()).snapshot.steps["step-0"].version, values,
  });
  const reached = ["goal", "extra0", "extra1", "extra2"];
  const baseOtherValues = structuredClone(values);
  delete baseOtherValues.goal;
  const opening: ExpectedMentorEffect = {
    stepId: "step-0", questionId: "goal", opening: true, input: OPENING_INPUT,
  };
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  let phase = "browser setup";
  const pageErrors: string[] = [], externalRequests: string[] = [];
  let page: Page | undefined;
  let releaseHeld: (() => void) | undefined;
  let holdSave = false, dropExecutionReply = false;
  const localInput = "C tab one keeps this exact edit";
  const remoteInput = "C tab two saved this different edit";
  const stepKey = "opc-step:" + draftId + ":step-0";
  const form = (p: Page) => p.locator("section[aria-label='本步填写信息']");
  const nav = (p: Page) => p.getByRole("navigation", { name: "本步骤已到达的问题" });
  const box = (p: Page, id = "goal") => form(p).getByRole("textbox", { name: "C " + id, exact: true });
  const show = async (p: Page, id: string, expectedValue: string) => {
    const number = fields.indexOf(id) + 1;
    if (number < 1) throw new Error("unknown C question");
    await expect.poll(() => form(p).getByRole("heading", { level: 3 }).count(), { timeout: 60000 }).toBe(1);
    await expect.poll(() => form(p).getByRole("heading", { level: 3 }).textContent(), { timeout: 60000 })
      .toMatch(new RegExp("^1\\." + number + " C " + id + "(?:\\s|[（(]|$)"));
    await expect.poll(() => box(p, id).count()).toBe(1);
    await expect.poll(() => box(p, id).inputValue(), { timeout: 30000 }).toBe(expectedValue);
    await expect.poll(() => nav(p).getByRole("button").count()).toBe(4);
    expect(await nav(p).getByRole("button", { name: /C extra3/ }).count()).toBe(0);
    expect(new URL(p.url()).pathname).toBe(draftPath);
  };
  const assertBinding = async () => {
    const d = await read();
    expect({ draftId: d.draftId, projectId: d.projectId, sessionId: d.sessionId, roundId: d.roundId })
      .toEqual({ draftId, projectId, sessionId, roundId });
    expect(d.information["step-0"].reached).toEqual(reached);
    const otherValues = { ...d.information["step-0"].values };
    delete otherValues.goal;
    expect(otherValues).toEqual(baseOtherValues);
    return d;
  };
  const countInformation = async () => (await sql.query<{ n: number }>(
    "select count(*)::int n from artifact_requests where project_id=$1 and round_id=$2 and action='opc_information' and payload->>'stepId'='step-0'",
    [projectId, roundId],
  )).rows[0].n;
  const saved = async (p: Page, value: string, version: number) => {
    await expect.poll(() => box(p).inputValue(), { timeout: 30000 }).toBe(value);
    await expect.poll(async () => {
      const d = await read();
      return { value: d.information["step-0"].values.goal.value,
        status: d.information["step-0"].values.goal.status,
        version: d.snapshot.steps["step-0"].version };
    }, { timeout: 30000 }).toEqual({ value, status: "provisional", version });
    await expect.poll(() => form(p).getByRole("status").allTextContents(), { timeout: 30000 })
      .toContain("已自动保存");
    await expect.poll(() => p.evaluate(id => {
      if (sessionStorage.getItem("opc-information-autosave:" + id + ":step-0")) return false;
      const raw = sessionStorage.getItem("opc-edit:" + id);
      if (!raw) return false;
      const state: unknown = JSON.parse(raw);
      return Boolean(state && typeof state === "object" && "infoEdits" in state &&
        state.infoEdits && typeof state.infoEdits === "object" && !Object.hasOwn(state.infoEdits, "step-0"));
    }, draftId), { timeout: 30000 }).toBe(true);
  };
  const login = async (p: Page) => {
    const settings = p.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), { timeout: 60000 });
    await p.goto(app + "/login");
    await settings;
    await p.getByPlaceholder("name@example.com").fill(f.email);
    await p.getByPlaceholder("输入你的密码").fill(f.password);
    expect(await p.getByPlaceholder("name@example.com").inputValue()).toBe(f.email);
    expect(await p.getByPlaceholder("输入你的密码").inputValue()).toBe(f.password);
    await p.getByRole("button", { name: "登录", exact: true }).last().click();
    await p.waitForURL(url => url.origin === origin && !url.pathname.startsWith("/login"), { timeout: 60000 });
  };
  const isProcedure = (url: string, name: string) => {
    const u = new URL(url);
    return u.origin === origin && u.pathname.startsWith("/api/trpc/") &&
      decodeURIComponent(u.pathname.slice("/api/trpc/".length)).split(",").includes(name);
  };
  const readEnvelope = async (p: Page) => {
    const raw = await p.evaluate(key => sessionStorage.getItem(key), stepKey);
    if (!raw) throw new Error("the original mentor request must remain retained");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("request" in parsed) ||
        !parsed.request || typeof parsed.request !== "object" ||
        !("requestId" in parsed.request) || typeof parsed.request.requestId !== "string")
      throw new Error("invalid retained request shape");
    return { raw, requestId: parsed.request.requestId, request: parsed.request };
  };
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const u = new URL(route.request().url());
      if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
        externalRequests.push(u.origin);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    page = await context.newPage();
    const tab1 = page;
    tab1.setDefaultTimeout(30000);
    tab1.on("pageerror", error => pageErrors.push(error.message));
    phase = "login and one shared opening";
    await login(tab1);
    await tab1.goto(app + draftPath);
    await show(tab1, "goal", values.goal.value);
    const initialIdentities = await expectExactMentorEffects(f.actor, draftId, roundId, [opening]);
    expect(initialIdentities).toHaveLength(1);
    const [openingExecution] = JSON.parse(initialIdentities[0]) as [string, string, string, string];
    const openingMessage = await mentorMessageCheck(tab1, f.actor, openingExecution);
    await openingMessage();
    const tab2 = await context.newPage();
    tab2.setDefaultTimeout(30000);
    tab2.on("pageerror", error => pageErrors.push(error.message));
    await tab2.goto(app + draftPath);
    await show(tab2, "goal", values.goal.value);
    await (await mentorMessageCheck(tab2, f.actor, openingExecution))();
    expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialIdentities);

    phase = "real second-tab update during historical review";
    await nav(tab1).getByRole("button", { name: /C extra2/ }).click();
    await show(tab1, "extra2", "");
    expect(await tab1.getByRole("button", { name: "确认本题并继续", exact: true }).isDisabled()).toBe(true);
    const beforeRemote = (await read()).snapshot.steps["step-0"].version;
    const firstRemote = "C updated while the other tab reviews question four";
    await box(tab2).fill(firstRemote);
    await saved(tab2, firstRemote, beforeRemote + 1);
    await tab1.getByRole("button", { name: "重新读取状态", exact: true }).click();
    await show(tab1, "extra2", "");
    expect(await tab1.getByRole("button", { name: "确认本题并继续", exact: true }).isDisabled()).toBe(true);
    expect((await assertBinding()).information["step-0"].values.goal.value).toBe(firstRemote);
    await nav(tab1).getByRole("button", { name: /C goal/ }).click();
    await show(tab1, "goal", firstRemote);

    phase = "two real writes produce an explicit conflict";
    let sawHeldSave = false;
    const gate = new Promise<void>(resolve => { releaseHeld = resolve; });
    await tab1.route("**/api/trpc/**", async route => {
      if (holdSave && route.request().method() === "POST" && isProcedure(route.request().url(), "opc.information")) {
        holdSave = false;
        sawHeldSave = true;
        await gate; // Delay the real request; never fabricate a successful write.
        await route.continue();
        return;
      }
      await route.fallback();
    });
    const conflictVersion = (await read()).snapshot.steps["step-0"].version;
    const conflictCount = await countInformation();
    holdSave = true;
    await box(tab1).fill(localInput);
    await expect.poll(() => sawHeldSave, { timeout: 30000 }).toBe(true);
    await box(tab2).fill(remoteInput);
    await saved(tab2, remoteInput, conflictVersion + 1);
    releaseHeld!();
    await expect.poll(() => form(tab1).getByRole("alert").textContent(), { timeout: 30000 })
      .toContain("其他窗口修改了相同字段");
    expect(await box(tab1).inputValue()).toBe(localInput);
    expect((await read()).information["step-0"].values.goal.value).toBe(remoteInput);
    expect(await countInformation()).toBe(conflictCount + 1);
    await form(tab1).getByRole("button", { name: "保留我的这些修改并重新保存", exact: true }).click();
    await saved(tab1, localInput, conflictVersion + 2);
    expect(await countInformation()).toBe(conflictCount + 2);
    await show(tab1, "goal", localInput);
    expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialIdentities);
    await tab2.close();

    phase = "twelve persisted edits without truncating historical reach";
    const editBase = (await read()).snapshot.steps["step-0"].version;
    const requestBase = await countInformation();
    let finalValue = localInput;
    for (let index = 1; index <= 12; index++) {
      finalValue = "C persisted edit " + index + " -- exact value";
      await box(tab1).fill(finalValue);
      await saved(tab1, finalValue, editBase + index);
      expect(await countInformation()).toBe(requestBase + index);
      await assertBinding();
    }
    await tab1.reload();
    await show(tab1, "goal", finalValue);
    await openingMessage();
    expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialIdentities);
    expect((await read()).snapshot.steps["step-0"].version).toBe(editBase + 12);
    const scopedCount = await countInformation();
    // Observe the same scoped SELECT used by 0111. Do not require an index scan
    // on a tiny fixture, or claim a latency guarantee from this query plan.
    const planRows = (await sql.query<{ "QUERY PLAN": Array<Record<string, unknown>> }>(
      "explain (analyze, buffers, format json) select a.payload->'values' from artifact_requests a where a.project_id=$1 and a.round_id=$2 and a.action='opc_information' and a.payload->>'stepId'=$3",
      [projectId, roundId, "step-0"],
    )).rows;
    const explain = planRows[0]?.["QUERY PLAN"]?.[0];
    const plan = explain?.Plan;
    if (!plan || typeof plan !== "object" || !("Actual Rows" in plan))
      throw new Error("missing actual scoped historical query result");
    expect(plan["Actual Rows"]).toBe(scopedCount);
    expect(scopedCount).toBe(requestBase + 12);
    expect((await assertBinding()).information["step-0"].values.goal.value).toBe(finalValue);

    phase = "lose a completed explicit reply without creating a new request";
    let sawSuccessfulDroppedReply = false;
    await tab1.route("**/api/trpc/**", async route => {
      if (dropExecutionReply && route.request().method() === "POST" && isProcedure(route.request().url(), "runtime.execute")) {
        const response = await route.fetch(); // Real server execution and settlement happen first.
        const succeeded = response.ok();
        await route.abort("failed");
        if (succeeded) sawSuccessfulDroppedReply = true;
        return;
      }
      await route.fallback();
    });
    const mentorInput = "C request: explain this saved goal without changing my confirmed audience.";
    dropExecutionReply = true;
    await tab1.getByRole("textbox", { name: "给导师的回复", exact: true }).fill(mentorInput);
    await tab1.getByRole("button", { name: "发送", exact: true }).click();
    const explicit: ExpectedMentorEffect = {
      stepId: "step-0", questionId: "goal", opening: false, input: mentorInput,
    };
    const expected = [opening, explicit];
    const paidIdentities = await expectExactMentorEffects(f.actor, draftId, roundId, expected);
    await expect.poll(() => sawSuccessfulDroppedReply, { timeout: 30000 }).toBe(true);
    const retained = await readEnvelope(tab1);
    expect(retained.request).toEqual({
      draftId, stepId: "step-0", purpose: "mentor", requestId: retained.requestId,
      input: mentorInput, questionId: "goal", organizeAfter: true,
    });
    const explicitRows = paidIdentities.map(identity => JSON.parse(identity) as [string, string, string, string])
      .filter(identity => identity[1] === retained.requestId);
    expect(explicitRows).toHaveLength(1);
    const explicitExecution = explicitRows[0][0];
    expect(explicitExecution).not.toBe(openingExecution);
    await expect.poll(() => tab1.getByRole("button", { name: "继续核对这条原请求", exact: true }).isEnabled(), { timeout: 30000 })
      .toBe(true);

    phase = "real website logout in the original tab";
    // Positioning has no user-menu header. Use the existing profile page in
    // THIS page/context to invoke AppHeader's real supabase.auth.signOut().
    await tab1.goto(app + "/profile");
    expect((await readEnvelope(tab1)).raw).toBe(retained.raw);
    await tab1.getByRole("button", { name: "打开用户菜单", exact: true }).click();
    const logoutResponse = tab1.waitForResponse(response => {
      const url = new URL(response.url());
      return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        /\/logout\/?$/.test(url.pathname) && response.request().method() === "POST";
    }, { timeout: 60000 });
    await tab1.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    expect((await logoutResponse).ok()).toBe(true);
    await tab1.waitForURL(url => url.origin === origin && url.pathname === "/landing", { timeout: 60000 });
    await tab1.goto(app + draftPath);
    await tab1.waitForURL(url => url.origin === origin && url.pathname === "/login", { timeout: 60000 });
    expect(await tab1.locator("section[aria-label='本步填写信息']").count()).toBe(0);
    expect((await readEnvelope(tab1)).raw).toBe(retained.raw);
    expect(await expectExactMentorEffects(f.actor, draftId, roundId, expected)).toEqual(paidIdentities);

    phase = "same-page login and same-request recovery";
    dropExecutionReply = false;
    await login(tab1);
    // Global sign-out also revokes the fixture service client's refresh token.
    // Restore that independent probe only after the browser itself logged in.
    const probeLogin = await f.user.auth.signInWithPassword({ email: f.email, password: f.password });
    if (probeLogin.error) throw probeLogin.error;
    expect(probeLogin.data.user?.id).toBe(f.actor);
    await tab1.goto(app + draftPath);
    await show(tab1, "goal", finalValue);
    expect((await readEnvelope(tab1)).raw).toBe(retained.raw);
    expect(await expectExactMentorEffects(f.actor, draftId, roundId, expected)).toEqual(paidIdentities);
    await tab1.getByRole("button", { name: "继续核对这条原请求", exact: true }).click();
    await expect.poll(() => tab1.evaluate(key => sessionStorage.getItem(key), stepKey), { timeout: 60000 }).toBeNull();
    const explicitMessage = await mentorMessageCheck(tab1, f.actor, explicitExecution);
    await explicitMessage();
    await show(tab1, "goal", finalValue);
    expect(await expectExactMentorEffects(f.actor, draftId, roundId, expected)).toEqual(paidIdentities);
    await tab1.reload();
    await show(tab1, "goal", finalValue);
    await explicitMessage();
    expect(await expectExactMentorEffects(f.actor, draftId, roundId, expected)).toEqual(paidIdentities);
    const final = await assertBinding();
    expect(final.snapshot.steps["step-0"].version).toBe(editBase + 12);
    expect(final.information["step-0"].values.goal.status).toBe("provisional");
    expect(await countInformation()).toBe(scopedCount);
    expect((await sql.query<{ n: number }>(
      "select count(*)::int n from opc_turns t join runtime_executions e on e.session_id=t.session_id and e.request_id=t.request_id where t.draft_id=$1 and t.round_id=$2 and e.payload->'request'->'selection'->>'task' in ('opc-opening:extra2','opc-question:extra2','opc-opening:extra3','opc-question:extra3')",
      [draftId, roundId],
    )).rows[0].n).toBe(0);
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
    console.log("OPC_C_RECOVERY " + JSON.stringify({
      draftId, roundId, sessionId, edits: 12, reached,
      executions: 2, runs: 2, reserves: 2, requestId: retained.requestId,
      executionId: explicitExecution, samePageLogout: true,
      scopedRows: scopedCount, queryPlan: plan,
    }));
  } catch (error) {
    console.error("C_FAILURE", { phase, message: String(error), pathname: page ? new URL(page.url()).pathname : null });
    throw error;
  } finally {
    holdSave = false;
    dropExecutionReply = false;
    releaseHeld?.();
    await browser.close();
  }
}, 300000);

it("OPC: an explicit continue keeps a retained request identity instead of overwriting an unknown outcome", async () => {
  const { chromium } =
    await import("../../../../../apps/web/node_modules/@playwright/test");
  // The draft is already published, so the completed state owns the explicit
  // re-entry control this case presses.
  const f = await completed(3);
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
  const key = "opc-plan-generation:" + f.d.draftId;
  try {
    await page.goto(
      process.env.V3_LOCAL_APP + "/login?redirect=" + encodeURIComponent(draftPath),
    );
    await page.getByPlaceholder("name@example.com").fill(f.email);
    await page.getByPlaceholder("输入你的密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).last().click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath));
    // A consented envelope that still owns an unresolved request: pressing the
    // re-entry control again must continue THAT request, never replace it.
    const original = planEnvelopeFor(f, {
      requestId: "1f0a1c2d-3e4f-4a5b-8c6d-7e8f90a1b2c3",
    });
    await page.evaluate(
      ({ key, envelope }) => sessionStorage.setItem(key, JSON.stringify(envelope)),
      { key, envelope: original },
    );
    const before = await planIdentity(f.actor, f.d.draftId);
    await page
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "是否继续生成第一周选题" })
      .getByRole("button", { name: "继续生成第一周选题", exact: true })
      .click();
    await page.waitForURL((url) => url.pathname.endsWith(draftPath + "/plan"));
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    const stored = JSON.parse(
      (await page.evaluate((k) => sessionStorage.getItem(k), key)) as string,
    ) as { request: { requestId: string } };
    expect(stored.request.requestId).toBe(original.request.requestId);
    const after = await planIdentity(f.actor, f.d.draftId);
    expect(after.planExecutions - before.planExecutions).toBe(1);
    expect(after.reserves - before.reserves).toBe(1);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: a local record without consent is checked on the server and only recovered by an explicit continue", async () => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const legacy = planEnvelopeFor(f, {
    requestId: "2b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  }) as Record<string, unknown>;
  // A pre-upgrade record: no consent marker, and nothing was ever dispatched.
  delete legacy.consentedAt;
  legacy.v = 2;
  const { browser, page, key } = await planBrowser(f, { envelope: legacy });
  try {
    await page.reload();
    await page
      .getByRole("heading", { name: "本机保留了一条早先的生成请求", exact: true })
      .waitFor();
    const before = await planIdentity(f.actor, f.d.draftId);
    expect(before.planExecutions).toBe(0);
    // The page must report the server's own verdict instead of assuming that a
    // local record was never executed or never cost anything.
    await expect
      .poll(
        async () =>
          (await page.getByRole("status").allTextContents()).join(" "),
        { timeout: 30000 },
      )
      .toContain("服务端没有这条请求的准入记录");
    expect(before.planExecutions).toBe(0);
    await page.getByRole("button", { name: "继续这条原请求", exact: true }).click();
    await page.getByRole("heading", { name: CANDIDATE_HEADING, exact: true }).waitFor();
    const stored = JSON.parse(
      (await page.evaluate((k) => sessionStorage.getItem(k), key)) as string,
    ) as { request: { requestId: string } };
    expect(stored.request.requestId).toBe("2b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e");
    const after = await planIdentity(f.actor, f.d.draftId);
    expect(after.planExecutions - before.planExecutions).toBe(1);
  } finally {
    await browser.close();
  }
}, 300000);
it("OPC: the retained-request state read denies another actor's draft and reports this actor's own verdict", async () => {
  const mine = await publishedDraft(3, true);
  const other = await publishedDraft(3, true);
  const requestId = randomUUID();
  // Another actor's draft is a denied read, never someone else's workspace.
  await expect(
    mine.service.planRequestState(other.d.draftId, requestId),
  ).rejects.toThrow(/OPC_DENIED/);
  // The server's own verdict for this actor: this exact request was never
  // admitted, so recovery will admit it rather than replay a committed reply.
  await expect(
    mine.service.planRequestState(mine.d.draftId, requestId),
  ).resolves.toMatchObject({ admitted: false, requestId });
});
it.each(["save", "confirm"] as const)(
  "OPC: workbench %s conflict recovery preserves unknown-outcome replay",
  async targetPhase => {
    const { chromium } = await import("../../../../../apps/web/node_modules/@playwright/test");
    const f = await fixture(3);
    const draft = await f.service.start({
      requestId: randomUUID(), registration: f.registration, mode: "mentor",
    });
    const { draftId, projectId, roundId, sessionId } = draft;
    const stepId = f.flow.steps[0].id;
    const original = "F1 original audience: first-time film makers";
    const updated = "F1 reviewed audience: experienced documentary directors";
    const readDraft = () => f.service.read(draftId);
    await f.service.information({
      draftId, stepId, requestId: randomUUID(),
      expectedVersion: (await readDraft()).snapshot.steps[stepId].version,
      values: { goal: { value: original, status: "provisional", nature: "decision" } },
    });
    const app = process.env.V3_LOCAL_APP;
    if (!app || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(app).hostname))
      throw new Error("F1 requires the existing loopback disposable runner");
    const origin = new URL(app).origin;
    const key = "opc-confirm-step:" + draftId + ":" + stepId;
    type Pending = {
      phase: "information" | "save" | "confirm";
      information: { requestId: string };
      save: { requestId: string; expectedVersion: number | null; body: string };
      confirm: { requestId: string; expectedVersion: number | null; expectedReviewVersion: number | null };
    };
    const browser = await chromium.launch({
      headless: true,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    let phase = "setup", fault: "conflict" | "loss" | "done" = "conflict";
    let rejectedId = "", lostRaw = "", lostPost = "", replayCount = 0;
    let committedVersion = -1, routeFailure: string | null = null;
    const pageErrors: string[] = [], externalRequests: string[] = [];
    let page: Page | undefined;
    const receiptCount = async (id: string) => (await sql.query<{ n: number }>(
      "select count(*)::int n from artifact_requests where project_id=$1 and round_id=$2 and request_id=$3",
      [projectId, roundId, id],
    )).rows[0].n;
    const opening: ExpectedMentorEffect = {
      stepId, questionId: "goal", opening: true, input: OPENING_INPUT,
    };
    try {
      const context = await browser.newContext();
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
          externalRequests.push(url.origin);
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      const p = await context.newPage();
      page = p;
      p.setDefaultTimeout(30000);
      p.on("pageerror", error => pageErrors.push(error.message));
      const rawPending = () => p.evaluate(k => sessionStorage.getItem(k), key);
      const form = () => p.locator("section[aria-label='本步填写信息']");
      const answer = () => form().getByRole("textbox", { name: "已知目标 0", exact: true });
      const confirm = () => form().getByRole("button", { name: "确认本题并继续", exact: true });
      const retry = () => form().getByRole("button", { name: "继续核对本题确认", exact: true });
      const settings = p.waitForResponse(r => r.url().includes("settings.getSystemSettings") && r.ok(), { timeout: 60000 });
      await p.goto(app + "/login");
      await settings;
      await p.getByPlaceholder("name@example.com").fill(f.email);
      await p.getByPlaceholder("输入你的密码").fill(f.password);
      await p.getByRole("button", { name: "登录", exact: true }).last().click();
      await p.waitForURL(u => u.origin === origin && !u.pathname.startsWith("/login"), { timeout: 60000 });
      await p.goto(app + "/positioning/" + draftId);
      await expect.poll(() => answer().inputValue(), { timeout: 60000 }).toBe(original);
      const initialEffects = await expectExactMentorEffects(f.actor, draftId, roundId, [opening]);
      const [openingExecution] = JSON.parse(initialEffects[0]) as string[];
      await (await mentorMessageCheck(p, f.actor, openingExecution))();
      await expect.poll(() => confirm().isEnabled(), { timeout: 30000 }).toBe(true);

      // Delay the real workbench mutation after the page froze its version.
      // No fabricated error, success, batch-response decoder or DB shortcut.
      await p.route("**/api/trpc/**", async route => {
        const req = route.request(), url = new URL(req.url());
        const procedures = decodeURIComponent(url.pathname.slice("/api/trpc/".length)).split(",");
        if (req.method() !== "POST" || url.origin !== origin || !procedures.includes("workbench.execute")) {
          await route.fallback();
          return;
        }
        try {
          const raw = await rawPending();
          if (!raw) { await route.fallback(); return; }
          const pending = JSON.parse(raw) as Pending;
          if (pending.phase !== targetPhase) { await route.fallback(); return; }
          const post = req.postData();
          if (!post) throw new Error("expected a real workbench mutation body");
          const target = pending[targetPhase];
          if (fault === "conflict") {
            rejectedId = target.requestId;
            const before = await readDraft();
            expect(target.expectedVersion).toBe(before.snapshot.steps[stepId].version);
            await f.service.information({
              draftId, stepId, requestId: randomUUID(),
              expectedVersion: before.snapshot.steps[stepId].version,
              values: { goal: { value: updated, status: "provisional", nature: "decision" } },
            });
            const concurrent = await readDraft();
            expect(concurrent.snapshot.steps[stepId].version).toBe(before.snapshot.steps[stepId].version + 1);
            const response = await route.fetch();
            const body = JSON.stringify(await response.json());
            expect(body).toContain('"code":"CONFLICT"');
            expect(body).toContain('"path":"workbench.execute"');
            // A concurrent provisional answer makes the server's OPC
            // required-information gate reject the confirm before any version
            // comparison, so confirm returns the generic workbench CONFLICT
            // message while save returns the version-conflict one.
            expect(body).toContain(
              targetPhase === "save" ? "保存版本已变化" : "操作未完成，请重新加载项目状态",
            );
            expect(body).not.toContain("ARTIFACT_VERSION_CONFLICT");
            expect(body).not.toContain("ARTIFACT_REVIEW_REQUIRED");
            expect(await receiptCount(rejectedId)).toBe(0);
            fault = "loss";
            await route.fulfill({ response }); // Deliver the actual server rejection.
            return;
          }
          if (fault === "loss") {
            expect(target.requestId).not.toBe(rejectedId);
            lostRaw = raw;
            lostPost = post;
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            expect(JSON.stringify(await response.json())).toContain('"accepted":true');
            expect(await receiptCount(target.requestId)).toBe(1);
            const committed = await readDraft();
            committedVersion = committed.snapshot.steps[stepId].version;
            expect(committed.information[stepId].values.goal.value).toBe(updated);
            expect(committed.snapshot.steps[stepId].body).toContain(updated);
            expect(committed.snapshot.steps[stepId].valid).toBe(targetPhase === "confirm");
            fault = "done";
            await route.abort("failed"); // Server committed; browser receives nothing.
            return;
          }
          expect(raw).toBe(lostRaw);
          expect(post).toBe(lostPost); // Same request ID AND frozen versions/payload.
          replayCount++;
          await route.continue();
        } catch (error) {
          routeFailure = error instanceof Error ? error.message : String(error);
          await route.abort("failed").catch(() => {});
        }
      });

      phase = "real mapped conflict releases the rejected envelope";
      await confirm().click();
      await expect.poll(() => rejectedId, { timeout: 30000 }).not.toBe("");
      await expect.poll(rawPending, { timeout: 30000 }).toBeNull();
      expect(routeFailure).toBeNull();
      await expect.poll(() => answer().inputValue(), { timeout: 30000 }).toBe(updated);
      await expect.poll(() => answer().isEnabled(), { timeout: 30000 }).toBe(true);
      await expect.poll(() => confirm().isEnabled(), { timeout: 30000 }).toBe(true);
      const afterConflict = await readDraft();
      expect(afterConflict.snapshot.steps[stepId].valid).toBe(false);
      expect(afterConflict.information[stepId].values.goal).toEqual({ value: updated, status: "provisional", nature: "decision" });
      expect(await receiptCount(rejectedId)).toBe(0);
      expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialEffects);

      phase = "explicitly confirm the changed answer, then lose the committed reply";
      await confirm().click();
      await expect.poll(() => fault, { timeout: 30000 }).toBe("done");
      await expect.poll(() => retry().isEnabled(), { timeout: 30000 }).toBe(true);
      expect(routeFailure).toBeNull();
      expect(lostRaw).not.toBe("");
      expect(await rawPending()).toBe(lostRaw);
      const lost = JSON.parse(lostRaw) as Pending;
      expect(lost.phase).toBe(targetPhase);
      expect(lost[targetPhase].expectedVersion).not.toBeNull();
      expect(await answer().isDisabled()).toBe(true);
      expect(await receiptCount(lost[targetPhase].requestId)).toBe(1);
      expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialEffects);

      phase = "refresh retains unknown outcome, then the same request recovers";
      await p.reload();
      await expect.poll(() => retry().isEnabled(), { timeout: 60000 }).toBe(true);
      expect(await rawPending()).toBe(lostRaw);
      expect(replayCount).toBe(0);
      expect(await answer().inputValue()).toBe(updated);
      expect(await answer().isDisabled()).toBe(true);
      expect(await expectExactMentorEffects(f.actor, draftId, roundId, [opening])).toEqual(initialEffects);
      await retry().click();
      await expect.poll(rawPending, { timeout: 30000 }).toBeNull();
      expect(routeFailure).toBeNull();
      expect(replayCount).toBe(1);
      const final = await readDraft();
      expect({ draftId: final.draftId, projectId: final.projectId, roundId: final.roundId, sessionId: final.sessionId })
        .toEqual({ draftId, projectId, roundId, sessionId });
      expect(final.snapshot.steps[stepId].valid).toBe(true);
      expect(final.snapshot.steps[stepId].body).toContain(updated);
      expect(final.snapshot.steps[stepId].body).not.toContain(original);
      expect(final.information[stepId].values.goal).toEqual({ value: updated, status: "confirmed", nature: "decision" });
      if (targetPhase === "confirm") expect(final.snapshot.steps[stepId].version).toBe(committedVersion);
      for (const id of [lost.information.requestId, lost.save.requestId, lost.confirm.requestId])
        expect(await receiptCount(id)).toBe(1);
      expect(await receiptCount(rejectedId)).toBe(0);
      const finalEffects = await expectExactMentorEffects(f.actor, draftId, roundId, [
        opening, { stepId: f.flow.steps[1].id, questionId: "goal", opening: true, input: OPENING_INPUT },
      ]);
      for (const identity of initialEffects) expect(finalEffects).toContain(identity);
      await expect.poll(() => form().getByRole("heading", { level: 3 }).textContent(), { timeout: 60000 })
        .toContain("2.1");
      expect(pageErrors).toEqual([]);
      expect(externalRequests).toEqual([]);
      console.log("F1_WORKBENCH_RECOVERY", JSON.stringify({
        targetPhase, draftId, roundId, rejectedId,
        recovered: [lost.information.requestId, lost.save.requestId, lost.confirm.requestId],
        replayCount, initialEffects, finalEffects,
      }));
    } catch (error) {
      console.error("F1_RECOVERY_FAILURE", JSON.stringify({
        targetPhase, phase, fault, routeFailure, pageErrors, externalRequests,
        pending: page ? await page.evaluate(k => sessionStorage.getItem(k), key).catch(() => null) : null,
      }));
      throw error;
    } finally {
      await browser.close();
    }
  },
  300000,
);

/**
 * A draft whose pinned method revision declares topic resources, with every
 * step confirmed and the positioning version published, so the topic workspace
 * has an immutable source version to bind to.
 */
async function publishedDraft(n = 3, withTopics = true) {
  const f = await fixture(
    n,
    false,
    0,
    withTopics ? (flow) => { flow.planResources = ["SKILL.md"]; } : undefined,
  );
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
  const published = await f.artifacts.read(d.projectId, d.roundId);
  await f.artifacts.execute({
    action: "publish", projectId: d.projectId, roundId: d.roundId,
    requestId: randomUUID(),
    expectedSteps: Object.fromEntries(
      Object.entries(published.steps).map(([k, v]) => [k, { version: v.version, reviewVersion: v.reviewVersion }]),
    ),
  });
  const sourceVersionId = (await f.service.read(d.draftId)).report.id as string;
  return { ...f, d, sourceVersionId };
}

/** Every turn, run, reservation and binding the topic workspace created. */
async function topicIdentity(actor: string) {
  const count = async (q: string) =>
    Number((await sql.query(q, [actor])).rows[0].n);
  return {
    binds: await count(
      "select count(*)::int n from opc_topic_workspaces w join opc_drafts d on d.draft_id=w.draft_id where d.actor_id=$1",
    ),
    turns: await count(
      "select count(*)::int n from opc_turns t join opc_drafts d on d.draft_id=t.draft_id where d.actor_id=$1 and t.purpose='topic'",
    ),
    topicExecutions: await count(
      "select count(*)::int n from runtime_executions e join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where e.actor_id=$1 and t.purpose='topic'",
    ),
    topicRuns: await count(
      "select count(*)::int n from bill2_runs b join runtime_executions e on e.billing_run_id=b.id join opc_turns t on t.session_id=e.session_id and t.request_id=e.request_id where b.actor_id=$1 and t.purpose='topic'",
    ),
    reserves: await count(
      "select count(*)::int n from credit_transactions where user_id=$1 and reason_code='bill2_reserve'",
    ),
  };
}

it("OPC: the topic workspace binds one confirmed source and one turn identity, and fails closed without a topic Skill", async () => {
  // (1) The pinned revision of the default fixture declares no topic resources:
  // the host refuses instead of inventing a topic Skill or silently falling
  // back to plain chat, and creates nothing.
  const plain = await publishedDraft(3, false);
  const refused = await plain.service
    .topicBind({
      draftId: plain.d.draftId,
      requestId: randomUUID(),
      sourceVersionId: plain.sourceVersionId,
    })
    .then(() => null)
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  console.log("TOPIC_BIND_REFUSAL", refused);
  expect(refused).toMatch(/OPC_TOPIC_SKILL_MISSING/);
  expect(await plain.service.topicRead(plain.d.draftId)).toEqual({ bound: false });
  expect(await topicIdentity(plain.actor)).toEqual({
    binds: 0, turns: 0, topicExecutions: 0, topicRuns: 0, reserves: 0,
  });

  // (2) With declared topic resources the binding freezes the confirmed
  // version, the pinned method revision and its own Session and material.
  const f = await publishedDraft(3, true);
  const bindRequest = randomUUID();
  const bound = await f.service.topicBind({
    draftId: f.d.draftId,
    requestId: bindRequest,
    sourceVersionId: f.sourceVersionId,
  });
  expect(bound.bound).toBe(true);
  expect(await f.service.topicRead(f.d.draftId)).toMatchObject({
    bound: true,
    sourceVersionId: f.sourceVersionId,
    sessionId: bound.sessionId,
    sourceAllowed: true,
  });
  // The same bind request is free and identical; a different request or source
  // is a definite conflict instead of a silent rebind onto a newer version.
  expect(
    (await f.service.topicBind({
      draftId: f.d.draftId,
      requestId: bindRequest,
      sourceVersionId: f.sourceVersionId,
    })).sessionId,
  ).toBe(bound.sessionId);
  await expect(
    f.service.topicBind({
      draftId: f.d.draftId,
      requestId: randomUUID(),
      sourceVersionId: f.sourceVersionId,
    }),
  ).rejects.toThrow(/OPC_TOPIC_BOUND/);
  const scope = (await sql.query(
    "select scope from runtime_sessions where id=$1",
    [bound.sessionId],
  )).rows[0].scope as { kind: string; draftId: string };
  expect(scope).toEqual({ kind: "positioning_topic", draftId: f.d.draftId });
  const material = (await sql.query(
    "select content from runtime_scope_material where session_id=$1 order by revision desc limit 1",
    [bound.sessionId],
  )).rows[0].content as { brief: string; material: string; roundId: string | null };
  expect(material.brief).toBe("topic:first-week");
  expect(material.material.length).toBeGreaterThan(0);
  expect(material.roundId).toBeNull();
  const afterBind = await topicIdentity(f.actor);
  expect(afterBind).toEqual({
    binds: 1, turns: 0, topicExecutions: 0, topicRuns: 0, reserves: 0,
  });

  // (3) One topic turn is one frozen identity: one execution, one billing run
  // and one reservation. A lost reply replays that identity for free.
  const turnRequest = randomUUID();
  const turn = await f.service.prepareTopicTurn({
    draftId: f.d.draftId,
    requestId: turnRequest,
    input: "给我一版第一周选题。",
  });
  expect(turn.executionId).toBeTruthy();
  expect(
    (await f.service.prepareTopicTurn({
      draftId: f.d.draftId,
      requestId: turnRequest,
      input: "给我一版第一周选题。",
    })).executionId,
  ).toBe(turn.executionId);
  await expect(
    f.service.prepareTopicTurn({
      draftId: f.d.draftId,
      requestId: turnRequest,
      input: "换一条不相干的负载。",
    }),
  ).rejects.toThrow(/OPC_REQUEST_CONFLICT/);
  const afterTurn = await topicIdentity(f.actor);
  expect(afterTurn).toEqual({
    binds: 1, turns: 1, topicExecutions: 1, topicRuns: 1, reserves: 1,
  });

  // (4) The frozen run is authorized only for this Session, this turn identity
  // and this method revision; a substituted Skill or a detached token is
  // refused before any dispatch.
  const frozen = (await sql.query(
    "select b.id::text id, b.payload from bill2_runs b join runtime_executions e on e.billing_run_id=b.id where e.id=$1",
    [turn.executionId],
  )).rows[0] as { id: string; payload: Record<string, unknown> };
  await sql.query("select runtime_direct_billing_allowed($1,$2,$3)", [
    f.actor, frozen.payload, frozen.id,
  ]);
  // A detached turn token is invisible to the older scope checks, so this one
  // proves the topic check itself runs.
  await expect(
    sql.query("select runtime_direct_billing_allowed($1,$2,$3)", [
      f.actor,
      {
        ...frozen.payload,
        input: { ...(frozen.payload.input as Record<string, unknown>), opcTurnToken: randomUUID() },
      },
      frozen.id,
    ]),
  ).rejects.toThrow(/OPC_TOPIC_TURN_REQUIRED/);
  // A substituted Skill, revision or role is refused as well; the existing
  // capability gate may raise before the topic check does.
  await expect(
    sql.query("select runtime_direct_billing_allowed($1,$2,$3)", [
      f.actor,
      { ...frozen.payload, moduleId: randomUUID() },
      frozen.id,
    ]),
  ).rejects.toThrow(/^(OPC_|RUNTIME_|BILL2_)/);
  await expect(
    sql.query("select runtime_direct_billing_allowed($1,$2,$3)", [
      f.actor,
      { ...frozen.payload, revisionId: randomUUID() },
      frozen.id,
    ]),
  ).rejects.toThrow(/^(OPC_|RUNTIME_|BILL2_)/);
  await expect(
    sql.query("select runtime_direct_billing_allowed($1,$2,$3)", [
      f.actor,
      {
        ...frozen.payload,
        input: { ...(frozen.payload.input as Record<string, unknown>), role: "ordinary" },
      },
      frozen.id,
    ]),
  ).rejects.toThrow(/^(OPC_|RUNTIME_|BILL2_)/);

  // (5) Another actor can neither read this workspace nor spend inside it.
  const other = await fixture(3);
  await expect(other.service.topicRead(f.d.draftId)).rejects.toThrow(/OPC_DENIED/);
  await expect(
    other.service.prepareTopicTurn({
      draftId: f.d.draftId,
      requestId: randomUUID(),
      input: "别人的工作空间。",
    }),
  ).rejects.toThrow(/OPC_DENIED/);
  expect(await topicIdentity(f.actor)).toEqual(afterTurn);

  // (6) A revoked source stops new dispatch and keeps every existing record.
  await sql.query("update bill2_drafts set revoked=true where id=$1", [f.d.draftId]);
  await expect(
    f.service.prepareTopicTurn({
      draftId: f.d.draftId,
      requestId: randomUUID(),
      input: "撤回来源后继续。",
    }),
  ).rejects.toThrow(/OPC_(TOPIC_SOURCE_REVOKED|DENIED)/);
  expect(await topicIdentity(f.actor)).toEqual(afterTurn);
  expect(
    Number((await sql.query(
      "select count(*)::int n from runtime_scope_material where session_id=$1",
      [bound.sessionId],
    )).rows[0].n),
  ).toBe(1);
}, 180000);

it("OPC: topic consent concurrency and source mismatch preserve the accepted intent", async () => {
  const f = await publishedDraft();
  const consent = { draftId: f.d.draftId, sourceVersionId: f.sourceVersionId };
  const accepted = await Promise.all([f.service.topicConsent(consent), f.service.topicConsent(consent)]);
  expect(accepted[0]).toEqual(accepted[1]);
  expect(accepted[0].opening.requestId).toBeTruthy();
  const other = await publishedDraft();
  await expect(other.service.topicConsent(consent)).rejects.toThrow(/OPC_DENIED/);
  await expect(f.service.topicConsent({ ...consent, sourceVersionId: other.sourceVersionId })).rejects.toThrow(/OPC_TOPIC_SOURCE_CHANGED/);
  expect(await f.service.topicRead(f.d.draftId)).toEqual(accepted[0]);
  expect(await topicIdentity(f.actor)).toEqual({ binds: 1, turns: 0, topicExecutions: 0, topicRuns: 0, reserves: 0 });
  // Schema may be reapplied to populated records without losing consent.
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../../../../db/migrations/0114_opc_topic_consent.sql', import.meta.url), 'utf8');
  await sql.query(migration);
  expect(await f.service.topicRead(f.d.draftId)).toEqual(accepted[0]);
}, 120000);

it("OPC: old publish and adoption replays cannot roll back the current business source", async () => {
  const f = await publishedDraft();
  const oldPublish = (await sql.query(
    "select request_id::text,round_id::text,payload from artifact_requests where project_id=$1 and action='publish' order by request_id limit 1",
    [f.d.projectId],
  )).rows[0];
  const newer = await publishedDraft();
  const currentSource = newer.sourceVersionId;
  expect(currentSource).not.toBe(f.sourceVersionId);
  await sql.query("update opc_businesses b set current_source_version_id=$1,revision=revision+1 from opc_draft_businesses db where db.draft_id=$2 and b.id=db.business_id", [currentSource, f.d.draftId]);
  const state = async () => (await sql.query(
    "select b.current_source_version_id::text source,b.revision::int revision from opc_businesses b join opc_draft_businesses db on db.business_id=b.id where db.draft_id=$1",
    [f.d.draftId],
  )).rows[0];
  const beforeReplay = await state();
  expect(beforeReplay.source).toBe(currentSource);
  await f.artifacts.execute({
    action: 'publish', projectId: f.d.projectId, roundId: oldPublish.round_id,
    requestId: oldPublish.request_id, expectedSteps: oldPublish.payload.expectedSteps,
  });
  const historicalItemId = randomUUID();
  const historicalAdoption = {
    draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: historicalItemId, platform: 'x', account: 'historical-account', title: '历史来源新采用', brief: '采用旧定位候选但不改变业务当前定位', day: '2026-09-21' }],
    accounts: [{ platform: 'x', account: 'historical-account', expectedRevision: null }],
  };
  await f.service.adoptTopics(historicalAdoption);
  expect(await state()).toEqual(beforeReplay);
  const itemCount = Number((await sql.query("select count(*)::int n from opc_items i join opc_plans p on p.id=i.plan_id where p.draft_id=$1 and i.item_key=$2", [f.d.draftId, historicalItemId])).rows[0].n);
  await expect(f.service.adoptTopics({ ...historicalAdoption, requestId: randomUUID(), expectedVersion: 1 })).rejects.toThrow('OPC_TOPIC_ALREADY_ADOPTED');
  expect(Number((await sql.query("select count(*)::int n from opc_items i join opc_plans p on p.id=i.plan_id where p.draft_id=$1 and i.item_key=$2", [f.d.draftId, historicalItemId])).rows[0].n)).toBe(itemCount);
}, 120000);

it("OPC: B1 browser auto-saves discussion, atomically adopts a subset, edits the library and continues video work", async () => {
  const f = await publishedDraft();
  const modelId = await planFixtureModel(f.moduleId);
  const seed = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'existing-account', title: '原工作', brief: '原有账号项目', day: '2026-09-20' }] });
  await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: seed.planId, accounts: [{ platform: 'x', account: 'existing-account', expectedRevision: null }] });
  const { browser, context, page } = await planBrowser(f);
  const path = '/positioning/' + f.d.draftId + '/topics';
  let lostAdoption = 0;
  try {
    const homeLibrary = page.waitForResponse(response => response.url().includes('opc.library'));
    await page.goto(process.env.V3_LOCAL_APP + '/'); await homeLibrary;
    expect(await page.getByRole('heading', { name: '先完成正式定位', exact: true }).count()).toBe(0);
    await page.goto(process.env.V3_LOCAL_APP + path);
    await page.getByRole('button', { name: '开始选题工作对话', exact: true }).click();
    await page.getByRole('button', { name: '采用所选并保存到资料库', exact: true }).waitFor({ timeout: 60000 });
    expect((await f.service.topicDraftRead(f.d.draftId)).version).toBe(1);
    expect(await page.getByRole('link', { name: '打开内容资料库', exact: true }).count()).toBe(1);

    await page.getByLabel('消息', { exact: true }).fill('请修改第一条选题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await f.service.topicDraftRead(f.d.draftId)).version, { timeout: 60000 }).toBe(2);
    await page.getByLabel('选择 第二个账号选题').uncheck();

    await page.route('**/api/trpc/opc.adoptTopics*', async route => {
      const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort(); lostAdoption += 1;
    });
    await page.getByRole('button', { name: '采用所选并保存到资料库', exact: true }).click();
    await page.getByRole('button', { name: '恢复原请求', exact: true }).waitFor({ timeout: 60000 });
    await expect.poll(() => lostAdoption, { timeout: 30000 }).toBeGreaterThan(0);
    const bound = await f.service.topicRead(f.d.draftId);
    const frozenKey = 'opc-topic-operation:' + bound.sessionId;
    const frozen = JSON.parse((await page.evaluate(key => localStorage.getItem(key), frozenKey))!);
    expect(frozen.kind).toBe('adoptTopics');
    expect(frozen.request.body).toHaveLength(1);
    expect(frozen.request.expectedVersion).toBe(1);
    await page.unroute('**/api/trpc/opc.adoptTopics*');

    await context.clearCookies();
    await page.goto(process.env.V3_LOCAL_APP + '/login?redirect=' + encodeURIComponent(path));
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL(url => url.pathname === path);
    await page.getByRole('button', { name: '恢复原请求', exact: true }).click();
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), frozenKey), { timeout: 30000 }).toBeNull();
    const plans = (await f.service.read(f.d.draftId)).plans;
    expect(plans).toHaveLength(2);
    expect(plans[0].body).toHaveLength(1);
    expect(await page.getByRole('button', {name:'采用所选并保存到资料库',exact:true}).isVisible()).toBe(false);
    await page.getByRole('button', {name:/展开选题/}).click();
    expect(await page.getByLabel('选择 第二个账号选题').isEnabled()).toBe(true);
    await page.getByRole('button', {name:/收起选题/}).click();

    await page.getByRole('link', { name: '打开内容资料库', exact: true }).first().click();
    await page.waitForURL(url => url.pathname === '/library');
    const adoptedCard = page.getByRole('article').filter({ hasText: '修改后的选题' });
    await adoptedCard.getByRole('button', { name: '直接编辑', exact: true }).click();
    await page.getByLabel('选题标题').fill('资料库修订标题');
    await page.getByLabel('完整选题简报').fill('内容：真实案例；对象：起步创作者；价值：明确行动；结构：问题、过程、结果；假设：案例提升收藏。');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByText('资料库修订标题', { exact: true }).waitFor();
    await page.getByRole('article').filter({ hasText: '资料库修订标题' }).getByRole('link', { name: '继续工作', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/runtime');
    await page.getByRole('heading', { name: '资料库修订标题', exact: true }).waitFor();

    await page.getByLabel('消息', { exact: true }).fill('请和我讨论这条视频的口播稿。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 });
    const packageRunsBefore = Number((await sql.query("select count(*)::int n from runtime_executions where actor_id=$1 and session_id=$2 and payload->>'input' like '[OPC_VIDEO_PACKAGE_V1]%'", [f.actor, new URL(page.url()).searchParams.get('session')])).rows[0].n);
    await finalize.click();
    await page.getByRole('heading', { name: '口播稿 · 第 1 版 · 已定稿', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('heading', { name: '口播稿已定稿。要先制作分镜脚本吗？', exact: true }).waitFor();
    expect(Number((await sql.query("select count(*)::int n from runtime_executions where actor_id=$1 and session_id=$2 and payload->>'input' like '[OPC_VIDEO_PACKAGE_V1]%'", [f.actor, new URL(page.url()).searchParams.get('session')])).rows[0].n)).toBe(packageRunsBefore);
    let lostPackage = 0;
    await page.route('**/api/trpc/opc.saveVideoResults*', async route => {
      if (lostPackage++) return route.continue();
      const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort();
    });
    await page.getByRole('button', { name: '先做分镜，再生成剪辑建议', exact: true }).click();
    await expect.poll(async () => (await page.getByRole('alert').allTextContents()).join(' '), { timeout: 60000 }).toContain('状态待核实');
    const videoKey = 'opc-video-operation:' + new URL(page.url()).searchParams.get('session');
    const frozenVideo = JSON.parse((await page.evaluate(key => localStorage.getItem(key), videoKey))!);
    const recoveryTab = await context.newPage();
    await recoveryTab.goto(page.url());
    await expect.poll(() => recoveryTab.evaluate(key => localStorage.getItem(key), videoKey), { timeout: 60000 }).toBeNull();
    const completedVideo = await recoveryTab.evaluate(({key,requestId}) => localStorage.getItem(key + ':completed:' + requestId), { key: videoKey, requestId: frozenVideo.package.requestId });
    expect(JSON.parse(completedVideo!)).toEqual(frozenVideo);
    await recoveryTab.getByRole('heading', { name: '口播稿 · 第 1 版 · 已定稿', exact: true }).waitFor({ timeout: 60000 });
    await recoveryTab.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor();
    await recoveryTab.getByRole('heading', { name: '剪辑建议 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor();
    await recoveryTab.close();
    const library = await f.service.library({ search: '资料库修订标题', from: null, to: null });
    const [savedItem] = library.businesses[0].accounts.flatMap((account: {items: any[]}) => account.items);
    expect(savedItem).toBeDefined();
    const script = savedItem.content.find((entry: {kind: string}) => entry.kind === 'script');
    const completedPackage = (await sql.query("select id::text from runtime_executions where actor_id=$1 and session_id=$2 and state='completed' and payload->>'input' like '[OPC_VIDEO_PACKAGE_V1]%'", [f.actor, savedItem.sessionId])).rows[0].id;
    await sql.query("update runtime_executions set result=jsonb_build_object('body','{}') where id=$1", [completedPackage]);
    await expect(f.service.videoPackage({ workItemId: savedItem.workItemId, requestId: randomUUID(), executionId: completedPackage, sourceScriptId: script.id, expectedStoryboardVersion: 1, expectedEditingVersion: 1 })).rejects.toThrow('OPC_CONTENT_RESPONSE_INVALID');
    const materialRevision = Number((await sql.query("select payload#>>'{scopeMaterial,revision}' revision from runtime_executions where id=$1", [script.executionId])).rows[0].revision);
    await sql.query("select runtime_material($1,$2,'revoke',NULL,$3)", [f.actor, savedItem.sessionId, materialRevision]);
    const withdrawn = await f.service.library({ search: '资料库修订标题', from: null, to: null });
    const withdrawnItem = withdrawn.businesses[0].accounts.flatMap((account: {items: any[]}) => account.items)[0];
    expect(withdrawnItem.content.map((entry: {contentAvailable: boolean}) => entry.contentAvailable)).toEqual([false, false, false]);
    const { runtimeAdmissionService } = await import('../runtime/admission');
    const admission = runtimeAdmissionService(f.user, admin, { account: 'local', costPerCall: '0.02', creditsPerUsd: '1000', multiplier: '1', maxCalls: 1, maxOutputTokens: 1000, inputBytes: 32000, historyItems: 20, searchEnabled: false });
    const runsBefore = Number((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1', [f.actor])).rows[0].n);
    await expect(admission.prepare({ sessionId: savedItem.sessionId, requestId: randomUUID(), input: '继续使用已撤回口播稿', selection: { kind: 'ordinary', modelId }, network: 'deny', sources: [] })).rejects.toThrow('RUNTIME_ADMISSION_DENIED');
    expect(Number((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1', [f.actor])).rows[0].n)).toBe(runsBefore);
  } finally { await browser.close(); }
}, 300000);

it("OPC: B1 business scope, legacy handoff replay and library edits stay owned and versioned", async () => {
  const f = await publishedDraft();
  const businessId = (await sql.query(
    "select business_id::text from opc_draft_businesses where draft_id=$1",
    [f.d.draftId],
  )).rows[0].business_id as string;
  const publishedLibrary = await f.service.library({ search: "", from: null, to: null });
  expect(publishedLibrary.businesses.find((entry: {businessId: string}) => entry.businessId === businessId).sourceAvailable).toBe(true);
  const shared = await f.service.start({
    requestId: randomUUID(), registration: f.registration, mode: "manual", businessId,
  });
  expect(shared.businessId).toBe(businessId);
  const isolated = await f.service.start({
    requestId: randomUUID(), registration: f.registration, mode: "manual", businessName: "隔离业务",
  });
  expect(isolated.businessId).not.toBe(businessId);

  const body = [{
    id: randomUUID(), platform: "x", account: "owned-account", title: "可恢复的选题",
    brief: "完整简报保留内容、对象、价值、结构和待验证假设。", day: "2026-09-23",
  }];
  const plan = await f.service.savePlan({
    draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0,
    sourceVersionId: f.sourceVersionId, body,
  });
  const handoffRequest = {
    draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId,
    accounts: [{ platform: "x", account: "owned-account", expectedRevision: null }],
  };
  const first = await f.service.handoff(handoffRequest);
  expect(await f.service.handoff(handoffRequest)).toEqual(first);

  const library = await f.service.library({ search: "可恢复的选题", from: null, to: null });
  const ownedBusiness = library.businesses.find((entry: {businessId: string}) => entry.businessId === businessId);
  const item = ownedBusiness.accounts.flatMap((account: {items: Array<{workItemId: string;revision: number}>}) => account.items)[0];
  expect(item.workItemId).toBe(first[0].workItemId);
  const editRequest = {
    requestId: randomUUID(), target: "item", targetId: item.workItemId, expectedRevision: item.revision,
    patch: { title: "资料库已修订", brief: "修订后的完整简报仍可追溯。", day: "2026-09-24" },
  };
  const edit = await f.service.libraryEdit(editRequest);
  expect(await f.service.libraryEdit(editRequest)).toEqual(edit);
  await expect(f.service.libraryEdit({ ...editRequest, requestId: randomUUID() })).rejects.toThrow("OPC_VERSION_CONFLICT");

  await sql.query("update opc_accounts set business_id=$1 where project_id=$2", [isolated.businessId, first[0].projectId]);
  await expect(f.service.handoff({
    ...handoffRequest, requestId: randomUUID(),
    accounts: [{ platform: "x", account: "owned-account", expectedRevision: 1 }],
  })).rejects.toThrow("OPC_BUSINESS_CONFLICT");

  const other = await publishedDraft();
  const otherLibrary = await other.service.library({ search: "资料库已修订", from: null, to: null });
  expect(otherLibrary.businesses.flatMap((entry: {accounts: Array<{items: unknown[]}>}) =>
    entry.accounts.flatMap(account => account.items))).toHaveLength(0);
  await expect(other.service.libraryEdit({
    requestId: randomUUID(), target: "item", targetId: item.workItemId, expectedRevision: edit.revision,
    patch: { title: "越权修改", brief: "不能写入其他用户的完整简报。", day: "2026-09-25" },
  })).rejects.toThrow("OPC_DENIED");

  await sql.query("insert into opc_content_versions(actor_id,work_item_id,kind,version,status,body,request_id) values($1,$2,'brief',1,'final','撤回后不得读取的成果正文',$3)", [f.actor, item.workItemId, randomUUID()]);
  await sql.query("update bill2_drafts set revoked=true where id=$1", [f.d.draftId]);
  const revoked = await f.service.library({ search: "", from: null, to: null });
  const hidden = revoked.businesses.flatMap((entry: {accounts: Array<{items: unknown[]}>}) => entry.accounts.flatMap(account => account.items))
    .find((entry: {workItemId: string}) => entry.workItemId === item.workItemId);
  expect(hidden).toMatchObject({ sourceAvailable: false, brief: null });
  expect(hidden.content[0]).toMatchObject({ body: null, contentAvailable: false });
  const hiddenSearch = await f.service.library({ search: "修订后的完整简报", from: null, to: null });
  expect(hiddenSearch.businesses.flatMap((entry: {accounts: Array<{items: unknown[]}>}) => entry.accounts.flatMap(account => account.items))).toHaveLength(0);
  await expect(f.service.libraryEdit({ ...editRequest, requestId: randomUUID(), expectedRevision: edit.revision })).rejects.toThrow("OPC_DENIED");
}, 120000);

it("OPC: new business start restores the complete frozen request before another business can begin", async () => {
  const f=await publishedDraft();
  const originalBusiness=(await sql.query('select business_id::text id from opc_draft_businesses where draft_id=$1',[f.d.draftId])).rows[0].id;
  const otherBusiness=await f.service.start({requestId:randomUUID(),registration:f.registration,mode:'manual',businessName:'另一个业务'});
  const otherActor=await publishedDraft();
  const {browser,page}=await planBrowser(f);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/positioning');
    await page.getByRole('button',{name:'为另一个产品、服务或品牌开始定位',exact:true}).click();
    await page.getByLabel('定位方法').selectOption(f.registration);
    await page.getByLabel('所属业务').selectOption(originalBusiness);
    let lost=0;
    await page.route('**/api/trpc/opc.start*',async route=>{const response=await route.fetch();expect(response.ok()).toBe(true);lost+=1;await route.abort();});
    await page.getByRole('button',{name:'我从零开始 · Agent 引导',exact:true}).click();
    await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).waitFor({timeout:60000});
    await expect.poll(()=>lost,{timeout:60000}).toBe(1);
    const startKey='opc-start-operation:'+f.actor;
    const frozen=JSON.parse((await page.evaluate(key=>sessionStorage.getItem(key),startKey))!);
    expect(frozen).toMatchObject({actorId:f.actor,registration:f.registration,mode:'mentor',businessId:originalBusiness});
    await page.getByLabel('所属业务').selectOption(otherBusiness.businessId);
    expect(await page.getByRole('button',{name:'我从零开始 · Agent 引导',exact:true}).isDisabled()).toBe(true);
    await page.context().clearCookies();
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect=/positioning');
    await page.getByPlaceholder('name@example.com').fill(otherActor.email);
    await page.getByPlaceholder('输入你的密码').fill(otherActor.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/positioning');
    await page.getByRole('heading',{name:'开始经营你的账号',exact:true}).waitFor();
    expect(await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).count()).toBe(0);
    expect(await page.evaluate(key=>sessionStorage.getItem(key),startKey)).toBeTruthy();
    await page.context().clearCookies();
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect=/positioning');
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/positioning');
    await page.getByRole('heading',{name:'开始经营你的账号',exact:true}).waitFor();
    await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).waitFor();
    await page.unroute('**/api/trpc/opc.start*');
    await page.getByRole('button',{name:'恢复上次开始请求',exact:true}).click();
    await page.waitForURL(url=>/^\/positioning\/[0-9a-f-]+$/.test(url.pathname),{timeout:60000});
    const restoredDraft=page.url().split('/').at(-1)!;
    expect((await sql.query('select business_id::text id from opc_draft_businesses where draft_id=$1',[restoredDraft])).rows[0].id).toBe(originalBusiness);
    expect(await page.evaluate(key=>sessionStorage.getItem(key),startKey)).toBeNull();
  }finally{await browser.close();}
},180000);

it("OPC: library edit binds fields and revision to one snapshot across a concurrent refresh", async()=>{
  const f=await publishedDraft();
  const plan=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,
    body:[{id:randomUUID(),platform:'x',account:'edit-account',title:'原始标题',brief:'原始简报',day:'2026-09-25'}]});
  const [work]=await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:plan.planId,accounts:[{platform:'x',account:'edit-account',expectedRevision:null}]});
  const {browser,page}=await planBrowser(f);
  try{
    await page.goto(process.env.V3_LOCAL_APP+'/library');
    const card=page.getByRole('article').filter({hasText:'原始标题'});
    await card.getByRole('button',{name:'直接编辑',exact:true}).click();
    await page.getByLabel('选题标题').fill('本标签准备保存的标题');
    const before=(await f.service.library({search:'原始标题',from:null,to:null})).businesses.flatMap((business:{accounts:Array<{items:Array<{workItemId:string;revision:number}>}>})=>business.accounts.flatMap(account=>account.items)).find((item:{workItemId:string})=>item.workItemId===work.workItemId)!;
    await f.service.libraryEdit({requestId:randomUUID(),target:'item',targetId:work.workItemId,expectedRevision:before.revision,patch:{title:'另一标签已保存的标题',brief:'另一标签已保存的简报',day:'2026-09-26'}});
    const refreshed=page.waitForResponse(response=>response.url().includes('opc.library')&&response.ok());
    await page.getByLabel('当前阶段 edit-account').selectOption('starting');
    await refreshed;
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect.poll(async()=>(await page.getByRole('alert').allTextContents()).join(' '),{timeout:30000}).toContain('没有覆盖更新后的内容');
    const library=await f.service.library({search:'另一标签已保存的标题',from:null,to:null});
    const saved=library.businesses.flatMap((business:{accounts:Array<{items:Array<{workItemId:string;title:string;brief:string;day:string}>}>})=>business.accounts.flatMap(account=>account.items)).find((item:{workItemId:string})=>item.workItemId===work.workItemId);
    expect(saved).toMatchObject({title:'另一标签已保存的标题',brief:'另一标签已保存的简报',day:'2026-09-26'});
  }finally{await browser.close();}
},180000);

it("OPC: final script asks before derivatives, supports a partial choice, and marks prior results old after re-finalizing", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const plan = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'consent-account', title: '口播稿授权边界', brief: '验证口播稿定稿与分镜、剪辑建议的授权分离。', day: '2026-09-26' }] });
  const [work] = await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId,
    accounts: [{ platform: 'x', account: 'consent-account', expectedRevision: null }] });
  const { browser, page } = await planBrowser(f);
  const packageRuns = async () => Number((await sql.query("select count(*)::int n from runtime_executions where actor_id=$1 and session_id=$2 and payload->>'input' like '[OPC_VIDEO_PACKAGE_V1]%'", [f.actor, work.sessionId])).rows[0].n);
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/runtime?session=' + work.sessionId);
    await page.getByLabel('消息', { exact: true }).fill('先讨论并给我第一版口播稿。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 });
    await finalize.click();
    await page.getByRole('heading', { name: '口播稿已定稿。要先制作分镜脚本吗？', exact: true }).waitFor();
    expect(await packageRuns()).toBe(0);
    expect(await page.getByRole('button',{name:'只生成剪辑建议',exact:true}).count()).toBe(0);
    await page.getByLabel('消息',{exact:true}).fill('只生成剪辑建议');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(async()=>(await page.getByRole('alert').allTextContents()).join(' ')).toContain('请先完成');
    expect(await packageRuns()).toBe(0);
    const firstContent=(await sql.query("select id from opc_content_versions where work_item_id=$1 and kind='script'",[work.workItemId])).rows[0];
    await expect(f.service.videoMaterialPrepare({workItemId:work.workItemId,requestId:randomUUID(),sourceScriptId:firstContent.id,choice:'editing',expectedStoryboardVersion:0,expectedEditingVersion:0})).rejects.toThrow('OPC_STORYBOARD_REQUIRED');

    // A pre-upgrade editing-only binding keeps its original material on replay.
    const {readFileSync}=await import('node:fs');
    const legacyChoice={workItemId:work.workItemId,requestId:randomUUID(),sourceScriptId:firstContent.id,choice:'editing' as const,expectedStoryboardVersion:0,expectedEditingVersion:0};
    await sql.query(readFileSync('../../packages/db/migrations/0119_opc_video_admission.sql','utf8'));
    const legacyMaterial=await f.service.videoMaterialPrepare(legacyChoice);
    await sql.query(readFileSync('../../packages/db/migrations/0121_opc_storyboard_dependency.sql','utf8'));
    await sql.query(readFileSync('../../packages/db/migrations/0121_opc_storyboard_dependency.sql','utf8'));
    expect(await f.service.videoMaterialPrepare(legacyChoice)).toEqual({sessionId:legacyMaterial.sessionId,revision:legacyMaterial.revision,hash:legacyMaterial.hash});
    await f.service.videoMaterialPrepare({...legacyChoice,action:'abandon'});
    const independent=await browser.newContext();
    await independent.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol)?route.continue():route.abort();});
    const staleTab=await independent.newPage();staleTab.setDefaultTimeout(90000);
    await staleTab.goto(process.env.V3_LOCAL_APP+'/login?redirect='+encodeURIComponent('/runtime?session='+work.sessionId));
    await staleTab.getByPlaceholder('name@example.com').fill(f.email);
    await staleTab.getByPlaceholder('输入你的密码').fill(f.password);
    await staleTab.getByRole('button',{name:'登录',exact:true}).last().click();
    await staleTab.waitForURL(url=>url.pathname==='/runtime');
    await staleTab.getByRole('button', { name: '只生成分镜', exact: true }).waitFor();
    let releaseSecond!:()=>void,secondPrepared=false;const secondGate=new Promise<void>(resolve=>{releaseSecond=resolve;});
    await staleTab.route('**/api/trpc/opc.prepareVideoMaterial*',async route=>{secondPrepared=true;await secondGate;await route.continue();});
    const secondClick=staleTab.getByRole('button',{name:'只生成分镜',exact:true}).click();
    await expect.poll(()=>secondPrepared,{timeout:30000}).toBe(true);

    await page.getByLabel('消息', { exact: true }).fill('只生成分镜');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor({ timeout: 60000 });
    expect(await packageRuns()).toBe(1);
    expect(await page.getByRole('heading', { name: /剪辑建议 · 第 1 版/ }).count()).toBe(0);
    expect(await page.getByText('[OPC_VIDEO_PACKAGE_V1]',{exact:false}).count()).toBe(0);
    expect(await page.getByText('只返回严格 JSON',{exact:false}).count()).toBe(0);
    expect(await page.getByText('{"storyboard":',{exact:false}).count()).toBe(0);
    releaseSecond();await secondClick;
    await expect.poll(async()=>(await staleTab.getByRole('alert').allTextContents()).join(' '),{timeout:60000}).toContain('OPC_CONTENT_ALREADY_GENERATED');
    expect(await packageRuns()).toBe(1);
    await independent.close();

    expect(await packageRuns()).toBe(1);

    const pendingResponse=await fetch(process.env.V3_LOCAL_REST!+'/__runtime_pending',{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});
    expect(pendingResponse.ok).toBe(true);
    await page.getByRole('button', { name: '只生成剪辑建议', exact: true }).click();
    await expect.poll(async()=>(await page.getByRole('alert').allTextContents()).join(' '),{timeout:60000}).toContain('状态待核实');
    const videoKey='opc-video-operation:'+work.sessionId;
    const pendingOperation=JSON.parse((await page.evaluate(key=>localStorage.getItem(key),videoKey))!);
    expect(pendingOperation.followup.executionId).toBeTruthy();
    expect(await packageRuns()).toBe(2);
    const frozenMaterial=(await sql.query("select m.content from opc_video_material_bindings b join runtime_scope_material m on m.session_id=b.session_id and m.revision=b.material_revision where b.request_id=$1",[pendingOperation.followup.requestId])).rows[0].content;
    expect(JSON.parse(frozenMaterial.material).storyboardVersion).toBe(1);
    expect(JSON.parse(frozenMaterial.material).storyboard).toContain('镜头 1');
    const beforeRefinalize=(await f.service.library({search:'口播稿授权边界',from:null,to:null})).businesses
      .flatMap((business:{accounts:Array<{items:Array<{workItemId:string;content:Array<{id:string;kind:string;executionId:string;version:number}>}>}>})=>business.accounts.flatMap(account=>account.items))
      .find((item:{workItemId:string})=>item.workItemId===work.workItemId)!;
    const firstScript=beforeRefinalize.content.find(entry=>entry.kind==='script')!;
    await f.service.contentFromExecution({workItemId:work.workItemId,requestId:randomUUID(),expectedVersion:1,kind:'script',status:'final',executionId:firstScript.executionId,sourceContentId:null});
    const finalResponse=await fetch(process.env.V3_LOCAL_REST!+'/__runtime_final',{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});
    expect(finalResponse.ok).toBe(true);
    await page.reload();
    await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),videoKey),{timeout:60000}).toBeNull();
    await page.getByRole('heading', { name: '口播稿 · 第 2 版 · 已定稿', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 旧口播稿版本', exact: true }).waitFor();
    await page.getByRole('heading', { name: '剪辑建议 · 第 1 版 · 已定稿 · 旧口播稿版本', exact: true }).waitFor({ timeout: 60000 });
    expect(await packageRuns()).toBe(2);
    await page.getByRole('heading', { name: '口播稿已定稿。要先制作分镜脚本吗？', exact: true }).waitFor();
    await page.getByRole('button', { name: '暂时结束', exact: true }).click();
    expect(await page.getByRole('heading', { name: '口播稿已定稿。要先制作分镜脚本吗？', exact: true }).count()).toBe(0);
    const storyboardExecution=beforeRefinalize.content.find(entry=>entry.kind==='storyboard')!.executionId;
    const storyMaterial=(await sql.query("select (payload#>>'{scopeMaterial,revision}')::bigint revision from runtime_executions where id=$1",[storyboardExecution])).rows[0].revision;
    await sql.query("select runtime_material($1,$2,'revoke',NULL,$3)",[f.actor,work.sessionId,storyMaterial]);
    expect((await sql.query('select runtime_history_available($1) allowed',[pendingOperation.followup.executionId])).rows[0].allowed).toBe(false);

  } finally { await fetch(process.env.V3_LOCAL_REST!+'/__runtime_final',{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}}).catch(()=>null);await browser.close(); }
}, 300000);

it("OPC: completed video generation permits the next dialogue and a new script final", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const plan = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'post-video-dialogue', title: '派生后继续讨论', brief: '验证派生成功后继续讨论并重新定稿。', day: '2026-09-26' }] });
  const [work] = await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId,
    accounts: [{ platform: 'x', account: 'post-video-dialogue', expectedRevision: null }] });
  const { browser, page } = await planBrowser(f);
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/runtime?session=' + work.sessionId);
    await page.getByLabel('消息', { exact: true }).fill('先给我一版口播稿。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    let finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 }); await finalize.click();
    await page.getByRole('button', { name: '只生成分镜', exact: true }).click();
    await page.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor({ timeout: 60000 });
    expect(await page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true }).count()).toBe(0);

    const rewriteInput = '请继续讨论并给我一版改写后的口播稿。';
    await page.getByLabel('消息', { exact: true }).fill(rewriteInput);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const rewriteCard = page.getByRole('article').filter({ hasText: rewriteInput });
    finalize = rewriteCard.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 }); await finalize.click();
    await page.getByRole('heading', { name: '口播稿 · 第 2 版 · 已定稿', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 旧口播稿版本', exact: true }).waitFor();
    await page.getByRole('heading', { name: '口播稿已定稿。要先制作分镜脚本吗？', exact: true }).waitFor();
    expect((await page.getByRole('alert').allTextContents()).join(' ')).not.toContain('当前执行不可用');
    const rewriteExecution = (await sql.query("select id from runtime_executions where actor_id=$1 and session_id=$2 and payload->>'input'=$3", [f.actor, work.sessionId, rewriteInput])).rows[0];
    const savedScript = (await sql.query("select execution_id from opc_content_versions where actor_id=$1 and work_item_id=$2 and kind='script' and version=2", [f.actor, work.workItemId])).rows[0];
    expect(savedScript.execution_id).toBe(rewriteExecution.id);
  } finally { await browser.close(); }
}, 240000);

it("OPC: definite pre-admission failure revokes its claim and permits an explicit retry", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const plan = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'admission-retry', title: '准入失败恢复', brief: '验证未创建 execution 的确定失败不会永久占位。', day: '2026-09-27' }] });
  const [work] = await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId,
    accounts: [{ platform: 'x', account: 'admission-retry', expectedRevision: null }] });
  const { browser, page } = await planBrowser(f);
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/runtime?session=' + work.sessionId);
    await page.getByLabel('消息', { exact: true }).fill('生成一版口播稿。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 }); await finalize.click();
    await page.getByRole('heading', { name: '口播稿 · 第 1 版 · 已定稿', exact: true }).waitFor({ timeout: 60000 });
    let lateRequestBody = '';
    await page.route('**/api/trpc/runtime.prepare*', route => {
      if (!(route.request().postData() ?? '').includes('OPC_VIDEO_PACKAGE_V1')) return route.continue();
      lateRequestBody = route.request().postData()!;
      return route.abort();
    });
    await page.getByRole('button', { name: '只生成分镜', exact: true }).click();
    await expect.poll(async () => (await page.getByRole('alert').allTextContents()).join(' '), { timeout: 60000 }).toContain('明确拒绝');
    const abandoned = (await sql.query('select b.request_id,m.revoked from opc_video_material_bindings b join runtime_scope_material m on m.session_id=b.session_id and m.revision=b.material_revision where b.actor_id=$1 and b.work_item_id=$2 order by b.created_at desc limit 1', [f.actor, work.workItemId])).rows[0];
    expect(abandoned.revoked).toBe(true);
    expect((await sql.query('select count(*)::int n from runtime_executions where actor_id=$1 and request_id=$2', [f.actor, abandoned.request_id])).rows[0].n).toBe(0);
    await page.unroute('**/api/trpc/runtime.prepare*');
    await page.getByRole('button', { name: '只生成分镜', exact: true }).click();
    await page.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor({ timeout: 60000 });
    expect(lateRequestBody).toContain('OPC_VIDEO_PACKAGE_V1');
    await page.evaluate(async body => {
      await fetch('/api/trpc/runtime.prepare?batch=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    }, lateRequestBody);
    expect((await sql.query('select count(*)::int n from runtime_executions where actor_id=$1 and request_id=$2', [f.actor, abandoned.request_id])).rows[0].n).toBe(0);
    expect((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1 and request_id=$2', [f.actor, abandoned.request_id])).rows[0].n).toBe(0);
    expect(Number((await sql.query("select count(*)::int n from runtime_executions where actor_id=$1 and session_id=$2 and payload->>'input' like '[OPC_VIDEO_PACKAGE_V1]%'", [f.actor, work.sessionId])).rows[0].n)).toBe(1);
  } finally { await browser.close(); }
}, 240000);

it("OPC: video claim material stays exclusive and a rejected claim can be retried", async () => {
  const { runtimeAdmissionService } = await import('../runtime/admission');
  const f = await publishedDraft();
  const modelId = await planFixtureModel(f.moduleId);
  const plan = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'shared-material', title: '共享材料保护', brief: '验证其他执行冻结后不能撤销材料。', day: '2026-09-29' }] });
  const [work] = await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId,
    accounts: [{ platform: 'x', account: 'shared-material', expectedRevision: null }] });
  const { browser, page } = await planBrowser(f);
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/runtime?session=' + work.sessionId);
    await page.getByLabel('消息', { exact: true }).fill('生成一版口播稿。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 }); await finalize.click();
    await page.getByRole('heading', { name: '口播稿 · 第 1 版 · 已定稿', exact: true }).waitFor({ timeout: 60000 });
    const item = (await f.service.library({ search: '', from: null, to: null })).businesses
      .flatMap((business: {accounts: Array<{items: Array<{workItemId: string;content: Array<{id: string;kind: string}>}>}>}) => business.accounts.flatMap(account => account.items))
      .find((entry: {workItemId: string}) => entry.workItemId === work.workItemId)!;
    const script = item.content.find(entry => entry.kind === 'script')!;
    const claimRequestId = randomUUID();
    const material = await f.service.videoMaterialPrepare({ workItemId: work.workItemId, requestId: claimRequestId, sourceScriptId: script.id,
      choice: 'storyboard', expectedStoryboardVersion: 0, expectedEditingVersion: 0 });
    const admission = runtimeAdmissionService(f.user, admin, { account: 'local', costPerCall: '0.02', creditsPerUsd: '1000', multiplier: '1', maxCalls: 1, maxOutputTokens: 1000, inputBytes: 32000, historyItems: 20, searchEnabled: false });
    const otherRequestId = randomUUID();
    await expect(admission.prepare({ sessionId: work.sessionId, requestId: otherRequestId, input: '尝试占用视频请求的专属材料', selection: { kind: 'ordinary', modelId }, network: 'deny', sources: [] })).rejects.toThrow('RUNTIME_ADMISSION_DENIED');
    expect((await sql.query('select count(*)::int n from runtime_executions where actor_id=$1 and request_id=$2', [f.actor, otherRequestId])).rows[0].n).toBe(0);
    expect((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1 and request_id=$2', [f.actor, otherRequestId])).rows[0].n).toBe(0);
    await f.service.videoMaterialPrepare({ action: 'abandon', workItemId: work.workItemId, requestId: claimRequestId, sourceScriptId: script.id,
      choice: 'storyboard', expectedStoryboardVersion: 0, expectedEditingVersion: 0 });
    expect((await sql.query('select revoked from runtime_scope_material where session_id=$1 and revision=$2', [work.sessionId, material.revision])).rows[0].revoked).toBe(true);
    const retry = await f.service.videoMaterialPrepare({ workItemId: work.workItemId, requestId: randomUUID(), sourceScriptId: script.id,
      choice: 'storyboard', expectedStoryboardVersion: 0, expectedEditingVersion: 0 });
    expect(retry.revision).toBeGreaterThan(material.revision);
  } finally { await browser.close(); }
}, 240000);

it("OPC: upgraded legacy partial result blocks a duplicate dispatch and remains recoverable", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const plan = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'legacy-partial', title: '旧单项结果恢复', brief: '验证升级前已完成但丢回包的单项结果。', day: '2026-09-28' }] });
  const [work] = await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId,
    accounts: [{ platform: 'x', account: 'legacy-partial', expectedRevision: null }] });
  const { browser, page } = await planBrowser(f);
  const packageRuns = async () => Number((await sql.query("select count(*)::int n from runtime_executions where actor_id=$1 and session_id=$2 and payload->>'input' like '[OPC_VIDEO_PACKAGE_V1]%'", [f.actor, work.sessionId])).rows[0].n);
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/runtime?session=' + work.sessionId);
    await page.getByLabel('消息', { exact: true }).fill('生成一版口播稿。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 }); await finalize.click();
    await page.route('**/api/trpc/opc.saveVideoResults*', route => route.abort());
    await page.getByRole('button', { name: '只生成分镜', exact: true }).click();
    await expect.poll(async () => (await page.getByRole('alert').allTextContents()).join(' '), { timeout: 60000 }).toContain('状态待核实');
    const key = 'opc-video-operation:' + work.sessionId;
    const original = JSON.parse((await page.evaluate(k => localStorage.getItem(k), key))!);
    expect(original.followup.executionId).toBeTruthy(); expect(await packageRuns()).toBe(1);
    await sql.query('alter table opc_video_material_bindings disable trigger artifact_immutable');
    try { await sql.query('update opc_video_material_bindings set storyboard=null,editing=null,expected_storyboard_version=null,expected_editing_version=null where actor_id=$1 and request_id=$2', [f.actor, original.followup.requestId]); }
    finally { await sql.query('alter table opc_video_material_bindings enable trigger artifact_immutable'); }

    const independent = await browser.newContext();
    await independent.route('**/*', route => { const u = new URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(u.hostname) || ['data:', 'blob:'].includes(u.protocol) ? route.continue() : route.abort(); });
    const retry = await independent.newPage(); retry.setDefaultTimeout(90000);
    await retry.goto(process.env.V3_LOCAL_APP + '/login?redirect=' + encodeURIComponent('/runtime?session=' + work.sessionId));
    await retry.getByPlaceholder('name@example.com').fill(f.email); await retry.getByPlaceholder('输入你的密码').fill(f.password);
    await retry.getByRole('button', { name: '登录', exact: true }).last().click(); await retry.waitForURL(url => url.pathname === '/runtime');
    await retry.getByRole('button', { name: '只生成分镜', exact: true }).click();
    await expect.poll(async () => (await retry.getByRole('alert').allTextContents()).join(' '), { timeout: 60000 }).toContain('OPC_CONTENT_ALREADY_GENERATED');
    expect(await packageRuns()).toBe(1); await independent.close();

    await page.unroute('**/api/trpc/opc.saveVideoResults*'); await page.reload();
    await page.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor({ timeout: 60000 });
    expect(await packageRuns()).toBe(1);
    const beforeRefinalize = (await f.service.library({ search: '旧单项结果恢复', from: null, to: null })).businesses
      .flatMap((business: {accounts: Array<{items: Array<{workItemId: string;content: Array<{id: string;kind: string;executionId: string}>}>}>}) => business.accounts.flatMap(account => account.items))
      .find((item: {workItemId: string}) => item.workItemId === work.workItemId)!;
    const firstScript = beforeRefinalize.content.find(entry => entry.kind === 'script')!;
    const secondScript = await f.service.contentFromExecution({ workItemId: work.workItemId, requestId: randomUUID(), expectedVersion: 1,
      kind: 'script', status: 'final', executionId: firstScript.executionId, sourceContentId: null });
    await page.reload();
    await page.getByRole('heading', { name: '口播稿 · 第 2 版 · 已定稿', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: '只生成分镜', exact: true }).click();
    await expect.poll(async () => {
      const item = (await f.service.library({ search: '旧单项结果恢复', from: null, to: null })).businesses
        .flatMap((business: {accounts: Array<{items: Array<{workItemId: string;content: Array<{kind: string;sourceContentId: string|null}>}>}>}) => business.accounts.flatMap(account => account.items))
        .find((entry: {workItemId: string}) => entry.workItemId === work.workItemId);
      return item?.content.filter(entry => entry.kind === 'storyboard' && entry.sourceContentId === secondScript.id).length ?? 0;
    }, { timeout: 60000 }).toBe(1);
    await page.reload();
    await page.getByRole('heading', { name: '分镜 · 第 2 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor({ timeout: 60000 });
    expect(await packageRuns()).toBe(2);
  } finally { await browser.close(); }
}, 300000);

it("OPC: natural-language adoption stays complete after refresh and permits the next turn", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const { browser, page } = await planBrowser(f);
  const path = '/positioning/' + f.d.draftId + '/topics';
  try {
    await page.goto(process.env.V3_LOCAL_APP + path);
    await page.getByRole('button', { name: '开始选题工作对话', exact: true }).click();
    await page.getByRole('button', { name: '采用所选并保存到资料库', exact: true }).waitFor({ timeout: 60000 });
    await page.getByLabel('消息', { exact: true }).fill('采用第一条选题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await f.service.read(f.d.draftId)).handoffs.length, { timeout: 60000 }).toBe(1);
    const before = await f.service.read(f.d.draftId);
    await page.reload();
    await page.getByLabel('消息', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '恢复原请求', exact: true }).count()).toBe(0);
    expect((await page.getByRole('alert').allTextContents()).join(' ')).not.toContain('原请求身份');
    await page.getByLabel('消息', { exact: true }).fill('请继续修改标题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await f.service.topicDraftRead(f.d.draftId)).version, { timeout: 60000 }).toBe(2);
    const after = await f.service.read(f.d.draftId);
    expect(after.handoffs).toEqual(before.handoffs);
    expect(after.plans).toEqual(before.plans);
  } finally { await browser.close(); }
}, 240000);

it("OPC: video package dispatch refuses a different frozen material before admission", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const plan = await f.service.savePlan({ draftId: f.d.draftId, requestId: randomUUID(), expectedVersion: 0, sourceVersionId: f.sourceVersionId,
    body: [{ id: randomUUID(), platform: 'x', account: 'binding-account', title: '绑定检查', brief: '验证口播稿与分镜来源绑定。', day: '2026-09-25' }] });
  const [work] = await f.service.handoff({ draftId: f.d.draftId, requestId: randomUUID(), planId: plan.planId, accounts: [{ platform: 'x', account: 'binding-account', expectedRevision: null }] });
  const { browser, page } = await planBrowser(f);
  let releasePrepare!: () => void;
  let packagePrepare = false;
  const gate = new Promise<void>(resolve => { releasePrepare = resolve; });
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/runtime?session=' + work.sessionId);
    await page.getByLabel('消息', { exact: true }).fill('生成一版口播稿');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const finalize = page.getByRole('button', { name: '将这条回复定稿为口播稿', exact: true });
    await finalize.waitFor({ timeout: 60000 });
    await finalize.click();
    await page.getByRole('heading', { name: '口播稿已定稿。要先制作分镜脚本吗？', exact: true }).waitFor();
    await page.route('**/api/trpc/runtime.prepare*', async route => {
      if (!(route.request().postData() ?? '').includes('OPC_VIDEO_PACKAGE_V1')) return route.continue();
      packagePrepare = true; await gate; await route.continue();
    });
    const click = page.getByRole('button', { name: '先做分镜，再生成剪辑建议', exact: true }).click();
    await expect.poll(() => packagePrepare, { timeout: 30000 }).toBe(true);
    const pendingVideo = JSON.parse((await page.evaluate(key => localStorage.getItem(key), 'opc-video-operation:' + work.sessionId))!);
    const current = (await f.service.library({ search: '绑定检查', from: null, to: null })).businesses
      .flatMap((business: {accounts: Array<{items: Array<{workItemId: string;revision: number}>}>}) => business.accounts.flatMap(account => account.items))
      .find((item: {workItemId: string}) => item.workItemId === work.workItemId);
    await f.service.libraryEdit({ requestId: randomUUID(), target: 'item', targetId: work.workItemId, expectedRevision: current.revision,
      patch: { title: '绑定检查已改', brief: '此修改产生另一份冻结 material。', day: '2026-09-25' } });
    releasePrepare(); await click;
    await expect.poll(async () => (await page.getByRole('alert').allTextContents()).join(' '), { timeout: 60000 }).toContain('明确拒绝');
    expect((await sql.query('select count(*)::int n from runtime_executions where actor_id=$1 and session_id=$2 and request_id=$3', [f.actor, work.sessionId, pendingVideo.followup.requestId])).rows[0].n).toBe(0);
    expect((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1 and request_id=$2', [f.actor, pendingVideo.followup.requestId])).rows[0].n).toBe(0);
    const content = (await f.service.library({ search: '绑定检查已改', from: null, to: null })).businesses
      .flatMap((business: {accounts: Array<{items: Array<{workItemId: string;content: Array<{id: string;kind: string}>}>}>}) => business.accounts.flatMap(account => account.items))
      .find((item: {workItemId: string}) => item.workItemId === work.workItemId).content;
    const [sourceScript] = content.filter((entry: {kind: string}) => entry.kind === 'script');
    expect(sourceScript).toBeDefined();
    expect(content.filter((entry: {kind: string}) => entry.kind === 'storyboard' || entry.kind === 'editing')).toHaveLength(0);
    await page.reload();
    const retry = page.getByRole('button', { name: '先做分镜，再生成剪辑建议', exact: true });
    await retry.waitFor(); await retry.click();
    // The raced request is definitely rejected before admission. A later explicit
    // choice may bind a new frozen material snapshot to the same exact final
    // script; changing the library title does not create a new script version.
    await page.getByRole('heading', { name: '分镜 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('heading', { name: '剪辑建议 · 第 1 版 · 已定稿 · 匹配当前口播稿', exact: true }).waitFor({ timeout: 60000 });
    const packageStates = (await sql.query("select state from runtime_executions where actor_id=$1 and session_id=$2 and payload->>'input' like '[OPC_VIDEO_PACKAGE_V1]%' order by created_at", [f.actor, work.sessionId])).rows.map(row => row.state);
    expect(packageStates).toEqual(['completed']);
  } finally { releasePrepare?.(); await browser.close(); }
}, 240000);

it.each([[2, "same"], [2, "draft"], [2, "published"], [3, "published"]] as const)("OPC: old v%i executed lost reply restores its original source across revision %s", async (version, revise) => {
  const f = await completed(3);
  await planFixtureModel(f.moduleId);
  const envelope = planEnvelopeFor(f);
  const { browser, page, key } = await planBrowser(f, { envelope });
  try {
    let resultLost = 0;
    await page.route('**/api/trpc/opc.planResult*', async route => { await route.fetch(); await route.abort(); resultLost += 1; });
    await page.reload();
    await page.getByText('这次生成的结果暂时无法确认').waitFor();
    const identity = await planIdentityRows(f.actor);
    const counts = await planIdentity(f.actor, f.d.draftId);
    expect(counts.planExecutions).toBe(1);
    await expect.poll(() => resultLost, { timeout: 30000 }).toBeGreaterThan(0);
    await page.unroute('**/api/trpc/opc.planResult*');
    if (revise !== "same") {
      const revised = await f.service.revise(f.d.draftId, randomUUID(), f.d.roundId);
      const snap = await f.artifacts.read(f.d.projectId, revised.roundId);
      if (revise === 'published') await f.artifacts.execute({ action: 'publish', projectId: f.d.projectId, roundId: revised.roundId,
        requestId: randomUUID(), expectedSteps: Object.fromEntries(Object.entries(snap.steps).map(([id, st]) => [id, { version: st.version, reviewVersion: st.reviewVersion }])) });
      expect((await f.service.read(f.d.draftId)).roundId).not.toBe(f.d.roundId);
    }
    await page.evaluate(({ key, id, version }) => {
      const old = JSON.parse(sessionStorage.getItem(key)!);
      old.v = version; if (version === 2) delete old.consentedAt;
      sessionStorage.setItem(key, JSON.stringify(old));
      sessionStorage.removeItem('opc-edit:' + id);
    }, { key, id: f.d.draftId, version });
    await page.reload();
    await page.getByRole('heading', { name: '本机保留了一条早先的生成请求', exact: true }).waitFor();
    await expect.poll(async () => (await page.getByRole('status').allTextContents()).join(' ')).toContain('服务端已保存这条请求的完成结果');
    expect(await planIdentityRows(f.actor)).toEqual(identity);
    await page.getByRole('button', { name: '继续这条原请求', exact: true }).click();
    await page.getByRole('heading', { name: revise !== "same" ? '原定位轮次的计划结果 · 已恢复' : CANDIDATE_HEADING, exact: true }).waitFor();
    expect(await planIdentityRows(f.actor)).toEqual(identity);
    expect(await planIdentity(f.actor, f.d.draftId)).toEqual(counts);
    expect((await topicIdentity(f.actor)).binds).toBe(0);
    const stored = JSON.parse((await page.evaluate(k => sessionStorage.getItem(k), key))!);
    expect(stored.request).toEqual(envelope.request);
    expect(stored.sourceRoundId).toBe(f.d.roundId);
    const executionId = (await f.service.planRequestState(f.d.draftId, envelope.request.requestId)).executionId;
    const result = await f.service.planResult(f.d.draftId, executionId);
    expect(result.sourceVersionId).toBe(f.sourceVersionId);
    expect(result.sourceRoundId).toBe(f.d.roundId);
    const other = await fixture(3);
    await expect(other.service.planResult(f.d.draftId, executionId)).rejects.toThrow('OPC_RESULT_DENIED');
    if (revise !== "same") {
      await page.reload();
      await page.getByRole('heading', { name: '原定位轮次的计划结果 · 已恢复', exact: true }).waitFor();
      expect(await planIdentityRows(f.actor)).toEqual(identity);
      expect(await page.getByRole('button', { name: '采用候选到计划工作稿', exact: true }).count()).toBe(0);
    }
    if (revise === 'published' && version === 2) {
      const { readFile } = await import('node:fs/promises');
      await sql.query(await readFile(new URL('../../../../db/migrations/0115_opc_historical_plan_result.sql', import.meta.url), 'utf8'));
      expect((await f.service.planResult(f.d.draftId, executionId)).sourceVersionId).toBe(f.sourceVersionId);
      const privileges = (await sql.query("select has_function_privilege('authenticated','opc_plan_result(uuid,uuid,uuid)','execute') client, has_function_privilege('service_role','opc_plan_result(uuid,uuid,uuid)','execute') server")).rows[0];
      expect(privileges).toEqual({ client: false, server: true });
      await sql.query('update bill2_drafts set revoked=true where id=$1', [f.d.draftId]);
      await expect(f.service.planResult(f.d.draftId, executionId)).rejects.toThrow('OPC_RESULT_DENIED');
    }
  } finally { await browser.close(); }
}, 300000);

it("OPC: two topic pages explicitly consent concurrently and execute one first turn", async () => {
  const f = await publishedDraft();
  const modelId = await planFixtureModel(f.moduleId);
  const { browser, context, page } = await planBrowser(f);
  const path = '/positioning/' + f.d.draftId + '/topics';
  const tab = await context.newPage();
  try {
    await Promise.all([page.goto(process.env.V3_LOCAL_APP + path), tab.goto(process.env.V3_LOCAL_APP + path)]);
    const buttons = [page, tab].map(p => p.getByRole('button', { name: '开始选题工作对话', exact: true }));
    await Promise.all(buttons.map(b => b.waitFor()));
    expect((await topicIdentity(f.actor)).binds).toBe(0);
    await Promise.all(buttons.map(b => b.click()));
    await Promise.all([page, tab].map(p => p.getByRole('button', { name: '采用所选并保存到资料库', exact: true }).waitFor()));
    expect(await topicIdentity(f.actor)).toEqual({ binds: 1, turns: 1, topicExecutions: 1, topicRuns: 1, reserves: 1 });
    const opening = (await f.service.topicRead(f.d.draftId)).opening;
    const run = (await sql.query('select request_id::text, payload, state from runtime_executions where actor_id=$1', [f.actor])).rows;
    expect(run).toHaveLength(1);
    expect(run[0].request_id).toBe(opening.requestId);
    expect(run[0].state).toBe('completed');
    const privileges = (await sql.query("select has_function_privilege('authenticated','opc_topic_consent(uuid,uuid,uuid)','execute') client, has_function_privilege('service_role','opc_topic_consent(uuid,uuid,uuid)','execute') server, has_table_privilege('authenticated','opc_topic_openings','select') records")).rows[0];
    expect(privileges).toEqual({ client: false, server: true, records: false });
    await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + '/topic-conversation.png', fullPage: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT + '/opc-acceptance.json', JSON.stringify({
      url: process.env.V3_LOCAL_APP + path, actor: f.actor,
      credentials: { email: f.email, password: f.password }, sessionId: (await f.service.topicRead(f.d.draftId)).sessionId,
      moduleId: f.moduleId, modelId, mode: 'Synthetic topic fixture only; no real model, research, payment or external account creation',
    }), { mode: 0o600 });
  } finally { await browser.close(); }
}, 180000);


it("OPC: topic invalid messages and legacy invalid pending records remain recoverable without dispatch", async () => {
  const f = await publishedDraft();
  await planFixtureModel(f.moduleId);
  const { browser, page } = await planBrowser(f);
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/positioning/' + f.d.draftId + '/topics');
    await page.getByRole('button', { name: '开始选题工作对话', exact: true }).click();
    await page.getByRole('button', { name: '采用所选并保存到资料库', exact: true }).waitFor();
    const workspace = await f.service.topicRead(f.d.draftId);
    const key = 'opc-topic-operation:' + workspace.sessionId;
    const identity = await topicIdentity(f.actor);
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('a'.repeat(8001));
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await page.getByRole('alert').allTextContents()).join(' ')).toContain('1–8000');
    expect(await topicIdentity(f.actor)).toEqual(identity);
    expect(await input.isEnabled()).toBe(true);
    // A record frozen by the earlier UI before its schema rejection is equally
    // provable invalid; release it without dispatch while retaining the edit.
    const invalidId = randomUUID();
    await page.evaluate(({ key, id, requestId, sourceVersionId }) => {
      const candidate = JSON.parse(localStorage.getItem('opc-topic-candidate:' + id)!);
      localStorage.setItem(key, JSON.stringify({ kind: 'save', request: {
        draftId: candidate.body.length ? location.pathname.split('/')[2] : '', requestId,
        expectedVersion: 0, sourceVersionId, body: candidate.body.map((row: object) => ({ ...row, title: '' })),
      } }));
    }, { key, id: workspace.sessionId, requestId: invalidId, sourceVersionId: workspace.sourceVersionId });
    await page.reload();
    await page.getByRole('button', { name: '恢复原请求', exact: true }).click();
    await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key), { timeout: 30000 }).toBeNull();
    expect(await page.evaluate(k => localStorage.getItem(k), key + ':invalid:' + invalidId)).not.toBeNull();
    await page.getByRole('button', { name: '采用所选并保存到资料库', exact: true }).waitFor();
    expect((await f.service.topicDraftRead(f.d.draftId)).version).toBe(1);
    expect(await topicIdentity(f.actor)).toEqual(identity);
    await input.fill('请修改第一条选题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await topicIdentity(f.actor)).topicExecutions, { timeout: 30000 }).toBe(2);
  } finally { await browser.close(); }
}, 300000);

it.each([false, true])("OPC: mentor history preserves a saved empty edit after refresh across revision %s", async (reviseRound) => {
  const f = await fixture(1);
  await planFixtureModel(f.moduleId);
  const d = await f.service.start({ requestId: randomUUID(), registration: f.registration, mode: 'mentor' });
  const { browser, page } = await planBrowser({ ...f, d });
  const path = '/positioning/' + d.draftId;
  const read = () => f.service.read(d.draftId);
  const title = f.flow.steps[0].information![0].title;
  const reply = '我想帮助刚接触短视频的人';
  try {
    await page.goto(process.env.V3_LOCAL_APP + path);
    await page.getByRole('log', { name: '完整导师消息' }).getByText('导师主动引导 · 1.1', { exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: '给导师的回复', exact: true });
    await expect.poll(() => input.isEnabled(), { timeout: 30000 }).toBe(true);
    await input.fill(reply);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await read()).information['step-0'].values?.goal?.value, { timeout: 30000 }).toBe(reply);
    await expect.poll(() => input.inputValue(), { timeout: 30000 }).toBe('');
    const oldIdentity = await planIdentityRows(f.actor);
    if (reviseRound) {
      // Publish/revise via the real business operations, then clear the
      // inherited field through the actual page in the new round.
      let state = (await read()).snapshot.steps['step-0'];
      await f.artifacts.execute({ action: 'save', projectId: d.projectId, roundId: d.roundId,
        requestId: randomUUID(), stepId: 'step-0', expectedVersion: state.version, body: 'Owner confirmed positioning for recovery test', evidenceIds: [] });
      state = (await read()).snapshot.steps['step-0'];
      await f.service.information({ draftId: d.draftId, stepId: 'step-0', requestId: randomUUID(), expectedVersion: state.version,
        values: { goal: { status: 'confirmed', nature: 'decision', value: reply } } });
      state = (await read()).snapshot.steps['step-0'];
      await f.artifacts.execute({ action: 'confirm', projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(),
        stepId: 'step-0', expectedVersion: state.version, expectedReviewVersion: state.reviewVersion });
      state = (await read()).snapshot.steps['step-0'];
      await f.artifacts.execute({ action: 'publish', projectId: d.projectId, roundId: d.roundId, requestId: randomUUID(),
        expectedSteps: { 'step-0': { version: state.version, reviewVersion: state.reviewVersion } } });
      await f.service.revise(d.draftId, randomUUID(), d.roundId);
      await page.reload();
    }
    const field = page.getByRole('textbox', { name: title, exact: true });
    await expect.poll(() => field.inputValue(), { timeout: 30000 }).toBe(reply);
    const beforeClear = (await read()).snapshot.steps['step-0'].version;
    await field.fill('');
    await expect.poll(async () => {
      const saved = await read();
      return [saved.snapshot.steps['step-0'].version, saved.information['step-0'].values.goal.value];
    }, { timeout: 30000 }).toEqual([beforeClear + 1, '']);
    if (reviseRound) await expect.poll(async () => (await read()).turns.filter((t: { roundId: string; kind: string }) => t.roundId !== d.roundId && t.kind === 'opening').length, { timeout: 30000 }).toBe(1);
    await page.reload();
    await page.getByRole('log', { name: '完整导师消息' }).getByText(reply, { exact: true }).waitFor();
    await page.getByRole('button', { name: '重新读取状态', exact: true }).click();
    await expect.poll(() => field.inputValue(), { timeout: 30000 }).toBe('');
    // Wait through the page's autosave interval after history hydration. This
    // would allow the old reply to silently refill and persist the field.
    await page.waitForTimeout(1500);
    const after = await read();
    expect(after.information['step-0'].values.goal.value).toBe('');
    expect(after.snapshot.steps['step-0'].version).toBe(beforeClear + 1);
    expect((await planIdentityRows(f.actor)).filter(row => oldIdentity.includes(row))).toEqual(oldIdentity);
    if (!reviseRound) expect(await planIdentityRows(f.actor)).toEqual(oldIdentity);
    expect(after.turns.find((t: { kind: string }) =>
      ["mentor", "organizer"].includes(t.kind))?.informationVersion).toBe(0);
    const { readFile } = await import('node:fs/promises');
    await sql.query(await readFile(new URL('../../../../db/migrations/0116_opc_mentor_projection_basis.sql', import.meta.url), 'utf8'));
    expect((await read()).turns).toEqual(after.turns);
    const other = await fixture(1);
    await expect(other.service.read(d.draftId)).rejects.toThrow('OPC_DENIED');
  } finally { await browser.close(); }
}, 240000);

it("OPC: mentor lost reply still projects once from its unchanged frozen information basis", async () => {
  const f = await fixture(1);
  await planFixtureModel(f.moduleId);
  const d = await f.service.start({ requestId: randomUUID(), registration: f.registration, mode: 'mentor' });
  const { browser, page } = await planBrowser({ ...f, d });
  const reply = '我想帮助刚接触短视频的人';
  let lost = 0;
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/positioning/' + d.draftId);
    await page.getByRole('log', { name: '完整导师消息' }).getByText('导师主动引导 · 1.1', { exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: '给导师的回复', exact: true });
    await expect.poll(() => input.isEnabled(), { timeout: 30000 }).toBe(true);
    await page.route('**/api/trpc/runtime.view*', route => route.abort());
    await page.route('**/api/trpc/runtime.execute*', async route => {
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort(); lost += 1;
    });
    await input.fill(reply);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => lost, { timeout: 30000 }).toBe(1);
    const identity = await planIdentityRows(f.actor);
    expect(identity).toHaveLength(2);
    expect((await f.service.read(d.draftId)).information['step-0'].values?.goal?.value ?? '').toBe('');
    await page.unroute('**/api/trpc/runtime.execute*');
    await page.unroute('**/api/trpc/runtime.view*');
    await page.reload();
    await page.getByRole('button', { name: '继续核对这条原请求', exact: true }).click();
    await expect.poll(async () => (await f.service.read(d.draftId)).information['step-0'].values?.goal?.value, { timeout: 30000 }).toBe(reply);
    await expect.poll(() => page.evaluate(id => sessionStorage.getItem('opc-step:' + id + ':step-0'), d.draftId), { timeout: 30000 }).toBeNull();
    const savedVersion = (await f.service.read(d.draftId)).snapshot.steps['step-0'].version;
    await page.reload();
    await expect.poll(() => page.getByRole('textbox', { name: f.flow.steps[0].information![0].title, exact: true }).inputValue(), { timeout: 30000 }).toBe(reply);
    expect((await f.service.read(d.draftId)).snapshot.steps['step-0'].version).toBe(savedVersion);
    expect(await planIdentityRows(f.actor)).toEqual(identity);
  } finally { await browser.close(); }
}, 240000);

it.skipIf(process.env.V3_VERIFY_DELIVERED_PREVIEW !== 'true')("OPC: delivered preview completes the default entry and content journey after curation", async () => {
  const {readFileSync,writeFileSync}=await import('node:fs');
  const saved=JSON.parse(readFileSync(process.env.V3_WORKBENCH_OUTPUT+'/opc-acceptance.json','utf8'));
  const {chromium}=await import('../../../../../apps/web/node_modules/@playwright/test');
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext();
  await context.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(60000);
  try {
    await page.goto(process.env.V3_LOCAL_APP+'/login?redirect=/positioning');
    await page.getByPlaceholder('name@example.com').fill(saved.credentials.email);
    await page.getByPlaceholder('输入你的密码').fill(saved.credentials.password);
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    await page.waitForURL(url=>url.pathname==='/positioning');
    await page.getByRole('heading',{name:'开始经营你的账号',exact:true}).waitFor();
    await page.getByRole('button',{name:'为另一个产品、服务或品牌开始定位',exact:true}).click();
    await page.getByLabel('业务名称',{exact:true}).fill('摄影课程 · 新手体验');
    await page.getByRole('button',{name:'我从零开始 · Agent 引导',exact:true}).click();
    await page.waitForURL(url=>/^\/positioning\/[0-9a-f-]+$/.test(url.pathname));
    const mentorUrl=page.url();
    await page.getByRole('log',{name:'完整导师消息'}).getByText('导师主动引导 · 1.1',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'给导师的回复',exact:true}).fill('我帮助初学摄影的创作者，通过每周一次手机拍摄练习建立作品集。');
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>page.getByRole('textbox',{name:'已知目标 0',exact:true}).inputValue(),{timeout:60000}).toContain('摄影');
    await page.reload();
    await expect.poll(()=>page.getByRole('textbox',{name:'已知目标 0',exact:true}).inputValue(),{timeout:60000}).toContain('摄影');
    await page.goto(process.env.V3_LOCAL_APP+'/positioning');
    await page.getByRole('link',{name:'摄影课程 · 新手体验 · 继续定位',exact:true}).waitFor();
    await page.getByRole('button',{name:'为另一个产品、服务或品牌开始定位',exact:true}).click();
    await page.getByLabel('业务名称',{exact:true}).fill('创作者咨询 · 完整体验');
    await page.getByRole('button',{name:'我已有定位 · 结构化录入',exact:true}).click();
    await page.waitForURL(url=>/^\/positioning\/[0-9a-f-]+$/.test(url.pathname));
    const positioningUrl=page.url();
    const flow=(await sql.query('select workflow from artifact_workflows where module_id=$1',[saved.moduleId])).rows[0].workflow;
    for(const step of flow.steps){
      for(const field of step.information){
        const article=page.locator('article').filter({has:page.getByRole('textbox',{name:field.title,exact:true})});
        await article.getByRole('textbox',{name:field.title,exact:true}).fill('为初创咨询业务提供每周一次真实案例分享，帮助独立创作者验证服务需求。');
        await article.getByText('已自动保存',{exact:true}).waitFor();
        await article.getByRole('button',{name:'确认本题并继续',exact:true}).click();
      }
    }
    await page.getByRole('button',{name:'确认正式定位',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'继续生成第一周选题',exact:true}).click();
    await page.getByLabel('选择 第二个账号选题').uncheck();
    await page.getByRole('button',{name:'采用所选并保存到资料库',exact:true}).click();
    await page.getByRole('button',{name:/展开选题/}).waitFor();
    expect(await page.getByRole('button',{name:'采用所选并保存到资料库',exact:true}).isVisible()).toBe(false);
    await page.reload();
    await page.getByRole('button',{name:/展开选题/}).waitFor();
    expect(await page.getByRole('button',{name:'采用所选并保存到资料库',exact:true}).isVisible()).toBe(false);
    await page.getByRole('link',{name:'打开内容资料库',exact:true}).click();
    const business=page.locator('section').filter({has:page.getByRole('heading',{name:'创作者咨询 · 完整体验',exact:true})});
    await business.getByRole('link',{name:'继续工作',exact:true}).click();
    await page.getByRole('button',{name:'起草口播稿',exact:true}).click();
    await page.getByRole('button',{name:'将这条回复定稿为口播稿',exact:true}).click();
    await page.getByRole('heading',{name:'口播稿已定稿。要先制作分镜脚本吗？',exact:true}).waitFor();
    await page.getByRole('button',{name:'暂时结束',exact:true}).click();
    const contentUrl=page.url();
    await page.goto(process.env.V3_LOCAL_APP+'/library');
    await page.getByLabel('查找资料').fill('首周选题');
    await page.locator('section').filter({has:page.getByRole('heading',{name:'创作者咨询 · 完整体验',exact:true})}).getByRole('link',{name:'继续工作',exact:true}).click();
    await page.getByRole('heading',{name:'口播稿 · 第 1 版 · 已定稿',exact:true}).waitFor();
    expect(page.url()).toBe(contentUrl);
    await page.screenshot({path:process.env.V3_WORKBENCH_OUTPUT+'/default-content-journey.png',fullPage:true});
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT+'/default-journey.json',JSON.stringify({mentorUrl,positioningUrl,contentUrl,entry:process.env.V3_LOCAL_APP+'/positioning',mode:'synthetic only; all journey mutations through visible default UI'},null,2));
  }finally{await browser.close();}
},360000);

it("OPC: entry projection stays actor-owned and repeatable without granting table access", async()=>{
  const a=await publishedDraft(),b=await publishedDraft();
  const before=await a.service.list();
  expect(before.drafts.map((d:{draftId:string})=>d.draftId)).toContain(a.d.draftId);
  expect(before.drafts.map((d:{draftId:string})=>d.draftId)).not.toContain(b.d.draftId);
  expect(before.drafts.find((d:{draftId:string})=>d.draftId===a.d.draftId)).toMatchObject({state:'published',currentVersion:1});
  const {readFileSync}=await import('node:fs');
  await sql.query(readFileSync('../../packages/db/migrations/0120_opc_entry_projection.sql','utf8'));
  expect(await a.service.list()).toEqual(before);
  const privileges=(await sql.query("select has_function_privilege('authenticated','opc_query(uuid,uuid)','execute') client,has_table_privilege('service_role','opc_businesses','select') business_table,has_function_privilege('service_role','opc_query_before_entry_projection(uuid,uuid)','execute') predecessor")).rows[0];
  expect(privileges).toEqual({client:false,business_table:false,predecessor:false});
},60000);

it('OPC: rejected cross-business adoption recovers its original request and permits corrected account adoption', async()=>{
 const f=await publishedDraft();await planFixtureModel(f.moduleId);
 const seed=await f.service.savePlan({draftId:f.d.draftId,requestId:randomUUID(),expectedVersion:0,sourceVersionId:f.sourceVersionId,body:[{id:randomUUID(),platform:'x',account:'existing-account',title:'另一业务原工作',brief:'必须保留',day:'2026-09-20'}]});
 const [original]=await f.service.handoff({draftId:f.d.draftId,requestId:randomUUID(),planId:seed.planId,accounts:[{platform:'x',account:'existing-account',expectedRevision:null}]});
 const other=(await sql.query("insert into opc_businesses(actor_id,name) values($1,'另一业务') returning id",[f.actor])).rows[0].id;
 await sql.query('update opc_accounts set business_id=$1 where project_id=$2',[other,original.projectId]);
 const {browser,page}=await planBrowser(f);
 try{
  await page.goto(process.env.V3_LOCAL_APP+'/positioning/'+f.d.draftId+'/topics');
  await page.getByRole('button',{name:'开始选题工作对话',exact:true}).click();
  await page.getByLabel('选择 第二个账号选题').uncheck();
  // Simulate the old client's unknown outcome; do not hand-edit or delete pending state.
  await page.route('**/api/trpc/opc.adoptTopics*',async route=>{await route.fetch();await route.abort();});
  await page.getByRole('button',{name:'采用所选并保存到资料库',exact:true}).click();
  await page.getByRole('button',{name:'恢复原请求',exact:true}).waitFor();
  await expect.poll(()=>page.getByRole('button',{name:'恢复原请求',exact:true}).isEnabled()).toBe(true);
  const workspace=await f.service.topicRead(f.d.draftId),key='opc-topic-operation:'+workspace.sessionId;
  const frozen=await page.evaluate(key=>localStorage.getItem(key),key);
  await page.unroute('**/api/trpc/opc.adoptTopics*');
  await page.getByRole('button',{name:'恢复原请求',exact:true}).click();
  await page.getByText('这个账号已属于另一项业务，本次没有采用。请展开选题，修改为当前业务的账号后再采用；原请求已保留。',{exact:true}).waitFor();
  expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBeNull();
  expect(await page.evaluate(key=>localStorage.getItem(key),key+':rejected:'+JSON.parse(frozen!).request.requestId)).toBe(frozen);
  await page.getByText('修改平台或账号',{exact:true}).first().click();
  await page.getByLabel('账号 首周选题',{exact:true}).fill('photography-account');
  await page.reload();
  await page.getByText('修改平台或账号',{exact:true}).first().click();
  expect(await page.getByLabel('账号 首周选题',{exact:true}).inputValue()).toBe('photography-account');
  await page.getByLabel('选择 第二个账号选题').uncheck();
  await page.getByRole('button',{name:'采用所选并保存到资料库',exact:true}).click();
  await page.getByRole('button',{name:/展开选题/}).waitFor();
  expect((await sql.query('select business_id from opc_accounts where project_id=$1',[original.projectId])).rows[0].business_id).toBe(other);
  const plans=(await f.service.read(f.d.draftId)).plans;
  expect(plans[0].body).toHaveLength(1);expect(plans[0].body[0].account).toBe('photography-account');
  await page.getByRole('link',{name:'打开内容资料库',exact:true}).click();
  await page.getByRole('heading',{name:'x · photography-account',exact:true}).waitFor();
 }finally{await browser.close();}
},180000);
