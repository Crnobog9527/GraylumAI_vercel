/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PREVIEW_TOKEN_TTL_SECONDS = 7200;
export const PREVIEW_ACTIONS = new Set(["start", "resume", "renew", "restart", "stop", "destroy"]);
const SAFE_PREVIEW_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function signPreviewJwt(secret, role, { nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = PREVIEW_TOKEN_TTL_SECONDS } = {}) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("PREVIEW_SECRET_INVALID");
  if (!["anon", "authenticated", "service_role"].includes(role)) throw new Error("PREVIEW_ROLE_INVALID");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > PREVIEW_TOKEN_TTL_SECONDS || !Number.isInteger(nowSeconds) || nowSeconds < 0)
    throw new Error("PREVIEW_TOKEN_TTL_INVALID");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, exp: nowSeconds + ttlSeconds })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const readArg = (args, prefix) => {
  const matches = args.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1 || (matches.length && matches[0].length === prefix.length)) throw new Error("PREVIEW_ARGUMENT_INVALID");
  return matches[0]?.slice(prefix.length);
};

export function parsePreviewOptions(args) {
  const serve = args.includes("--serve");
  const id = readArg(args, "--preview-id=");
  const actionValue = readArg(args, "--preview-action=");
  const confirmDestroy = readArg(args, "--confirm-destroy=");
  if (!serve && (id || actionValue || confirmDestroy)) throw new Error("preview lifecycle flags require --serve");
  if (!serve) return { persistent: false, id: null, action: "test", confirmDestroy: null };
  if (!id || !SAFE_PREVIEW_ID.test(id)) throw new Error("--serve requires --preview-id=<lowercase-safe-id>");
  const action = actionValue ?? "start";
  if (!PREVIEW_ACTIONS.has(action)) throw new Error("invalid --preview-action");
  if (action === "destroy" && confirmDestroy !== id) throw new Error("destroy requires --confirm-destroy=<same-preview-id>");
  if (action !== "destroy" && confirmDestroy) throw new Error("--confirm-destroy is only valid for destroy");
  return { persistent: true, id, action, confirmDestroy: confirmDestroy ?? null };
}

export function previewNames(id) {
  if (!SAFE_PREVIEW_ID.test(id)) throw new Error("invalid preview id");
  const tag = `graylum-preview-${id}`;
  return { tag, db: `${tag}-db`, rest: `${tag}-rest`, auth: `${tag}-auth`, volume: `${tag}-pgdata` };
}

export function previewDecision(options) {
  if (!options.persistent) return { bootstrap: true, runTests: true, controlOnly: false, destroyBackendsOnFinally: true };
  if (options.action === "stop" || options.action === "destroy") return { bootstrap: false, runTests: false, controlOnly: true, destroyBackendsOnFinally: false };
  return { bootstrap: options.action === "start", runTests: options.action === "start", controlOnly: false, destroyBackendsOnFinally: false };
}

/** The runner uses this same gate for SQL bootstrap, fixture tests and curation. */
export async function runPreviewPhase(options, phase, run) {
  const decision = previewDecision(options);
  if (!["bootstrap", "runTests", "destroyBackendsOnFinally"].includes(phase)) throw new Error("PREVIEW_PHASE_INVALID");
  if (decision[phase]) return run();
}

export function previewStatePath(id, env = process.env) {
  if (!SAFE_PREVIEW_ID.test(id)) throw new Error("invalid preview id");
  const root = env.V3_PREVIEW_STATE_ROOT ? resolve(env.V3_PREVIEW_STATE_ROOT) : resolve(homedir(), ".graylum", "workbench-previews");
  return { root, file: resolve(root, `${id}.json`), evidence: resolve(root, `${id}-evidence`), lock: resolve(root, `${id}.lock`) };
}

function assertStateShape(value, id) {
  const names = previewNames(id);
  if (value?.version !== 1 || value?.id !== id || typeof value?.secret !== "string" || value.secret.length < 32 || !Array.isArray(value?.structuralArgs) || !value.structuralArgs.every((arg) => typeof arg === "string") || Object.keys(names).some((key) => value.names?.[key] !== names[key]))
    throw new Error("PREVIEW_STATE_INVALID");
  return value;
}

export function readPreviewState(id, env = process.env) {
  const { file } = previewStatePath(id, env);
  if (!existsSync(file)) throw new Error("PREVIEW_STATE_NOT_FOUND");
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("PREVIEW_STATE_PERMISSIONS");
  return assertStateShape(JSON.parse(readFileSync(file, "utf8")), id);
}

export function writePreviewState(state, env = process.env) {
  assertStateShape(state, state.id);
  const { root, file } = previewStatePath(state.id, env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(file) && !lstatSync(file).isFile()) throw new Error("PREVIEW_STATE_PERMISSIONS");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

export function removePreviewState(id, env = process.env) {
  rmSync(previewStatePath(id, env).file, { force: true });
}

export function structuralPreviewArgs(args) {
  return args.filter((arg) => arg !== "--serve" && !arg.startsWith("--preview-") && !arg.startsWith("--confirm-destroy=") && !arg.startsWith("--case-pattern=")).sort();
}

export function validateResumeState(state, expectedArgs) {
  if (!state.initialized) throw new Error("PREVIEW_NOT_INITIALIZED; preserve evidence or destroy this preview explicitly");
  if (JSON.stringify(state.structuralArgs) !== JSON.stringify([...expectedArgs].sort())) throw new Error("PREVIEW_ARGUMENT_MISMATCH");
  return state;
}
