/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import type { AgentTurnEvent } from "@repo/api/src/shared/agentTurn";
import { startLiveReply, type LiveReply } from "./agent-turn-display";
import { livePrefixKey, markLiveReload, restoreLivePrefix, takeLivePrefix, unmarkLiveReload } from "./live-prefix";
import { liveReplyController } from "./live-reply-controller";

/** sessionStorage stand-in; `failWrites` simulates a full or blocked store. */
class TabStorage {
  items = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error("QuotaExceededError"); this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
  /** What a duplicated tab or window.open receives: a copy taken while this page is alive. */
  copy() { const next = new TabStorage(); next.items = new Map(this.items); return next; }
}

const executionId = "00000000-0000-4000-8000-0000000000aa";
let drafts = 0;
const newDraft = () => `draft-${++drafts}`;
const shown = (text: string, rev = 0): LiveReply => ({ ...startLiveReply(executionId), text, rev, points: [...text].length });
const delta = (text: string, offset: number, rev = 0): AgentTurnEvent => ({ type: "textDelta", text, offset, rev });

function controller(draftId: string, storage: TabStorage, clock = { now: 0 }) {
  const views: Array<LiveReply | null> = [];
  const live = liveReplyController({ draftId, storage: () => storage, show: reply => views.push(reply), now: () => clock.now });
  return { live, views, clock };
}
const stored = (storage: TabStorage, draftId: string) => JSON.parse(storage.getItem(livePrefixKey(draftId)) ?? "null");

describe("same-tab reload restore (CHAT-NATIVE-OUTPUT §2.4)", () => {
  it("restores the prefix after pagehide, waiting and not growing, and consumes the mark", () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, shown("已经显示的部分", 2));
    const restored = takeLivePrefix(storage, draftId);
    expect(restored).toMatchObject({ executionId, text: "已经显示的部分", rev: 2, points: 7, phase: "waiting", stalled: true, card: null });
    expect(stored(storage, draftId)).toEqual({ executionId, text: "已经显示的部分", rev: 2 });
    // A copy of this tab made after the reload has no mark any more.
    expect(takeLivePrefix(storage.copy(), draftId)).toBeNull();
  });

  it("restores after a slow reload: the mark has no expiry", () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, shown("慢加载"));
    // Nothing in the stored value depends on time; any delay between pagehide and load restores.
    expect(Object.keys(stored(storage, draftId))).not.toContain("at");
    expect(takeLivePrefix(storage, draftId)?.text).toBe("慢加载");
  });

  it("does not restore a duplicated tab or a window opened by this page", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("原标签页的文字", 0));
    const copied = storage.copy(); // copied while the original page is alive: no pagehide yet
    expect(takeLivePrefix(copied, draftId)).toBeNull();
    expect(copied.getItem(livePrefixKey(draftId))).toBeNull();
    // The original tab still restores when it reloads itself.
    live.pageHide();
    expect(takeLivePrefix(storage, draftId)?.text).toBe("原标签页的文字");
  });

  it("does not restore in a new tab or when nothing was stored", () => {
    expect(takeLivePrefix(new TabStorage(), newDraft())).toBeNull();
  });

  it("drops an unreadable item", () => {
    const draftId = newDraft(), storage = new TabStorage();
    storage.setItem(livePrefixKey(draftId), "{broken");
    expect(takeLivePrefix(storage, draftId)).toBeNull();
    expect(storage.getItem(livePrefixKey(draftId))).toBeNull();
  });

  it("restores nothing when the pagehide write fails", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("旧的部分", 0));
    storage.failWrites = true;
    live.pageHide();
    expect(storage.getItem(livePrefixKey(draftId))).toBeNull();
    storage.failWrites = false;
    expect(takeLivePrefix(storage, draftId)).toBeNull();
  });

  it("withdraws the mark when the page returns from the back/forward cache", () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, shown("缓存页"));
    unmarkLiveReload(storage, draftId);
    expect(takeLivePrefix(storage.copy(), draftId)).toBeNull();
  });

  it("gives a second mount in the same load the same restored reply", () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, shown("两次挂载"));
    expect(restoreLivePrefix(storage, draftId)?.text).toBe("两次挂载");
    expect(restoreLivePrefix(storage, draftId)?.text).toBe("两次挂载");
  });

  it("stores only displayed text and rev, never a card", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("正文", 0));
    live.apply(executionId, { type: "card", card: { question: "问？", options: ["A", "B"], recommended: 0 } });
    live.pageHide();
    expect(stored(storage, draftId)).toEqual({ executionId, text: "正文", rev: 0, reload: true });
  });
});

describe("live reply controller", () => {
  it("stores a replacing snapshot before showing it, so a reload never brings back replaced text", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live, clock } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("先写的助手文字", 0));
    clock.now = 10; // inside the throttle window
    live.apply(executionId, delta("卡片正文", 0, 1));
    expect(stored(storage, draftId)).toEqual({ executionId, text: "卡片正文", rev: 1 });
  });

  it("removes the item when a snapshot cannot be stored", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live, views } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("旧来源", 0));
    storage.failWrites = true;
    live.apply(executionId, delta("新来源", 0, 1));
    expect(storage.items.has(livePrefixKey(draftId))).toBe(false);
    expect(views.at(-1)?.text).toBe("新来源");
  });

  it("throttles normal growth to once a second, and pagehide stores the latest text", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live, clock } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("一", 0));
    clock.now = 400;
    live.apply(executionId, delta("二", 1));
    expect(stored(storage, draftId).text).toBe("一");
    clock.now = 1200;
    live.apply(executionId, delta("三", 2));
    expect(stored(storage, draftId).text).toBe("一二三");
    clock.now = 1300;
    live.apply(executionId, delta("四", 3));
    live.pageHide(); // a reload right after a new frame restores it, not the throttled copy
    expect(takeLivePrefix(storage, draftId)?.text).toBe("一二三四");
  });

  it("resuming the same execution keeps what is shown instead of clearing it (same-page disconnect)", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("已显示", 0));
    live.mark(executionId, "waiting");
    live.begin(executionId);
    expect(live.current()).toMatchObject({ text: "已显示", phase: "waiting", stalled: true });
    // No growth from a non-snapshot frame; the final snapshot replaces it.
    live.apply(executionId, delta("不该出现", 3));
    expect(live.current()?.text).toBe("已显示");
    live.apply(executionId, delta("完整回复", 0, 0));
    expect(live.current()).toMatchObject({ text: "完整回复", stalled: false });
  });

  it("a new execution starts empty and forgets the previous copy", () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live } = controller(draftId, storage);
    live.begin(executionId);
    live.apply(executionId, delta("上一轮", 0));
    live.begin("00000000-0000-4000-8000-0000000000bb");
    expect(live.current()?.text).toBe("");
    expect(storage.getItem(livePrefixKey(draftId))).toBeNull();
  });

  it("restore shows the stored prefix only after a same-tab reload", () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, shown("刷新前"));
    const { live } = controller(draftId, storage);
    live.restore();
    expect(live.current()).toMatchObject({ text: "刷新前", phase: "waiting" });
    const other = newDraft(), copy = new TabStorage();
    const fresh = controller(other, copy);
    fresh.live.restore();
    expect(fresh.live.current()).toBeNull();
  });

  it("settle replaces a waiting copy once history shows its execution finished; clear forgets it", () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, shown("等待中"));
    const { live } = controller(draftId, storage);
    live.restore();
    live.settle("00000000-0000-4000-8000-0000000000bb");
    expect(live.current()).not.toBeNull();
    live.settle(executionId);
    expect(live.current()).toBeNull();
    expect(storage.getItem(livePrefixKey(draftId))).toBeNull();
  });
});

async function* events(list: AgentTurnEvent[], interrupt = false) {
  for (const event of list) yield event;
  if (interrupt) throw new Error("network");
}

describe("live reply stream", () => {
  it("a pending result (another reader owns the execution) waits with the restored prefix", async () => {
    const draftId = newDraft(), storage = new TabStorage();
    markLiveReload(storage, draftId, shown("刷新前已显示"));
    const { live } = controller(draftId, storage);
    live.restore();
    const result = await live.stream(async () => events([{ type: "result", result: { state: "pending" } }]), { executionId });
    expect(result.state).toBe("pending");
    expect(live.current()).toMatchObject({ text: "刷新前已显示", phase: "waiting", stalled: true });
    expect(stored(storage, draftId).text).toBe("刷新前已显示");
  });

  it("a lost connection keeps the shown part, not growing, in the waiting state", async () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live } = controller(draftId, storage);
    await expect(live.stream(async () => events([{ type: "admitted", executionId }, delta("写到这里", 0)], true), {}))
      .rejects.toThrow("network");
    expect(live.current()).toMatchObject({ text: "写到这里", phase: "waiting", stalled: true });
  });

  it("a finished turn without a completed result is incomplete and keeps nothing for a reload", async () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live } = controller(draftId, storage);
    await live.stream(async () => events([{ type: "admitted", executionId }, delta("部分", 0),
      { type: "result", result: { state: "cancelled" } }]), {});
    expect(live.current()?.phase).toBe("incomplete");
    expect(storage.getItem(livePrefixKey(draftId))).toBeNull();
    live.pageHide();
    expect(storage.getItem(livePrefixKey(draftId))).toBeNull();
  });

  it("a completed stream shows text while writing and the card after it; the result is returned", async () => {
    const draftId = newDraft(), storage = new TabStorage();
    const { live, views } = controller(draftId, storage);
    const card = { question: "问？", options: ["A", "B"], recommended: 0 };
    const admitted: string[] = [];
    const result = await live.stream(async () => events([{ type: "admitted", executionId }, delta("正", 0), delta("文", 1),
      { type: "card", card }, { type: "result", result: { state: "completed", completeness: "complete" } }]),
    { onAdmitted: id => admitted.push(id) });
    expect(admitted).toEqual([executionId]);
    expect(result).toEqual({ state: "completed", completeness: "complete" });
    expect(views.map(view => [view?.text, Boolean(view?.card)])).toEqual([["", false], ["正", false], ["正文", false], ["正文", true],
      ["正文", true]]); // the last view marks the reply finished (停止 goes away)
  });
});
