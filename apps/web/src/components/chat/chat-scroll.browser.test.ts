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
    if(${pinned})window.pinner=pinToBottomOnGrowth(log,()=>window.follow);`);
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

  it("keeps a restored position near the bottom until something actually grows", async () => {
    await setup(650); // 50px above the bottom: inside the follow threshold, so following.
    expect(await page.evaluate(() => (window as unknown as { follow: boolean }).follow)).toBe(true);
    expect(await gap()).toBe(50);
    await page.evaluate(() => { document.getElementById("live")!.style.height = "450px"; });
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
    await page.evaluate(() => { (window as unknown as { pinner: { stop: () => void } }).pinner.stop(); document.getElementById("live")!.style.height = "650px"; });
    await settle();
    expect(await gap()).toBe(250);
  });
}, 60_000);

type Restore = { follow: boolean; restored: boolean; saved: string | null; pinner: { check: () => void; rebase: () => void } };

/**
 * The mentor log after a refresh, as the staging report measured it: 4045px of content in a 243px log.
 * Like useMentorLogScroll, the watcher starts while the log is still empty; the history then renders
 * and the saved position is restored in the same task, before any observer callback runs.
 */
async function refreshAt(saved: number) {
  await page.setContent('<div id="log" style="height:243px;overflow-y:auto"></div>');
  await page.evaluate(`const FOLLOW_THRESHOLD_PX=${FOLLOW_THRESHOLD_PX};${isNearBottom};${pinToBottomOnGrowth};
    const log=document.getElementById("log");window.restored=false;window.follow=true;window.saved="${saved}";
    log.addEventListener("scroll",()=>{window.follow=log.scrollHeight-log.clientHeight-log.scrollTop<64;
      if(window.restored)window.saved=String(log.scrollTop);});
    window.pinner=pinToBottomOnGrowth(log,()=>window.restored&&window.follow);`);
  await settle();
  await page.evaluate(() => {
    const log = document.getElementById("log")!, w = window as unknown as Restore;
    log.innerHTML = '<div style="height:3645px">历史</div><p id="live" style="margin:0;height:400px">导师<span id="tick">1</span></p>';
    log.scrollTop = Number(w.saved);
    w.follow = log.scrollHeight - log.clientHeight - log.scrollTop < 64;
    w.restored = true;
    w.pinner.rebase();
  });
  await settle();
}
/** What else happens after a refresh without changing any size: a re-render, a refetch, a ticking label. */
async function churnWithoutGrowth() {
  await page.evaluate(() => {
    const w = window as unknown as Restore;
    document.getElementById("tick")!.textContent = "2";
    document.getElementById("live")!.insertAdjacentHTML("beforeend", '<span style="display:none">状态</span>');
    w.pinner.check();
  });
  await settle();
}
const saved = () => page.evaluate(() => (window as unknown as Restore).saved);

describe("restoring the mentor log position after a refresh", () => {
  it.each([32, 50])("stays %ipx above the bottom, and keeps that saved, until the content grows", async distance => {
    await refreshAt(3802 - distance);
    expect(await gap()).toBe(distance);
    await churnWithoutGrowth();
    expect(await gap()).toBe(distance);
    expect(await saved()).toBe(String(3802 - distance));
    await page.evaluate(() => { document.getElementById("live")!.style.height = "460px"; });
    await settle();
    expect(await gap()).toBeLessThan(1);
  });

  it("stays in the middle of the log, and is not pulled down when the content grows", async () => {
    await refreshAt(1500);
    await churnWithoutGrowth();
    await page.evaluate(() => { document.getElementById("live")!.style.height = "460px"; });
    await settle();
    expect(await page.evaluate(() => document.getElementById("log")!.scrollTop)).toBe(1500);
    expect(await saved()).toBe("1500");
  });
}, 60_000);
