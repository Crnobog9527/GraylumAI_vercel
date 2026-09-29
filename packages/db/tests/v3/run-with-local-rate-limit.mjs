/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createLocalRateLimit } from "./local-rate-limit.mjs";
import { stopLocalApplication } from "./preview-resources.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("LOCAL_RATE_LIMIT_COMMAND_REQUIRED");
const service = createLocalRateLimit({ tag: `graylum-rl-${randomUUID()}` });
let child, interrupted = false;
const stop = () => { interrupted = true; void stopLocalApplication(child); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const env = await service.start();
  if (!interrupted) await new Promise((resolve, reject) => {
    child = spawn(command, args, { env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    // Keep partial lines until complete so a token split across chunks is also redacted.
    for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let pending = "";
      input.on("data", (chunk) => {
        pending += chunk.toString();
        const end = pending.lastIndexOf("\n") + 1;
        if (end) { output.write(service.redact(pending.slice(0, end))); pending = pending.slice(end); }
      });
      input.on("end", () => { if (pending) output.write(service.redact(pending)); });
    }
    child.once("error", reject);
    child.once("exit", (code) => { process.exitCode = interrupted ? 0 : code ?? 1; resolve(); });
  });
} catch { process.exitCode = 1; console.error("Local rate-limit application failed"); }
finally {
  await stopLocalApplication(child);
  service.cleanup();
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
}
