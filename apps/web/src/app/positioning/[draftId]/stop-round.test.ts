/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { liveReplyAfter, startLiveReply } from "./agent-turn-display";
import { stopRequestFor } from "./stop-reply";
import { saveLivePrefix, takeLivePrefix, markLiveReload } from "./live-prefix";

// CHAT-NATIVE-OUTPUT follow-up (0260): the stop names the round whose text is on screen.
const ID = "10000000-0000-4000-8000-000000000001";
const delta = (text: string, offset: number, rev: number, call?: number) =>
  ({ type: "textDelta" as const, text, offset, rev, source: "assistant" as const, ...(call ? { call } : {}) });

describe("round on screen", () => {
  it("follows the latest accepted text, including a tool round's replacement", () => {
    let reply = liveReplyAfter(startLiveReply(ID), ID, delta("我先读一下", 0, 0, 1));
    expect(reply?.call).toBe(1);
    reply = liveReplyAfter(reply, ID, delta("结论", 0, 1, 2));
    expect(reply).toMatchObject({ text: "结论", call: 2 });
    expect(stopRequestFor(reply!)).toEqual({ executionId: ID, stopAt: 2, source: "assistant", call: 2 });
  });
  it("a dropped frame does not move the round; an older server sends none and the stop omits it", () => {
    const shown = liveReplyAfter(startLiveReply(ID), ID, delta("你好", 0, 0, 1))!;
    const dropped = liveReplyAfter(shown, ID, delta("后面", 9, 0, 2))!;
    expect(dropped).toMatchObject({ stalled: true, call: 1 });
    const legacy = liveReplyAfter(startLiveReply(ID), ID, delta("你好", 0, 0))!;
    expect(stopRequestFor(legacy)).toEqual({ executionId: ID, stopAt: 2, source: "assistant" });
  });
  it("survives a same-tab reload so a stop on the restored text still names its round", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k) };
    const reply = liveReplyAfter(startLiveReply(ID), ID, delta("你好", 0, 0, 3))!;
    expect(saveLivePrefix(storage, "draft", reply)).toBe(true);
    markLiveReload(storage, "draft", reply);
    expect(takeLivePrefix(storage, "draft")).toMatchObject({ text: "你好", call: 3 });
  });
});
