/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parsePreviewOptions, previewNames, readPreviewState, runPreviewPhase, signPreviewJwt, writePreviewState } from "./preview-lifecycle.mjs";
import { acquirePreviewLease, assertNewPreview, assertPreviewResources, controlPreview, inspectPreviewResource, stopLocalApplication } from "./preview-resources.mjs";

function setup(t) {
  const root = mkdtempSync(resolve(tmpdir(), "preview-resources-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { V3_PREVIEW_STATE_ROOT: resolve(root, "state") };
  const state = { version: 1, id: "owner422", ownerId: randomUUID(), initialized: true, secret: "synthetic-local-test-".repeat(4), structuralArgs: ["--opc-only"], names: previewNames("owner422"), ports: { app: 32001, gateway: 32002 } };
  return { root, env, state };
}
function options(action) {
  return parsePreviewOptions(["--serve", "--preview-id=owner422", `--preview-action=${action}`, ...(action === "destroy" ? ["--confirm-destroy=owner422"] : [])]);
}
function fakeDocker(state) {
  const { names } = state;
  const objects = new Map();
  for (const [kind, name] of [["container", names.auth], ["container", names.rest], ["container", names.db], ["network", names.tag], ["volume", names.volume]]) {
    const labels = { "io.graylum.workbench-preview": state.ownerId };
    objects.set(name, kind === "container" ? { Config: { Labels: labels, Env: [`PGRST_JWT_SECRET=${state.secret}`, `GOTRUE_JWT_SECRET=${state.secret}`] }, HostConfig: { PortBindings: { port: [{ HostIp: "127.0.0.1" }] } }, NetworkSettings: { Networks: { [names.tag]: {} } }, Mounts: [{ Type: "volume", Name: names.volume, Destination: "/var/lib/postgresql/data" }] } : { Labels: labels });
  }
  const mutations = [];
  const docker = (...args) => {
    if (args[1] === "inspect") {
      const item = objects.get(args[2]);
      if (!item) throw Object.assign(new Error("missing"), { stderr: "No such object: " + args[2] });
      return JSON.stringify([item]);
    }
    mutations.push(args);
    return "ok";
  };
  return { docker, objects, mutations };
}

test("start alone invokes bootstrap/tests; resume/restart/renew/stop/destroy cannot recreate business state", async () => {
  for (const action of ["start", "resume", "restart", "renew", "stop", "destroy"]) {
    const calls = [];
    for (const phase of ["bootstrap", "runTests", "destroyBackendsOnFinally"]) await runPreviewPhase(options(action), phase, () => calls.push(phase));
    assert.deepEqual(calls, action === "start" ? ["bootstrap", "runTests"] : []);
  }
});

test("normal exit/crash/signals have no persistent destructive finally; disposable retains teardown", async () => {
  for (const cause of ["normal exit", "app crash", "SIGINT", "SIGTERM"]) {
    const calls = [];
    try { throw new Error(cause); }
    catch { /* The runner ends serving, not its database lifetime. */ }
    finally { await runPreviewPhase(options("start"), "destroyBackendsOnFinally", () => calls.push("remove")); }
    assert.deepEqual(calls, []);
  }
  let cleaned = false;
  await runPreviewPhase(parsePreviewOptions(["--opc-only"]), "destroyBackendsOnFinally", () => { cleaned = true; });
  assert.equal(cleaned, true);
});

test("stop touches only the three owned containers, preserves signing state and volume", (t) => {
  const { env, state } = setup(t); writePreviewState(state, env);
  const fake = fakeDocker(state);
  controlPreview(options("stop"), state, fake.docker, env);
  assert.deepEqual(fake.mutations, [state.names.auth, state.names.rest, state.names.db].map((name) => ["stop", "--time", "10", name]));
  assert.deepEqual(readPreviewState(state.id, env), state);
});

test("destroy requires matching explicit confirmation and removes only this preview", (t) => {
  const { env, state } = setup(t); writePreviewState(state, env);
  const fake = fakeDocker(state);
  assert.throws(() => controlPreview({ ...options("destroy"), confirmDestroy: "other" }, state, fake.docker, env), /CONTROL_DENIED/);
  assert.equal(fake.mutations.length, 0);
  controlPreview(options("destroy"), state, fake.docker, env);
  assert.deepEqual(fake.mutations, [["rm", "-f", state.names.auth], ["rm", "-f", state.names.rest], ["rm", "-f", state.names.db], ["network", "rm", state.names.tag], ["volume", "rm", state.names.volume]]);
  assert.throws(() => readPreviewState(state.id, env), /NOT_FOUND/);
});

test("ownership, mount, signing-secret and loopback mismatches deny BEFORE any mutation", (t) => {
  const { env, state } = setup(t);
  for (const corrupt of [
    (fake) => { fake.objects.get(state.names.volume).Labels = {}; },
    (fake) => { fake.objects.get(state.names.db).Mounts[0].Name = "unrelated-evidence-volume"; },
    (fake) => { fake.objects.get(state.names.auth).Config.Env = []; },
    (fake) => { fake.objects.get(state.names.rest).HostConfig.PortBindings.port[0].HostIp = "0.0.0.0"; },
  ]) {
    const fake = fakeDocker(state); corrupt(fake);
    assert.throws(() => controlPreview(options("destroy"), state, fake.docker, env), /PREVIEW_/);
    assert.equal(fake.mutations.length, 0);
  }
});

test("missing objects may be destroyed idempotently, but daemon failures never mean absent", (t) => {
  const { env, state } = setup(t); writePreviewState(state, env);
  const fake = fakeDocker(state); fake.objects.delete(state.names.rest);
  assert.throws(() => assertPreviewResources(state, fake.docker), /MISSING/);
  controlPreview(options("destroy"), state, fake.docker, env);
  assert.equal(fake.mutations.some((args) => args.includes(state.names.rest)), false);
  const broken = () => { throw Object.assign(new Error("daemon offline"), { stderr: "Cannot connect to Docker daemon" }); };
  assert.throws(() => controlPreview(options("stop"), state, broken, env), /INSPECT_FAILED/);
});

test("Docker's missing network/volume diagnostics are absent, not daemon failures", () => {
  for (const kind of ["network", "volume"]) {
    const docker = () => { throw Object.assign(new Error("missing"), { stderr: `${kind} graylum-preview-unit not found` }); };
    assert.equal(inspectPreviewResource(docker, kind, "graylum-preview-unit"), null);
  }
});

test("start rejects both persisted state and resource-name collisions", (t) => {
  const { env, state } = setup(t);
  writePreviewState(state, env);
  assert.throws(() => assertNewPreview(state.id, env), /ALREADY_EXISTS/);
  assert.throws(() => assertPreviewResources(state, fakeDocker(state).docker, { requireAll: false, mustBeAbsent: true }), /COLLISION/);
});

test("local lease prevents overlapping lifecycle commands, never targets a stored PID", (t) => {
  const { root, env } = setup(t);
  const external = mkdtempSync(resolve(tmpdir(), "preview-lease-test-")); t.after(() => rmSync(external, { recursive: true, force: true }));
  const local = { V3_PREVIEW_STATE_ROOT: external };
  const close = acquirePreviewLease("owner422", root, local);
  assert.throws(() => acquirePreviewLease("owner422", root, local), /PREVIEW_IN_USE/);
  close();
  acquirePreviewLease("owner422", root, local)();
  assert.throws(() => acquirePreviewLease("owner422", root, env), /OUTSIDE_REPOSITORY/);
});

test("atomic state writes keep signing material private and renew keeps all business identities", (t) => {
  const { env, state } = setup(t);
  state.business = { draftId: randomUUID(), sessionId: randomUUID(), billingRunIds: [randomUUID()] };
  const before = JSON.stringify(state);
  const path = writePreviewState(state, env);
  const saved = readPreviewState(state.id, env);
  const first = signPreviewJwt(saved.secret, "service_role", { nowSeconds: 10000 });
  const second = signPreviewJwt(saved.secret, "service_role", { nowSeconds: 10100 });
  assert.notEqual(first, second); assert.equal(JSON.stringify(saved), before);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").includes(first), false);
});

test("short JWTs reject invalid roles/TTL; wrong secret and expiration fail signature/time verification", () => {
  const secret = "synthetic-unit-secret-".repeat(4);
  const verify = (token, key, now) => {
    const [header, payload, signature] = token.split(".");
    const expected = createHmac("sha256", key).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected) && JSON.parse(Buffer.from(payload, "base64url")).exp > now;
  };
  const token = signPreviewJwt(secret, "anon", { nowSeconds: 10000 });
  assert.equal(verify(token, secret, 10001), true);
  assert.equal(verify(token, secret + "wrong", 10001), false);
  assert.equal(verify(token, secret, 17200), false);
  assert.throws(() => signPreviewJwt(secret, "admin"), /ROLE_INVALID/);
  assert.throws(() => signPreviewJwt(secret, "anon", { ttlSeconds: 2592000 }), /TTL_INVALID/);
  assert.throws(() => parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=", "--preview-action=destroy"]), /ARGUMENT_INVALID/);
});

test("real isolated child shutdown is awaited and repeated stop is harmless", async (t) => {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } });
  await once(child, "message");
  await stopLocalApplication(child);
  assert.notEqual(child.signalCode, null);
  await stopLocalApplication(child);
});

test("shipped runner wires the lifecycle gates, named mount and renewable signer", () => {
  const runner = readFileSync(new URL("./run-workbench.mjs", import.meta.url), "utf8");
  for (const phase of ["bootstrap", "runTests", "destroyBackendsOnFinally"]) assert.ok(runner.includes(`runPreviewPhase(previewOptions, "${phase}"`));
  assert.ok(runner.includes("source=${previewState.names.volume},target=/var/lib/postgresql/data"));
  assert.ok(runner.includes("signPreviewJwt(secret, role)"));
  assert.ok(runner.includes('docker("rm", "-f", "-v", n)'));
  assert.equal(runner.includes("2592000"), false);
  assert.equal(runner.includes('docker("volume", "rm"'), false);
  assert.equal(runner.includes('app.once(\'exit\',resolve)'), false);
});
