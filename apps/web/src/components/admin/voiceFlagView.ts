/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** VOICE admin view helpers; the server re-checks every save. */
const ERRORS: Record<string, string> = {
  VOICE_FLAG_UNAVAILABLE: '暂时无法读取或保存这个设置，请稍后再试。',
  VOICE_FLAG_MODULE_NOT_FOUND: '找不到这个功能模块，可能已被删除，请刷新页面。',
  VOICE_FLAG_CONFLICT: '这个模块在你打开窗口后被改过（可能是这个设置，也可能是其他内容）。请关闭窗口重新打开，看到最新内容后再保存。',
};

/** Plain text for the stable codes; never the raw code or server text. */
export function voiceFlagErrorText(error: unknown) {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : ERRORS.VOICE_FLAG_UNAVAILABLE;
}

export function voiceFlagSavedText(on: boolean) {
  return on ? '已保存：用户开着“使用我的文风”时，这个 Skill 写稿会带上他确认过的文风画像。' : '已保存：这个 Skill 不再使用用户文风。';
}
