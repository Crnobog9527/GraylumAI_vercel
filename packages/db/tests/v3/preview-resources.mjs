/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { previewNames, previewStatePath, removePreviewState } from "./preview-lifecycle.mjs";

const OWNER_LABEL = "io.graylum.workbench-preview";
const resourceList = (names) => [["container", names.auth], ["container", names.rest], ["container", names.db], ["network", names.tag], ["volume", names.volume]];

/** Never signal a PID from disk. A held or stale lease fails closed. */
export function acquirePreviewLease(id, source, env = process.env) {
  const paths = previewStatePath(id, env);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const location = relative(realpathSync(source), realpathSync(paths.root));
  if ((!isAbsolute(location) && location !== ".." && !location.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))) || !lstatSync(paths.root).isDirectory() || (lstatSync(paths.root).mode & 0o077))
    throw new Error("PREVIEW_STATE_ROOT_MUST_BE_PRIVATE_AND_OUTSIDE_REPOSITORY");
  try { mkdirSync(paths.lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("PREVIEW_IN_USE: stop the serving terminal with Ctrl+C first; a crash lease needs verified local recovery");
    throw error;
  }
  const marker = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const lease = resolve(paths.lock, "owner.json");
  writeFileSync(lease, marker, { mode: 0o600, flag: "wx" });
  return () => {
    if (readFileSync(lease, "utf8") !== marker) throw new Error("PREVIEW_LEASE_CHANGED");
    unlinkSync(lease);
    rmdirSync(paths.lock);
  };
}

export function previewLabelArgs(state) {
  return ["--label", `${OWNER_LABEL}=${state.ownerId}`];
}

export function inspectPreviewResource(docker, kind, name) {
  try {
    const objects = JSON.parse(docker(kind, "inspect", name));
    if (!Array.isArray(objects) || objects.length !== 1) throw new Error("PREVIEW_INSPECT_INVALID");
    return objects[0];
  } catch (error) {
    // Daemon/permission/transport errors are not evidence that an object is absent.
    if (/no such (object|container|network|volume)|(volume|network) .* not found/i.test(String(error.stderr ?? ""))) return null;
    throw new Error("PREVIEW_INSPECT_FAILED");
  }
}

export function assertPreviewResources(state, docker, { requireAll = true, mustBeAbsent = false } = {}) {
  const names = previewNames(state.id);
  if (!/^[a-f0-9-]{36}$/.test(state.ownerId ?? "") || Object.keys(names).some((key) => state.names?.[key] !== names[key])) throw new Error("PREVIEW_RESOURCE_IDENTITY_INVALID");
  const found = new Set();
  for (const [kind, name] of resourceList(names)) {
    const item = inspectPreviewResource(docker, kind, name);
    if (!item) {
      if (requireAll) throw new Error("PREVIEW_RESOURCE_MISSING: " + name);
      continue;
    }
    if (mustBeAbsent) throw new Error("PREVIEW_RESOURCE_COLLISION: " + name);
    if ((item.Config?.Labels ?? item.Labels)?.[OWNER_LABEL] !== state.ownerId) throw new Error("PREVIEW_RESOURCE_NOT_OWNED: " + name);
    if (kind === "container") {
      const bindings = Object.values(item.HostConfig?.PortBindings ?? {}).flat();
      if (!bindings.length || bindings.some((binding) => binding.HostIp !== "127.0.0.1") || !item.NetworkSettings?.Networks?.[names.tag]) throw new Error("PREVIEW_NETWORK_BOUNDARY_INVALID");
      if (name === names.db && !item.Mounts?.some((mount) => mount.Type === "volume" && mount.Name === names.volume && mount.Destination === "/var/lib/postgresql/data")) throw new Error("PREVIEW_VOLUME_BOUNDARY_INVALID");
      const key = name === names.rest ? "PGRST_JWT_SECRET" : name === names.auth ? "GOTRUE_JWT_SECRET" : null;
      if (key && !item.Config.Env?.includes(`${key}=${state.secret}`)) throw new Error("PREVIEW_SIGNING_STATE_MISMATCH");
    }
    found.add(name);
  }
  return found;
}

/** All identities are verified BEFORE the first stop/remove. Never called by finally. */
export function controlPreview(options, state, docker, env = process.env) {
  if (!options.persistent || options.id !== state.id || !["stop", "destroy"].includes(options.action) || (options.action === "destroy" && options.confirmDestroy !== state.id)) throw new Error("PREVIEW_CONTROL_DENIED");
  const found = assertPreviewResources(state, docker, { requireAll: false });
  for (const name of [state.names.auth, state.names.rest, state.names.db]) {
    if (found.has(name)) {
      if (options.action === "stop") docker("stop", "--time", "10", name);
      else docker("rm", "-f", name);
    }
  }
  if (options.action === "destroy") {
    if (found.has(state.names.tag)) docker("network", "rm", state.names.tag);
    if (found.has(state.names.volume)) docker("volume", "rm", state.names.volume);
    // Keep read-back evidence; remove signing state only after all removals succeeded.
    removePreviewState(state.id, env);
  }
}

export function assertNewPreview(id, env = process.env) {
  if (existsSync(previewStatePath(id, env).file)) throw new Error("PREVIEW_ALREADY_EXISTS: use resume, not start");
}

/** Only a ChildProcess spawned by this runner is accepted, never a stored PID. */
export async function stopLocalApplication(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let timer;
    const done = (error) => {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      error ? reject(error) : resolve();
    };
    const exited = () => done();
    child.once("exit", exited);
    const signal = (name) => {
      try { process.kill(-child.pid, name); }
      catch (error) { if (error.code === "ESRCH") done(); else done(error); }
    };
    timer = setTimeout(() => signal("SIGKILL"), 5000);
    signal("SIGTERM");
  });
}
