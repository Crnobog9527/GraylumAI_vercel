/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { expect, it } from "vitest";
import {
  COMPOSER_REFERENCES_ENABLED, findReferenceQuery, LibraryReferenceNode, mergeReferences, referenceRequest, referencesIn, referencesNamedIn, sameReferences,
} from "./composer-references";
import { docToText, textToDoc } from "./composer-text";
import { matchingDocuments, referenceFor } from "./reference-menu";

const schema = getSchema([Document, Paragraph, Text, LibraryReferenceNode]);
const ref = (documentId: string, label: string) => schema.nodes.libraryReference.create({ documentId, version: 2, label });
const paragraph = (...content: Parameters<typeof schema.nodes.paragraph.create>[1][]) =>
  schema.nodes.paragraph.create(null, content.flat() as never);

/** State with the caret at the end of a single paragraph holding `text`. */
function typed(text: string) {
  const doc = schema.nodes.doc.create(null, paragraph(text ? schema.text(text) : []));
  return EditorState.create({ doc, selection: TextSelection.atEnd(doc) });
}

it("is off unless the public switch says on", () => {
  expect(COMPOSER_REFERENCES_ENABLED).toBe(false);
});

it("finds the @ query at a line start or after Chinese text, but not inside an e-mail address", () => {
  expect(findReferenceQuery(typed("@"))).toEqual({ from: 1, to: 2, query: "" });
  expect(findReferenceQuery(typed("参考@周报"))).toEqual({ from: 3, to: 6, query: "周报" });
  expect(findReferenceQuery(typed("看 @a"))?.query).toBe("a");
  expect(findReferenceQuery(typed("me@example"))).toBeNull();
  expect(findReferenceQuery(typed("@周报 后面"))).toBeNull();
  expect(findReferenceQuery(typed("没有符号"))).toBeNull();
});

it("does not reopen the query on a reference that was already inserted", () => {
  const doc = schema.nodes.doc.create(null, paragraph([schema.text("看"), ref("d1", "周报")]));
  expect(findReferenceQuery(EditorState.create({ doc, selection: TextSelection.atEnd(doc) }))).toBeNull();
});

it("keeps references apart from the text, each document once, and reads them as @名称 in the text", () => {
  const doc = schema.nodes.doc.create(null, [
    paragraph([schema.text("对比"), ref("d1", "周报.md"), schema.text("和"), ref("d2", "月报.pdf")]),
    paragraph([ref("d1", "周报.md")]),
  ]);
  expect(referencesIn(doc)).toEqual([
    { documentId: "d1", version: 2, label: "周报.md" },
    { documentId: "d2", version: 2, label: "月报.pdf" },
  ]);
  expect(docToText(doc)).toBe("对比@周报.md和@月报.pdf\n@周报.md");
});

it("offers only ready text documents whose name matches, at most eight", () => {
  const item = (id: string, filename: string | null, extra: Partial<{ kind: string; status: string }> = {}) =>
    ({ id, filename, kind: "document", status: "ready", content_version: 3, ...extra });
  const documents = [
    item("a", "周报 第1周.md"), item("b", "周报.png", { kind: "image" }), item("c", "周报草稿.docx", { status: "processing" }),
    item("d", "月报.pdf"), item("e", null), ...Array.from({ length: 10 }, (_, n) => item("z" + n, "Weekly 周报 " + n)),
  ];
  expect(matchingDocuments(documents, "周报").map(d => d.id)).toEqual(["a", "z0", "z1", "z2", "z3", "z4", "z5", "z6"]);
  expect(matchingDocuments(documents, "WEEKLY").length).toBe(8);
  expect(matchingDocuments(documents, "").map(d => d.id).slice(0, 3)).toEqual(["a", "d", "e"]);
  expect(referenceFor(item("e", null))).toEqual({ documentId: "e", version: 3, label: "未命名文档" });
});

// UI-B wiring: a value the page sets (restored draft, failed send) gets its references back.
it("turns each @名称 of a known reference back into that reference, and reads back as the same text", () => {
  const weekly = { documentId: "d1", version: 2, label: "周报 (v1).md" };
  const monthly = { documentId: "d2", version: 7, label: "月报" };
  const text = "对比@周报 (v1).md和 @月报\n\n@月报汇总 不是 @别的";
  const doc = schema.nodeFromJSON(textToDoc(text, [weekly, monthly]));
  // "@月报汇总" also starts with a known name: it is that reference followed by text, as the box showed it.
  expect(referencesIn(doc)).toEqual([weekly, monthly]);
  expect(docToText(doc)).toBe(text);
  expect(schema.nodeFromJSON(textToDoc(text)).toJSON()).toEqual(schema.nodeFromJSON(textToDoc(text, [])).toJSON());
  expect(referencesIn(schema.nodeFromJSON(textToDoc(text)))).toEqual([]);
});

it("restores two documents with the same name in their order", () => {
  const a = { documentId: "a", version: 1, label: "笔记" }, b = { documentId: "b", version: 1, label: "笔记" };
  const doc = schema.nodeFromJSON(textToDoc("@笔记 和 @笔记", [a, b]));
  expect(referencesIn(doc)).toEqual([a, b]);
});

it("sends only id and version, compares versions too, and merges failed-send references first", () => {
  const a = { documentId: "a", version: 1, label: "甲" }, b = { documentId: "b", version: 2, label: "乙" };
  expect(referenceRequest([a, b])).toEqual([
    { kind: "library_document", documentId: "a", version: 1 }, { kind: "library_document", documentId: "b", version: 2 },
  ]);
  expect(sameReferences([a], [{ ...a, label: "改名" }])).toBe(true);
  expect(sameReferences([a], [{ ...a, version: 2 }])).toBe(false);
  expect(sameReferences([a, b], [b, a])).toBe(false);
  expect(mergeReferences([b], [a, { ...b, version: 9 }])).toEqual([b, a]);
  // Two valid sets never add up past the server's limit of five.
  const many = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => ({ documentId: prefix + n, version: 1, label: prefix + n }));
  expect(mergeReferences(many("p", 5), many("q", 3)).map(item => item.documentId)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  expect(mergeReferences(many("p", 3), many("q", 4)).map(item => item.documentId)).toEqual(["p0", "p1", "p2", "q0", "q1"]);
});

it("keeps only the references the text still names, so a stale stored list never rides along", () => {
  const a = { documentId: "a", version: 1, label: "甲.md" }, b = { documentId: "b", version: 1, label: "乙.md" };
  expect(referencesNamedIn("看 @甲.md 然后", [a, b])).toEqual([a]);
  expect(referencesNamedIn("改过了，不再提文档", [a, b])).toEqual([]);
});
