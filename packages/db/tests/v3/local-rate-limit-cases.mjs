/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function installLocalRateLimitCases(root, testRoot = root) {
  const directory = resolve(root, "packages/db/tests/v3");
  const api = resolve(testRoot, "packages/api");
  const setup = readFileSync(resolve(directory, "local-rate-limit-test-setup.mjs"), "utf8")
    .replace("../db/tests/v3/local-rate-limit.mjs", pathToFileURL(resolve(directory, "local-rate-limit.mjs")).href);
  writeFileSync(resolve(api, "local-rate-limit-test-setup.mjs"), setup);
  const config = resolve(api, "local-rate-limit-vitest.config.mjs");
  writeFileSync(config, `import original from './vitest.integration.config.ts';
export default {...original, test: {...original.test,
  setupFiles: [...(original.test?.setupFiles ?? []), './local-rate-limit-test-setup.mjs'],
}};\n`);
  return { config, nodeOptions: ` --require=${resolve(directory, "local-rate-limit-observer.cjs")}` };
}
