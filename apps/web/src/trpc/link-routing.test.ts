/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { trpcLinkKind } from "./link-routing";

describe("trpcLinkKind", () => {
  it("streams the long-running turn procedures", () => {
    for (const path of ["opc.mentorTurnStream", "runtime.executeStream", "runtime.resumeStream", "fusionCompare.stream"])
      expect(trpcLinkKind(path)).toBe("stream");
  });
  it("sends the polled history and the sidebar conversation list on their own", () => {
    expect(trpcLinkKind("runtime.view")).toBe("single");
    expect(trpcLinkKind("opc.conversations")).toBe("single");
  });
  it("batches every other call", () => {
    for (const path of ["opc.read", "opc.library", "credits.getBalance", "research.cards", "runtime.viewer"])
      expect(trpcLinkKind(path)).toBe("batch");
  });
});
