/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Whether a failed step confirmation was provably rejected, so its retained request may be released. */
export function isDefiniteConfirmConflict(cause: unknown) {
  if (!(cause instanceof Error)) return false;
  const data = "data" in cause ? cause.data : undefined;
  // workbench.execute translates internal errors into public messages. Its
  // structured CONFLICT response proves a rejected transaction; a timeout,
  // missing response or another route does not. Keep unknown requests frozen.
  if (
    data && typeof data === "object" &&
    "code" in data && data.code === "CONFLICT" &&
    "path" in data && data.path === "workbench.execute"
  ) return true;
  return [
    "OPC_INFORMATION_CONFLICT",
    "ARTIFACT_VERSION_CONFLICT",
    "ARTIFACT_REVIEW_REQUIRED",
  ].some((code) => cause.message.includes(code));
}
