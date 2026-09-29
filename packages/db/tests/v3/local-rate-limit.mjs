/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { REDIS_IMAGE, SRH_IMAGE } from "./local-rate-limit-images.mjs";

const OWNER_LABEL = "io.graylum.local-rate-limit";
const executeDocker = (args, env) => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
}).trim();

export function localRateLimitNames(tag) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(tag)) throw new Error("LOCAL_RATE_LIMIT_TAG_INVALID");
  return { redis: `${tag}-redis`, rest: `${tag}-srh`, network: `${tag}-rate-limit` };
}

// Inspect all identities before deleting any resource, including after a partial start.
export function inspectLocalRateLimit(tag, ownerId, docker) {
  const names = localRateLimitNames(tag);
  const found = [];
  for (const [kind, name] of [["container", names.rest], ["container", names.redis], ["network", names.network]]) {
    let item;
    try { [item] = JSON.parse(docker(kind, "inspect", name)); }
    catch (error) {
      if (/no such (object|container|network)|network .* not found/i.test(String(error.stderr ?? ""))) continue;
      throw new Error("LOCAL_RATE_LIMIT_INSPECT_FAILED");
    }
    if (!item || (item.Config?.Labels ?? item.Labels)?.[OWNER_LABEL] !== ownerId)
      throw new Error("LOCAL_RATE_LIMIT_NOT_OWNED");
    found.push([kind, name]);
  }
  return found;
}

export function cleanLocalRateLimit(tag, ownerId, docker) {
  for (const [kind, name] of inspectLocalRateLimit(tag, ownerId, docker)) {
    if (kind === "container") docker("rm", "-f", "-v", name);
    else docker("network", "rm", name);
  }
}

// Only the disposable Vitest beforeEach hook calls this; no website control endpoint.
export function resetLocalRateLimit(tag, ownerId, execute = executeDocker) {
  const names = localRateLimitNames(tag);
  if (!ownerId) throw new Error("LOCAL_RATE_LIMIT_NOT_OWNED");
  const resources = inspectLocalRateLimit(tag, ownerId, (...args) => execute(args));
  if (resources.length !== 3) throw new Error("LOCAL_RATE_LIMIT_NOT_READY");
  if (execute(["exec", names.redis, "redis-cli", "FLUSHDB"]) !== "OK")
    throw new Error("LOCAL_RATE_LIMIT_RESET_FAILED");
}

export function createLocalRateLimit({ tag, ownerId = randomUUID(), execute = executeDocker,
  request = fetch, readinessTimeoutMs = 15000 } = {}) {
  const names = localRateLimitNames(tag);
  const token = randomBytes(32).toString("hex");
  const docker = (...args) => execute(args);
  const labels = ["--label", `${OWNER_LABEL}=${ownerId}`];
  const redact = (text) => String(text).replaceAll(token, "[LOCAL_RATE_LIMIT_TOKEN]");
  const cleanup = () => {
    try { cleanLocalRateLimit(tag, ownerId, docker); }
    catch { throw new Error("LOCAL_RATE_LIMIT_CLEANUP_FAILED"); }
  };
  return {
    redact,
    cleanup,
    caseEnvironment: { V3_RATE_LIMIT_TAG: tag, V3_RATE_LIMIT_OWNER: ownerId },
    async start() {
      // A persistent preview lease protects this owner; each run gets fresh counters/token.
      cleanup();
      try {
        // Dedicated Docker bridge: Redis has no published host port.
        // Docker internal=true suppresses REST port publishing on current engines.
        docker("network", "create", ...labels, names.network);
        docker("run", "-d", ...labels, "--name", names.redis, "--network", names.network,
          REDIS_IMAGE, "redis-server", "--save", "", "--appendonly", "no");
        // Pass only the variable NAME in argv. Never interpolate the token into a command/error.
        execute(["run", "-d", ...labels, "--name", names.rest, "--network", names.network,
          "-p", "127.0.0.1::80", "-e", "SRH_MODE=env", "-e", "SRH_TOKEN",
          "-e", `SRH_CONNECTION_STRING=redis://${names.redis}:6379`, SRH_IMAGE], { SRH_TOKEN: token });
        const binding = docker("port", names.rest, "80/tcp");
        if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error("LOCAL_RATE_LIMIT_BINDING_INVALID");
        const url = `http://${binding}`;
        const deadline = Date.now() + readinessTimeoutMs;
        while (Date.now() < deadline) {
          try {
            const response = await request(url, {
              method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify(["PING"]), signal: AbortSignal.timeout(1000),
            });
            if (response.ok && (await response.json()).result === "PONG") {
              return { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token };
            }
          } catch { /* Retry only the bounded, read-only readiness probe. */ }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("LOCAL_RATE_LIMIT_NOT_READY");
      } catch {
        cleanup();
        throw new Error("LOCAL_RATE_LIMIT_START_FAILED");
      }
    },
  };
}
