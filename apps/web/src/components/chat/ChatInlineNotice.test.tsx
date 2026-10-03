/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CHAT_ACTION, ChatInlineNotice, ChatNoticeList, ChatPendingStatus, pendingSendLabel, uniqueNotices } from "./ChatInlineNotice";

describe("ChatInlineNotice", () => {
  it("renders an error as an alert and every other tone as a status", () => {
    const error = renderToStaticMarkup(createElement(ChatInlineNotice, { tone: "error", children: "失败了" }));
    expect(error).toContain('role="alert"');
    expect(error).toContain('data-chat-notice="error"');
    for (const tone of ["status", "warning", "success"] as const)
      expect(renderToStaticMarkup(createElement(ChatInlineNotice, { tone, children: "x" }))).toContain('role="status"');
  });

  it("renders its actions as buttons with the given labels and an accessible name", () => {
    const html = renderToStaticMarkup(createElement(ChatInlineNotice, {
      tone: "warning", label: "恢复提示", children: "待重试",
      actions: [{ label: CHAT_ACTION.retry, onClick: vi.fn() }, { label: CHAT_ACTION.stop, onClick: vi.fn(), disabled: true }],
    }));
    expect(html).toContain('aria-label="恢复提示"');
    expect(html).toMatch(/<button type="button">重试<\/button>/);
    expect(html).toMatch(/<button type="button" disabled="">停止<\/button>/);
  });

  it("uses only the two shared action names", () => {
    expect(CHAT_ACTION).toEqual({ retry: "重试", stop: "停止" });
  });
});

describe("uniqueNotices / ChatNoticeList", () => {
  it("drops empty entries and shows one text once", () => {
    const shown = uniqueNotices([
      null, false, undefined, "",
      { id: "a", tone: "warning", text: "达到长度上限" },
      { id: "b", tone: "error", text: "达到长度上限" },
      { id: "c", tone: "status", text: "" },
      { id: "d", tone: "error", text: "网络错误" },
    ]);
    expect(shown.map(notice => notice.id)).toEqual(["a", "d"]);
  });

  it("renders nothing without notices, and the notices in order otherwise", () => {
    expect(renderToStaticMarkup(createElement(ChatNoticeList, { notices: [null] }))).toBe("");
    const html = renderToStaticMarkup(createElement(ChatNoticeList, { notices: [
      { id: "1", tone: "status", text: "第一条", busy: true }, { id: "2", tone: "error", text: "第二条" }] }));
    expect(html.indexOf("第一条")).toBeLessThan(html.indexOf("第二条"));
    expect(html).toContain("data-chat-notices");
  });
});

describe("pending send status", () => {
  it("matches the mentor wording on every chat page", () => {
    expect(pendingSendLabel(true)).toBe("发送中 · 等待服务器确认");
    expect(pendingSendLabel(false)).toBe("尚未确认保存 · 原请求已保留");
    expect(renderToStaticMarkup(createElement(ChatPendingStatus, { sending: true }))).toContain('role="status"');
  });
});
