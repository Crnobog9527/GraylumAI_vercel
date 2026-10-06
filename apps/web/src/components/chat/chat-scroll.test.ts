/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { followTranscript, isNearBottom, transcriptSignature, type ChatScrollState } from "./chat-scroll";

/** A long transcript, 2000px of content in a 600px viewport. */
const node = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 600 });
const turns = "e1:completed:回答:|e2:completed:回答:";

describe("transcriptSignature", () => {
  it("changes when the optimistic user bubble appears, before the server knows the turn", () => {
    expect(transcriptSignature(turns, null)).toBe(turns);
    expect(transcriptSignature(turns, { text: "新消息" })).not.toBe(turns);
    expect(transcriptSignature(turns, { text: "新消息", executionId: "e3" })).not.toBe(transcriptSignature(turns, { text: "新消息" }));
  });

  it("stays unknown until the transcript has loaded", () => {
    expect(transcriptSignature(undefined, { text: "新消息" })).toBeUndefined();
  });
});

describe("followTranscript", () => {
  const atBottom: ChatScrollState = { key: "k", follow: true, signature: turns };

  it("scrolls to the new bubble after a send at the bottom of a long conversation", () => {
    // Content grew by the bubble; the view was at the old bottom.
    const view = { scrollTop: 1400, scrollHeight: 2120, clientHeight: 600 };
    const next = followTranscript(view, atBottom, "k", transcriptSignature(turns, { text: "新消息" })!, () => null);
    expect(view.scrollTop).toBe(2120);
    expect(next.signature).toContain("outgoing:");
    expect(next.follow).toBe(true);
  });

  it("does not jump when the user has scrolled up", () => {
    const view = node(300);
    const next = followTranscript(view, { ...atBottom, follow: false }, "k", transcriptSignature(turns, { text: "新消息" })!, () => null);
    expect(view.scrollTop).toBe(300);
    expect(next.follow).toBe(false);
  });

  it("does nothing when nothing on screen changed", () => {
    const view = node(500);
    expect(followTranscript(view, atBottom, "k", turns, () => null)).toBe(atBottom);
    expect(view.scrollTop).toBe(500);
  });

  it("restores the saved position on entering a transcript, or starts at the latest message", () => {
    const restored = node(0);
    expect(followTranscript(restored, { key: "", follow: true, signature: "" }, "k", turns, () => "250")).toEqual(
      { key: "k", follow: false, signature: turns });
    expect(restored.scrollTop).toBe(250);
    const fresh = node(0);
    expect(followTranscript(fresh, { key: "", follow: true, signature: "" }, "k", turns, () => null).follow).toBe(true);
    expect(fresh.scrollTop).toBe(2000);
  });
});

describe("isNearBottom", () => {
  it("follows only within the threshold of the bottom", () => {
    expect(isNearBottom(node(1400))).toBe(true);
    expect(isNearBottom(node(1321))).toBe(true);
    expect(isNearBottom(node(1320))).toBe(false);
    expect(isNearBottom(node(0))).toBe(false);
  });
});
