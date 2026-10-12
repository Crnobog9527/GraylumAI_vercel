/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { expect, it } from "vitest";
import { docToText, fitText, textToDoc, textToSlice } from "./composer-text";

const schema = getSchema([Document, Paragraph, Text]);
const roundTrip = (text: string) => docToText(schema.nodeFromJSON(textToDoc(text)));

it("keeps every line, blank lines and spaces when converting to the editor and back", () => {
  for (const text of ["", "一行", "第一行\n第二行", "a\n\n\nb", "\n开头空行", "结尾空行\n", "  缩进  \n\t制表"]) {
    expect(roundTrip(text)).toBe(text);
  }
});

it("normalizes Windows and old Mac line endings to one newline", () => {
  expect(roundTrip("a\r\nb\rc")).toBe("a\nb\nc");
});

it("trims to the room left by UTF-16 length without splitting an emoji", () => {
  expect(fitText("abcdef", 4)).toBe("abcd");
  expect(fitText("abc", 10)).toBe("abc");
  expect(fitText("abc", 0)).toBe("");
  expect(fitText("ab😀c", 3)).toBe("ab");
  expect(fitText("ab😀c", 4)).toBe("ab😀");
});

it("pastes multi-line text as open paragraphs that keep blank lines", () => {
  const slice = textToSlice(schema, "上\n\n下");
  expect(slice.openStart).toBe(1);
  expect(slice.openEnd).toBe(1);
  expect(slice.content.childCount).toBe(3);
  expect(slice.content.textBetween(0, slice.content.size, "\n")).toBe("上\n\n下");
});
