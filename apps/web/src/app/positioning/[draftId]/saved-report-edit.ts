/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Editing a saved formal report (Owner 2026-10-20: "评审订后允许编辑"). A version made by adopting a jury revision has
 * no report generation behind it, so it cannot use the report document (save / 定稿). Its edit goes through R14, which
 * already guards the source version, the body and the request: propose the edited text, then apply it as a new formal
 * version. Pure helpers here (no React) so the rules are testable.
 *
 * The text being edited is kept in this browser only (the database is not touched until 定稿): per project and per
 * source version, every read and write guarded. Another device does not see it.
 */
export const SAVED_EDIT_TEXT = {
  edit: "修改报告",
  save: "定稿",
  cancel: "取消修改",
  ask: "定稿后会生成一个新的正式定位版本，原来的版本不再是当前版本。确定定稿吗？",
  confirm: "确定定稿",
  back: "再想想",
  done: "已生成新的正式版本。",
  restored: "已恢复你上次没有定稿的修改（保存在这台设备上，换设备看不到）。",
  closeUnsaved: "报告的修改还没有定稿，关闭后会丢失。确定关闭吗？",
  stale: "这份报告已经有了更新的版本，当前的修改不能再定稿，已清除本机草稿。请刷新页面查看最新版本。",
} as const;

const PREFIX = "graylum:saved-report-draft:";
export const draftKey = (projectId: string, versionId: string) => `${PREFIX}${projectId}:${versionId}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const store = (): Store | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };

export function readDraft(projectId: string, versionId: string, storage: Store | null = store()): string | null {
  try { return storage?.getItem(draftKey(projectId, versionId)) ?? null; } catch { return null; }
}
export function writeDraft(projectId: string, versionId: string, text: string, storage: Store | null = store()): void {
  try { storage?.setItem(draftKey(projectId, versionId), text); } catch { /* storage full or blocked: the edit stays in the page */ }
}
export function clearDraft(projectId: string, versionId: string, storage: Store | null = store()): void {
  try { storage?.removeItem(draftKey(projectId, versionId)); } catch { /* nothing to clear */ }
}
/** A draft of an older source version can never be finalized: remove every draft of this project but the current one's. */
export function clearStaleDrafts(projectId: string, currentVersionId: string, storage: Store | null = store()): void {
  try {
    if (!storage) return;
    const keep = draftKey(projectId, currentVersionId), own = `${PREFIX}${projectId}:`;
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key && key.startsWith(own) && key !== keep) stale.push(key); }
    for (const key of stale) storage.removeItem(key);
  } catch { /* storage unavailable */ }
}

const errors: Record<string, string> = {
  REPORT_AUTH_REQUIRED: "登录状态需要重新验证，请重新登录后再试。你的修改仍保留在编辑框里。",
  REPORT_REVISION_DENIED: "这份报告现在不能修改。",
  REPORT_REVISION_UNSUPPORTED: "这份报告暂不支持直接修改。",
  REPORT_REVISION_INVALID: "修改内容不符合要求，没有保存。",
  REPORT_NOT_COMPLETE: "改过的报告不完整（缺少报告要求的章节标题或内容），不能定稿。你的修改仍保留在编辑框里。",
  REPORT_REQUEST_CONFLICT: "这次提交和之前的一次请求冲突，没有生效。请重新操作。",
  REPORT_REVISION_DECIDED: "这次修改已经处理过了，请刷新页面。",
  CONTENT_ERASED: "这份报告的内容已删除。",
};
/** The source version is no longer the current one: the draft can never be finalized. */
const STALE = new Set(["REPORT_REVISION_STALE", "REPORT_SOURCE_CONFLICT"]);
export const SAVED_EDIT_UNAVAILABLE = "暂时无法完成，结果还没有确认。你的修改仍保留，可以稍后再点一次，不会重复定稿。";

/** Fixed text for a refused or lost 定稿; server text is never shown. `stale`: clear the local draft. */
export function savedEditError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  if (STALE.has(code)) return { code, text: SAVED_EDIT_TEXT.stale, known: true, stale: true };
  const known = Object.hasOwn(errors, code);
  return { code, text: known ? errors[code]! : SAVED_EDIT_UNAVAILABLE, known, stale: false };
}
