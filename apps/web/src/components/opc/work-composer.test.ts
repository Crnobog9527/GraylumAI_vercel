/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from "vitest";
import { sendKeepingFocus } from "./work-composer";

it("sends first, then returns the caret to the message box", () => {
  const order: string[] = [];
  const box = { focus: vi.fn(() => order.push("focus")) };
  sendKeepingFocus(() => order.push("send"), box);
  expect(order).toEqual(["send", "focus"]);
  expect(box.focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("still sends without a mounted box", () => {
  const send = vi.fn();
  sendKeepingFocus(send, null);
  expect(send).toHaveBeenCalled();
});
