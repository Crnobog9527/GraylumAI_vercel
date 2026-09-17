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
  readPreviewState,
  removePreviewState,
  signPreviewJwt,
  structuralPreviewArgs,
  validateResumeState,
  writePreviewState,
} from "./preview-lifecycle.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function testEnv() { const root = mkdtempSync(resolve(tmpdir(), "graylum-preview-state-test-")); roots.push(root); return { V3_PREVIEW_STATE_ROOT: root }; }

test("disposable tests keep automatic destructive backend cleanup", () => {
  const options = parsePreviewOptions(["--opc-only"]);
  assert.deepEqual(previewDecision(options), { bootstrap: true, runTests: true, controlOnly: false, destroyBackendsOnFinally: true });
});

test("persistent start/resume/renew/restart never share ordinary destructive cleanup", () => {
  for (const action of ["start", "resume", "renew", "restart"]) {
    const options = parsePreviewOptions(["--serve", "--preview-id=owner422", `--preview-action=${action}`]);
    const decision = previewDecision(options);
    assert.equal(decision.destroyBackendsOnFinally, false);
    assert.equal(decision.bootstrap, action === "start");
    assert.equal(decision.runTests, action === "start");
  }
});

test("stop is non-destructive and destroy is explicit and preview-scoped", () => {
  assert.equal(previewDecision(parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=stop"])).controlOnly, true);
  assert.throws(() => parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=destroy"]), /confirm-destroy/);
  const options = parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=destroy", "--confirm-destroy=owner422"]);
  assert.equal(previewDecision(options).controlOnly, true);
  assert.equal(previewNames("owner422").volume, "graylum-preview-owner422-pgdata");
});

test("persistent signing state is local mode 0600 and resume cannot change bootstrap shape", () => {
  const env = testEnv();
  const state = { version: 1, id: "owner422", initialized: true, secret: "local-only", names: previewNames("owner422"), structuralArgs: ["--opc-only"] };
  const path = writePreviewState(state, env);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).secret, "local-only");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(validateResumeState(readPreviewState("owner422", env), ["--opc-only"]), state);
  assert.throws(() => validateResumeState(state, ["--runtime-only"]), /ARGUMENT_MISMATCH/);
  removePreviewState("owner422", env);
  assert.throws(() => readPreviewState("owner422", env), /NOT_FOUND/);
});

test("preview credentials stay short-lived and renew is not a bootstrap action", () => {
  assert.equal(PREVIEW_TOKEN_TTL_SECONDS, 7200);
  const token = signPreviewJwt("x".repeat(64), "service_role", { nowSeconds: 1000 });
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(payload.exp, 8200);
  assert.notEqual(token, signPreviewJwt("y".repeat(64), "service_role", { nowSeconds: 1000 }));
  const renew = previewDecision(parsePreviewOptions(["--serve", "--preview-id=owner422", "--preview-action=renew"]));
  assert.equal(renew.bootstrap, false);
  assert.equal(renew.runTests, false);
});

test("structural preview identity ignores lifecycle/case controls but preserves schema mode", () => {
  assert.deepEqual(structuralPreviewArgs(["--serve", "--preview-id=owner422", "--preview-action=resume", "--case-pattern=x", "--opc-only", "--with-staging-schema"]), ["--opc-only", "--with-staging-schema"]);
});
