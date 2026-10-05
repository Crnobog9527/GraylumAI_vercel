/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOLLOW_THRESHOLD_PX, isNearBottom, pinToBottomOnGrowth } from "./chat-scroll";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); }, 30_000);

/** A 300px log with 1000px of messages, scrolled to `top` (bottom when omitted), following while `window.follow`. */
async function setup(top?: number, pinned = true) {
  await page.setContent(`<div id="log" style="height:300px;overflow-y:auto">
    <div style="height:600px">older</div><p id="live" style="margin:0;height:400px">导师</p></div>`);
  await page.evaluate(`const FOLLOW_THRESHOLD_PX=${FOLLOW_THRESHOLD_PX};${isNearBottom};${pinToBottomOnGrowth};
    const log=document.getElementById("log");window.follow=true;
    log.addEventListener("scroll",()=>{window.follow=isNearBottom(log);});
    log.scrollTop=${top ?? "log.scrollHeight"};
    if(${pinned})window.stop=pinToBottomOnGrowth(log,()=>window.follow);`);
  await settle();
}
const gap = () => page.evaluate(() => { const log = document.getElementById("log")!; return log.scrollHeight - log.clientHeight - log.scrollTop; });
const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

describe("pinToBottomOnGrowth in a real browser", () => {
  it("reproduces the gap: growth with no tracked React value leaves a reader at the bottom behind", async () => {
    await setup(undefined, false);
    await page.evaluate(() => { document.getElementById("log")!.insertAdjacentHTML("beforeend", '<div style="height:200px">建议卡</div>'); });
    await settle();
    expect(await gap()).toBe(200);
  });

  it.each([
    ["streamed text", () => { document.getElementById("live")!.append("，继续输出"); document.getElementById("live")!.style.height = "700px"; }],
    ["a new card or notice", () => { document.getElementById("log")!.insertAdjacentHTML("beforeend", '<div style="height:200px">建议卡</div>'); }],
    ["the log itself shrinking under a docked card", () => { document.getElementById("log")!.style.height = "180px"; }],
    ["a message growing after layout", () => { document.getElementById("live")!.style.height = "650px"; }],
  ])("keeps a reader at the bottom following %s", async (_name, grow) => {
    await setup();
    await page.evaluate(grow);
    await settle();
    expect(await gap()).toBeLessThan(1);
  });

  it("never pulls down a reader who scrolled up", async () => {
    await setup(120);
    expect(await page.evaluate(() => (window as unknown as { follow: boolean }).follow)).toBe(false);
    await page.evaluate(() => {
      document.getElementById("live")!.append("，继续输出");
      document.getElementById("log")!.insertAdjacentHTML("beforeend", '<div style="height:200px">建议卡</div>');
    });
    await settle();
    expect(await page.evaluate(() => document.getElementById("log")!.scrollTop)).toBe(120);
  });

  it("stops watching after cleanup", async () => {
    await setup();
    await page.evaluate(() => { (window as unknown as { stop: () => void }).stop(); document.getElementById("live")!.style.height = "650px"; });
    await settle();
    expect(await gap()).toBe(250);
  });
}, 60_000);
