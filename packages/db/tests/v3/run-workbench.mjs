/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real local Auth + Next HTTP + PostgREST + disposable SQL, with a credential-free source copy.
import { installWorkbenchBilling } from "./billing-fixture.mjs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID, createHmac, createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
const source = resolve(import.meta.dirname, "../../../..");
const args = process.argv.slice(2);
if(args.some(arg=>!['--ai-only','--chat-only','--serve'].includes(arg))||new Set(args).size!==args.length||args.includes('--ai-only')&&args.includes('--chat-only'))throw new Error('use --ai-only or --chat-only, optionally --serve');
const serve=args.includes('--serve'),aiOnly=args.includes('--ai-only')||args.includes('--chat-only');
const testPattern=args.includes('--chat-only')?'^CHAT:':'^AI:';
const root = mkdtempSync(resolve(tmpdir(), "graylum-workbench-"));
const evidenceRoot = resolve(process.env.V3_WORKBENCH_OUTPUT || tmpdir());
mkdirSync(evidenceRoot, { recursive:true });
const evidenceDirectory = mkdtempSync(resolve(evidenceRoot, "graylum-workbench-evidence-"));
console.log("LOCAL_EVIDENCE_DIRECTORY " + evidenceDirectory);
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: source,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .filter((p) => !/(^|\/)\.env/.test(p));
const hash = createHash("sha256");
for (const p of files) {
  const data = readFileSync(resolve(source, p));
  hash.update(p).update(data);
  mkdirSync(dirname(resolve(root, p)), { recursive: true });
  copyFileSync(resolve(source, p), resolve(root, p));
}
console.log(
  "source",
  JSON.stringify({
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim(),
    treeDigest: hash.digest("hex"),
    isolatedRoot: root,
  }),
);
const tag = `graylum-wb-${randomUUID().slice(0, 8)}`,
  db = `${tag}-db`,
  rest = `${tag}-rest`,
  auth = `${tag}-auth`;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const secret = randomUUID() + randomUUID();
const jwt = (role) => {
  const a = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    b = Buffer.from(
      JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 7200 }),
    ).toString("base64url");
  return `${a}.${b}.${createHmac("sha256", secret).update(`${a}.${b}`).digest("base64url")}`;
};
const apply = (p) =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      db,
      "psql",
      "-U",
      "postgres",
      "-d",
      "v3_disposable",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: readFileSync(resolve(root, p)), stdio: ["pipe", "pipe", "pipe"] },
  );
const sql = (s) =>
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      db,
      "psql",
      "-U",
      "postgres",
      "-d",
      "v3_disposable",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: s, stdio: ["pipe", "pipe", "pipe"] },
  );
let gateway, app;
const appLog = [];
const cleanEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: "true",
  NEXT_TELEMETRY_DISABLED: "1",
};
const childExit = (child) =>
  new Promise((r, j) => {
    child.on("error", j);
    child.on("exit", (code) =>
      code === 0 ? r() : j(new Error(`child exit ${code}`)),
    );
  });
try {
  await childExit(
    spawn("pnpm", ["install", "--frozen-lockfile", "--offline"], {
      cwd: root,
      env: cleanEnv,
      stdio: "inherit",
    }),
  );
  docker("network", "create", tag);
  docker(
    "run",
    "-d",
    "--name",
    db,
    "--network",
    tag,
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_DB=v3_disposable",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:17-alpine",
  );
  for (let i = 0; i < 100; i++) {
    try {
      docker("exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  apply("packages/db/tests/v3/bootstrap.sql");
  sql(
    "CREATE ROLE workbench_auth LOGIN SUPERUSER; ALTER ROLE workbench_auth SET search_path=auth,public; CREATE TABLE system_settings(key text PRIMARY KEY,value jsonb); INSERT INTO system_settings VALUES ('maintenance_mode','false'); GRANT SELECT ON system_settings TO service_role,anon,authenticated;",
  );
  for (const p of [
    "0039_normalize_module_policy_shape.sql",
    "0062_skill_1a_db_publish_contract.sql",
    "0064_v3_private_skill_packages.sql",
    "0065_v3_research_operations.sql",
    "0066_v3_artifact_transactions.sql",
    "0067_v3_workbench_queries.sql",
  ])
    apply(`packages/db/migrations/${p}`);
  apply("packages/db/migrations/0067_v3_workbench_queries.sql");
  installWorkbenchBilling(sql, root);
  apply("packages/db/migrations/0068_v3_workbench_generation.sql");
  apply("packages/db/migrations/0068_v3_workbench_generation.sql");
  apply("packages/db/migrations/0069_v3_chat_skill.sql");
  apply("packages/db/migrations/0069_v3_chat_skill.sql");
  apply("packages/db/migrations/0070_v3_separate_summary.sql");
  apply("packages/db/migrations/0070_v3_separate_summary.sql");
  console.log("SQL additive migration and repeat application PASS");
  docker(
    "run",
    "-d",
    "--name",
    rest,
    "--network",
    tag,
    "-p",
    "127.0.0.1::3000",
    "-e",
    `PGRST_DB_URI=postgres://authenticator@${db}:5432/v3_disposable`,
    "-e",
    "PGRST_DB_SCHEMAS=public",
    "-e",
    "PGRST_DB_ANON_ROLE=anon",
    "-e",
    `PGRST_JWT_SECRET=${secret}`,
    "public.ecr.aws/supabase/postgrest:v14.13",
  );
  docker(
    "run",
    "-d",
    "--name",
    auth,
    "--network",
    tag,
    "-p",
    "127.0.0.1::9999",
    "-e",
    "GOTRUE_API_HOST=0.0.0.0",
    "-e",
    "PORT=9999",
    "-e",
    "GOTRUE_DB_DRIVER=postgres",
    "-e",
    `DATABASE_URL=postgres://workbench_auth@${db}:5432/v3_disposable?sslmode=disable`,
    "-e",
    "GOTRUE_SITE_URL=http://127.0.0.1",
    "-e",
    "API_EXTERNAL_URL=http://127.0.0.1",
    "-e",
    `GOTRUE_JWT_SECRET=${secret}`,
    "-e",
    "GOTRUE_JWT_AUD=authenticated",
    "-e",
    "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
    "-e",
    "GOTRUE_JWT_ADMIN_ROLES=service_role",
    "-e",
    "GOTRUE_EXTERNAL_EMAIL_ENABLED=true",
    "-e",
    "GOTRUE_MAILER_AUTOCONFIRM=false",
    "-e",
    "GOTRUE_DISABLE_SIGNUP=true",
    "public.ecr.aws/supabase/gotrue:v2.190.0",
  );
  const port = (n, p) => docker("port", n, p).split(":").at(-1);
  const restUrl = `http://127.0.0.1:${port(rest, "3000")}`,
    authUrl = `http://127.0.0.1:${port(auth, "9999")}`;
  for (const url of [restUrl, authUrl + "/health"]) {
    let ok = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(url)).ok) {
          ok = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ok) throw new Error("local service not ready");
  }
  let modelCalls = 0;
  gateway = createServer(async (req, res) => {
    if (req.url === '/__workbench_model_fixture') {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2097152) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (req.method !== 'POST' || body.tools?.length || body.plugins?.length || body.stream !== false) { res.writeHead(400).end(); return; }
      modelCalls++;
      await new Promise(r => setTimeout(r, 1500));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'Synthetic local HTTP candidate' } }],
        usage: { prompt_tokens: 800, completion_tokens: 30 },
      })); return;
    }
    if(req.url==='/__chat_model_fixture') {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const requestText=Buffer.concat(chunks).toString();
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('data: '+JSON.stringify({choices:[{delta:{content:'Synthetic local free/document reply'},finish_reason:null}],usage:{prompt_tokens:800,completion_tokens:30}})+'\n\n');
      if(requestText.includes('ORDINARY_ABORT')||requestText.includes('ORDINARY_ERROR')) {
        await new Promise(r=>setTimeout(r,1500));
        res.write('data: '+JSON.stringify({choices:[{delta:{content:' SECOND_DELTA_AFTER_INIT'},finish_reason:null}]})+'\n\n');
        await new Promise(r=>setTimeout(r,3500));
        if(requestText.includes('ORDINARY_ERROR')) {res.destroy();return;}
      }
      res.end('data: [DONE]\n\n');return;
    }
    if (req.url === '/__workbench_model_calls') { res.writeHead(200).end(JSON.stringify({ calls: modelCalls })); return; }

    const prefix = req.url?.startsWith("/rest/v1/")
      ? "/rest/v1"
      : req.url?.startsWith("/auth/v1/")
        ? "/auth/v1"
        : null;
    if (!prefix) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    try {
      const response = await fetch(
        (prefix === "/rest/v1" ? restUrl : authUrl) +
          req.url.slice(prefix.length),
        {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method)
            ? undefined
            : Buffer.concat(chunks),
          redirect: "error",
        },
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(502).end();
    }
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${gateway.address().port}`;
  // Only the disposable, credential-free source COPY receives this transport
  // substitution. Shipped code has no environment-controlled mock/provider URL.
  const generationPath = resolve(root, 'packages/api/src/services/artifacts/generation.ts');
  const productionSource = readFileSync(generationPath, 'utf8');
  const marker = "await fetch('https://openrouter.ai/api/v1/chat/completions',";
  if (productionSource.split(marker).length !== 2) throw new Error('local transport fixture source boundary changed');
  writeFileSync(generationPath, productionSource.replace(marker, `await fetch('${apiUrl}/__workbench_model_fixture',`));
  const streamPath=resolve(root,'apps/web/src/app/api/ai/stream/route.ts'),streamSource=readFileSync(streamPath,'utf8');
  if(streamSource.split('await fetch(endpoint,').length!==2)throw new Error('stream fixture boundary changed');
  writeFileSync(streamPath,streamSource.replace('await fetch(endpoint,',`await fetch('${apiUrl}/__chat_model_fixture',`));
  // Every fetch from the disposable Next process is constrained to loopback,
  // including optional routing helpers. No configured provider can be contacted.
  const networkGuard=resolve(root,'local-loopback-only.cjs');
  writeFileSync(networkGuard,`const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('LOCAL_ONLY_NETWORK');return original(input,init);};`);
  console.log('Model transport: synthetic loopback HTTP; non-loopback server fetch denied in disposable copy only');
  const service = jwt("service_role"),
    anon = jwt("anon");
  const listener = createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const appPort = listener.address().port;
  await new Promise((r) => listener.close(r));
  const env = {
    ...cleanEnv,
    NODE_ENV: "development",
    NODE_OPTIONS:`--require=${networkGuard}`,
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
    V3_LOCAL_DB: `postgres://postgres@127.0.0.1:${port(db, "5432")}/v3_disposable`,
    V3_LOCAL_REST: apiUrl,
    V3_LOCAL_SERVICE_JWT: service,
    V3_LOCAL_USER_JWT: jwt("authenticated"),
    V3_LOCAL_JWT_SECRET: secret,
    NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${appPort}`,
    NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${appPort}`,
    V3_LOCAL_APP: `http://127.0.0.1:${appPort}`,
    V3_WORKBENCH_OUTPUT:
      evidenceDirectory,
  };
  mkdirSync(env.V3_WORKBENCH_OUTPUT, { recursive: true });

  const startApp = () => {
    app = spawn(
      "pnpm",
      [
        "--filter",
        "web",
        "exec",
        "next",
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(appPort),
      ],
      { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const output of [app.stdout, app.stderr])
      output.on("data", (x) => {
        appLog.push(x.toString());
        writeFileSync(
          resolve(env.V3_WORKBENCH_OUTPUT, "app-progress.log"),
          appLog
            .join("")
            .replaceAll(secret, "[LOCAL_SECRET]")
            .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[LOCAL_TOKEN]"),
        );
      });
  };
  startApp();
  // Test process can request a real process restart through a local-only pipe protocol.
  const runTests = () =>
    spawn(
      "pnpm",
      [
        "--filter",
        "@repo/api",
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        "src/services/__tests__/workbench.integration.ts",
        "--reporter",
        "verbose",
        ...(aiOnly ? ["--testNamePattern", testPattern] : []),
      ],
      { cwd: root, env, stdio: "inherit" },
    );
  await childExit(runTests());
  if (!aiOnly) {
  process.kill(-app.pid, "SIGTERM");
  await new Promise((r) => app.on("exit", r));
  env.V3_WORKBENCH_PHASE = "restore";
  startApp();
  await childExit(runTests());
  }
  if (appLog.join("").includes("METHOD_CANARY"))
    throw new Error("private method leaked in application logs");
  writeFileSync(
    resolve(env.V3_WORKBENCH_OUTPUT, "app.log"),
    appLog
      .join("")
      .replaceAll(service, "[LOCAL_SERVICE]")
      .replaceAll(anon, "[LOCAL_ANON]"),
  );
  console.log("Private canary absent from application logs PASS");
  if(serve){
    const saved=JSON.parse(readFileSync(resolve(env.V3_WORKBENCH_OUTPUT,'restore.json'),'utf8'));
    const demoIds=saved.fixtures.map(f=>f.moduleId);
    if(![saved.actor,...demoIds].every(value=>/^[a-f0-9-]{36}$/.test(value)))throw new Error('invalid local acceptance identity');
    sql(`UPDATE modules SET model_id=(SELECT id FROM ai_models WHERE api_key='LOCAL_SYNTHETIC_KEY' LIMIT 1) WHERE id IN (${demoIds.map(value=>`'${value}'`).join(',')}); UPDATE profiles SET credits=100000 WHERE id='${saved.actor}';`);
    writeFileSync(resolve(env.V3_WORKBENCH_OUTPUT,'acceptance.json'),JSON.stringify({url:env.V3_LOCAL_APP,credentials:saved.credentials,samples:saved.fixtures.map(f=>({label:f.label,moduleId:f.moduleId})),mode:'Synthetic local transport only; no production or provider access'},null,2),{mode:0o600});
    console.log('LOCAL_ACCEPTANCE_READY '+env.V3_LOCAL_APP);
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);app.once('exit',resolve);});
  }
} catch (error) {
  // Diagnostics are local-only and redact all temporary JWT material.
  try {
    console.error(
      spawnSync("docker", ["logs", "--tail", "15", auth], { encoding: "utf8" })
        .output.filter(Boolean)
        .join("\n")
        .replaceAll(secret, "[LOCAL_SECRET]")
        .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[LOCAL_TOKEN]"),
    );
  } catch {}
  console.error(
    appLog
      .join("")
      .replaceAll(secret, "[LOCAL_SECRET]")
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[LOCAL_TOKEN]"),
  );
  console.error(
    String(error.stderr ?? error.message)
      .replaceAll(secret, "[LOCAL_SECRET]")
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[LOCAL_TOKEN]"),
  );
  process.exitCode = 1;
} finally {
  if (app) {
    try {
      process.kill(-app.pid, "SIGTERM");
    } catch {}
  }
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((r) => gateway.close(r));
  }
  for (const n of [auth, rest, db]) {
    try {
      docker("rm", "-f", n);
    } catch {}
  }
  try {
    docker("network", "rm", tag);
  } catch {}
  rmSync(
    resolve(
      evidenceDirectory,
      "restore.json",
    ),
    { force: true },
  );
  // Retain source copy only on request for explicit recovery; never original/user files.
  if (!process.env.V3_KEEP_LOCAL)
    rmSync(root, { recursive: true, force: true });
}
