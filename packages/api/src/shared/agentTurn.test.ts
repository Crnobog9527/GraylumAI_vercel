/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { readMentorTurn } from "@/app/positioning/[draftId]/mentor-response";
import {
  AGENT_TURN_BODY_LIMIT,
  AGENT_TURN_FORMAT,
  AGENT_TURN_MESSAGE_LIMIT,
  INVALID_REPLY_NOTICE,
  LEGACY_MESSAGE_LIMIT,
  MAX_OPTIONS,
  agentTurnBody,
  parseQuestionCard,
  questionCardSchema,
  readAgentTurnBody,
  type AgentTurnEvent,
} from "./agentTurn";

const card = { question: "你现在主要在哪个平台发内容？", options: ["小红书", "抖音", "还没开始"] };

describe("question card", () => {
  it("accepts one question with 2 to 5 distinct options and trims them", () => {
    expect(parseQuestionCard({ question: "  问题  ", options: [" A ", "B"] })).toEqual({ question: "问题", options: ["A", "B"] });
    expect(parseQuestionCard({ question: "问题", options: ["1", "2", "3", "4", "5"] })?.options).toHaveLength(MAX_OPTIONS);
  });

  it.each([
    ["one option", { question: "问题", options: ["A"] }],
    ["six options", { question: "问题", options: ["1", "2", "3", "4", "5", "6"] }],
    ["duplicate after trim", { question: "问题", options: ["A", " A "] }],
    ["empty question", { question: "   ", options: ["A", "B"] }],
    ["empty option", { question: "问题", options: ["A", " "] }],
    ["long question", { question: "问".repeat(501), options: ["A", "B"] }],
    ["long option", { question: "问题", options: ["A", "项".repeat(201)] }],
    ["control character", { question: "问\u0007题", options: ["A", "B"] }],
    ["extra field", { question: "问题", options: ["A", "B"], allowFreeText: true }],
    ["unsure option is host UI, but a model may still not add unknown fields", { question: "问题", options: ["A", "B"], unsure: true }],
    ["not an object", "问题"],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(parseQuestionCard(value)).toBeNull();
    expect(questionCardSchema.safeParse(value).success).toBe(false);
  });

  it("allows line breaks inside a question", () => {
    expect(parseQuestionCard({ question: "第一行\n第二行", options: ["A", "B"] })?.question).toBe("第一行\n第二行");
  });
});

describe("stored reply body", () => {
  it("round-trips a new-format body with and without a card", () => {
    const withCard = agentTurnBody("  先说说你的情况。  ", card);
    expect(JSON.parse(withCard)).toEqual({ format: AGENT_TURN_FORMAT, message: "先说说你的情况。", card });
    expect(readAgentTurnBody(withCard)).toEqual({ kind: "envelope", message: "先说说你的情况。", card, truncated: false });
    expect(readAgentTurnBody(agentTurnBody("只有文字", null))).toEqual({ kind: "envelope", message: "只有文字", card: null, truncated: false });
    expect(readAgentTurnBody(agentTurnBody("", card))).toEqual({ kind: "envelope", message: "", card, truncated: false });
  });

  it("refuses to build an empty, over-long or invalid body", () => {
    expect(() => agentTurnBody("  ", null)).toThrow("AGENT_TURN_BODY_EMPTY");
    expect(() => agentTurnBody("字".repeat(AGENT_TURN_MESSAGE_LIMIT + 1), null)).toThrow();
    expect(() => agentTurnBody("文字", { question: "问题", options: ["A"] })).toThrow();
  });

  it("drops an invalid stored card but keeps its message", () => {
    const raw = JSON.stringify({ format: AGENT_TURN_FORMAT, message: "文字", card: { question: "问题", options: ["A"] } });
    expect(readAgentTurnBody(raw)).toEqual({ kind: "envelope", message: "文字", card: null, truncated: false });
    const emptyWithBadCard = JSON.stringify({ format: AGENT_TURN_FORMAT, message: " ", card: "x" });
    expect(readAgentTurnBody(emptyWithBadCard).kind).toBe("invalid");
  });

  it("ignores unknown envelope fields", () => {
    const raw = JSON.stringify({ format: AGENT_TURN_FORMAT, message: "文字", card: null, reasoning: "私有", informationPatch: { x: 1 } });
    expect(readAgentTurnBody(raw)).toEqual({ kind: "envelope", message: "文字", card: null, truncated: false });
  });

  it("reads the legacy JSON mentor protocol as its message only", () => {
    const raw = JSON.stringify({ message: " 旧协议回复 ", inputKind: "answer", informationPatch: { lane: { value: "美食" } } });
    expect(readAgentTurnBody(raw)).toEqual({ kind: "legacy_json", message: "旧协议回复", card: null, truncated: false });
    // A legacy object never yields a card, even one that looks valid.
    expect(readAgentTurnBody(JSON.stringify({ message: "旧", card })).card).toBeNull();
  });

  it("reads legacy plain text", () => {
    expect(readAgentTurnBody("  直接写的回复\n第二行 ")).toEqual({ kind: "plain", message: "直接写的回复\n第二行", card: null, truncated: false });
    expect(readAgentTurnBody('"带引号的旧回复"').kind).toBe("plain");
  });

  it.each([
    ["empty string", "", "empty"],
    ["whitespace", "  \n ", "empty"],
    ["null", null, "empty"],
    ["undefined", undefined, "empty"],
    ["broken JSON", '{"message":"半', "invalid"],
    ["code fence", "```json\n{}\n```", "invalid"],
    ["JSON array", "[1,2]", "invalid"],
    ["object without message", JSON.stringify({ inputKind: "answer" }), "invalid"],
    ["object with empty message", JSON.stringify({ message: "  " }), "invalid"],
    ["object with non-string message", JSON.stringify({ message: 3 }), "invalid"],
  ] as const)("classifies %s", (_name, raw, kind) => {
    expect(readAgentTurnBody(raw)).toEqual({ kind, message: "", card: null, truncated: false });
  });

  it("marks and cuts over-long messages at their display limits", () => {
    const plain = readAgentTurnBody("字".repeat(AGENT_TURN_MESSAGE_LIMIT + 5));
    expect(plain).toMatchObject({ kind: "plain", truncated: true });
    expect(plain.message).toHaveLength(AGENT_TURN_MESSAGE_LIMIT);
    const legacy = readAgentTurnBody(JSON.stringify({ message: "字".repeat(LEGACY_MESSAGE_LIMIT + 5) }));
    expect(legacy).toMatchObject({ kind: "legacy_json", truncated: true });
    expect(legacy.message).toHaveLength(LEGACY_MESSAGE_LIMIT);
    const envelope = readAgentTurnBody(JSON.stringify({ format: AGENT_TURN_FORMAT, message: "字".repeat(AGENT_TURN_MESSAGE_LIMIT + 5), card: null }));
    expect(envelope).toMatchObject({ kind: "envelope", truncated: true });
    expect(envelope.message).toHaveLength(AGENT_TURN_MESSAGE_LIMIT);
  });

  it("does not parse a body above the size limit", () => {
    const raw = JSON.stringify({ format: AGENT_TURN_FORMAT, message: "x".repeat(AGENT_TURN_BODY_LIMIT), card: null });
    expect(readAgentTurnBody(raw)).toEqual({ kind: "oversized", message: "", card: null, truncated: false });
  });
});

describe("compatibility with the existing mentor parser", () => {
  it("the legacy parser still shows the text of a new-format body", () => {
    const turn = readMentorTurn(agentTurnBody("新格式回复", card), new Set(["lane"]));
    expect(turn.message).toBe("新格式回复");
    expect(turn.informationPatch).toEqual({});
  });

  it.each([
    JSON.stringify({ message: "旧协议", inputKind: "request" }),
    "直接写的回复",
    '{"message":"半',
    "[1]",
    JSON.stringify({ inputKind: "answer" }),
  ])("agrees with the legacy parser on %s", raw => {
    const legacy = readMentorTurn(raw, new Set());
    const current = readAgentTurnBody(raw);
    if (current.kind === "invalid") expect(legacy.message).toBe(INVALID_REPLY_NOTICE);
    else expect(current.message).toBe(legacy.message);
  });
});

describe("event contract", () => {
  it("covers the documented event order", () => {
    const events: AgentTurnEvent[] = [
      { type: "admitted", executionId: "00000000-0000-4000-8000-000000000001" },
      { type: "phase", phase: "mentor" },
      { type: "text", text: "先" },
      { type: "text", text: "先说说" },
      { type: "card", card },
      { type: "phase", phase: "saving" },
      { type: "result", result: { state: "completed", body: agentTurnBody("先说说", card) } },
    ];
    expect(events.map(event => event.type)).toEqual(["admitted", "phase", "text", "text", "card", "phase", "result"]);
  });
});
