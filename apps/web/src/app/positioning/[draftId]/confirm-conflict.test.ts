/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { isDefiniteConfirmConflict } from "./confirm-conflict";

describe("isDefiniteConfirmConflict", () => {
  it("accepts the structured workbench.execute CONFLICT and the known rejection codes", () => {
    expect(isDefiniteConfirmConflict(Object.assign(new Error("x"), { data: { code: "CONFLICT", path: "workbench.execute" } }))).toBe(true);
    expect(isDefiniteConfirmConflict(new Error("ARTIFACT_VERSION_CONFLICT"))).toBe(true);
  });

  it("keeps timeouts, other routes and non-errors frozen", () => {
    expect(isDefiniteConfirmConflict(new Error("timeout"))).toBe(false);
    expect(isDefiniteConfirmConflict(Object.assign(new Error("x"), { data: { code: "CONFLICT", path: "other.route" } }))).toBe(false);
    expect(isDefiniteConfirmConflict("OPC_INFORMATION_CONFLICT")).toBe(false);
  });
});
