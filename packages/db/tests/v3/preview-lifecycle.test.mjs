/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PREVIEW_TOKEN_TTL_SECONDS,
  parsePreviewOptions,
  previewDecision,
  previewNames,
  previewStatePath,
  readPreviewState,
  removePreviewState,
  signPreviewJwt,
  structuralPreviewArgs,
  validateResumeState,
  writePreviewState,
} from "./preview-lifecycle.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function testEnv() {
  const root = mkdtempSync(resolve(tmpdir(), "graylum-preview-state-test-"));
  roots.push(root);
  return { V3_PREVIEW_STATE_ROOT: root };
}
function state(id = "owner422") {
  return {
    version: 1,
    id,
    initialized: true,
    secret: "x".repeat(64),
    names: previewNames(id),
    structuralArgs: ["--opc-only"],
  };
}

test("disposable tests keep exact automatic destructive cleanup", () => {
  const decision = previewDecision(parsePreviewOptions(["--opc-only"]));
  assert.deepEqual(decision, {
    bootstrap: true,
    runTests: true,
    controlOnly: false,
    destroyBackendsOnFinally: true,
  });
});

test("persistent app exit/start/resume/renew/restart never share destructive finally cleanup", () => {
  for (const action of ["start", "resume", "renew", "restart"]) {
    const decision = previewDecision(
      parsePreviewOptions(["--serve", "--preview-id=owner422", `--preview-action=${action}`]),
    );
    assert.equal(decision.destroyBackendsOnFinally, false);
    assert.equal(decision.bootstrap, action === "start");
    assert.equal(decision.runTests, action === "start");
  }
});

test("stop is non-destructive and destroy is explicit and preview-scoped", () => {
  assert.equal(
    previewDecision(
      parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=stop"]),
    ).controlOnly,
    true,
  );
  assert.throws(
    () => parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=destroy"]),
    /confirm-destroy/,
  );
  const options = parsePreviewOptions([
    "--serve",
    "--preview-id=owner422",
    "--preview-action=destroy",
    "--confirm-destroy=owner422",
  ]);
  assert.equal(previewDecision(options).controlOnly, true);
  assert.equal(previewNames("owner422").volume, "graylum-preview-owner422-pgdata");
});

test("persistent signing state is 0600 and malformed signing material fails closed", () => {
  const env = testEnv();
  const path = writePreviewState(state(), env);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).secret, "x".repeat(64));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(validateResumeState(readPreviewState("owner422", env), ["--opc-only"]), state());
  assert.throws(() => validateResumeState(state(), ["--runtime-only"]), /ARGUMENT_MISMATCH/);
  const invalid = state();
  invalid.secret = "too-short";
  assert.throws(() => writePreviewState(invalid, env), /STATE_INVALID/);
  removePreviewState("owner422", env);
  assert.throws(() => readPreviewState("owner422", env), /NOT_FOUND/);
});

test("preview credentials stay short-lived and renew never bootstraps business data", () => {
  assert.equal(PREVIEW_TOKEN_TTL_SECONDS, 7200);
  const token = signPreviewJwt("x".repeat(64), "service_role", { nowSeconds: 1000 });
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(payload.exp, 8200);
  assert.throws(
    () => signPreviewJwt("x".repeat(64), "service_role", { nowSeconds: 1000, ttlSeconds: 7201 }),
    /TTL_INVALID/,
  );
  const renew = previewDecision(
    parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=renew"]),
  );
  assert.equal(renew.bootstrap, false);
  assert.equal(renew.runTests, false);
});

test("structural preview identity ignores lifecycle/case controls but preserves schema mode", () => {
  assert.deepEqual(
    structuralPreviewArgs([
      "--serve",
      "--preview-id=owner422",
      "--preview-action=resume",
      "--case-pattern=x",
      "--opc-only",
      "--with-staging-schema",
    ]),
    ["--opc-only", "--with-staging-schema"],
  );
  assert.equal(previewStatePath("owner422", testEnv()).evidence.endsWith("owner422-evidence"), true);
});
