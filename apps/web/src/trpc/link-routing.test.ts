/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { trpcLinkKind } from "./link-routing";

describe("trpcLinkKind", () => {
  it("sends the polled history and the sidebar conversation list on their own", () => {
    expect(trpcLinkKind("runtime.view")).toBe("single");
    expect(trpcLinkKind("opc.conversations")).toBe("single");
  });
  it("keeps the slow composer and compare-picker reads out of the batch that the first content waits for", () => {
    for (const path of ["runtime.choices", "opc.catalog", "fusionCompare.options"]) expect(trpcLinkKind(path)).toBe("slow");
  });
  it("batches every other call", () => {
    for (const path of ["opc.read", "opc.library", "opc.list", "user.getUserProfile", "credits.getBalance", "research.cards", "runtime.viewer",
      "fusionCompare.turnList", "runtime.choicesX", "opc.catalogue"])
      expect(trpcLinkKind(path)).toBe("batch");
  });
});
