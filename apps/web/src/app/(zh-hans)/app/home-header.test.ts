/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the /app home page uses the workbench's shared top bar instead of drawing its own", () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./home.module.css", import.meta.url), "utf8");
  expect(page).toContain("<GlobalHeader");
  expect(page).toContain("from '@/components/opc/rail-view'");
  expect(page).not.toMatch(/<header|styles\.header\b|styles\.brand/);
  // Its phone menu button opens a rail this page does not have, so it is hidden here.
  expect(css).toContain('button[aria-label="打开导航"]{display:none}');
});
