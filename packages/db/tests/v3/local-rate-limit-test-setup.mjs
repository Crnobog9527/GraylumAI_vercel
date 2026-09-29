/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Copied beside the API Vitest config so imports use its existing dependency.
import { resetLocalRateLimit } from "../db/tests/v3/local-rate-limit.mjs";
import { beforeEach, afterEach } from "vitest";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const record = (event, task) => appendFileSync(
  join(process.env.V3_WORKBENCH_OUTPUT, "rate-limit-cases.jsonl"),
  JSON.stringify({ event, id: task.id, name: task.name, time: Date.now() }) + "\n", { mode: 0o600 },
);
let active;
beforeEach(({ task }) => {
  if (active) throw new Error("LOCAL_RATE_LIMIT_CONCURRENT_CASES_UNSUPPORTED");
  resetLocalRateLimit(process.env.V3_RATE_LIMIT_TAG, process.env.V3_RATE_LIMIT_OWNER);
  active = task.id;
  record("begin", task);
});
afterEach(({ task }) => {
  if (active !== task.id) return;
  record("end", task);
  active = undefined;
});
