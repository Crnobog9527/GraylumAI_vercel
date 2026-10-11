/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** POSITIONING-GATE admin view helpers; the server re-checks every save. */
const ERRORS: Record<string, string> = {
  SOCIAL_MEDIA_FLAG_UNAVAILABLE: '暂时无法读取或保存这个设置，请稍后再试。',
  SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND: '找不到这个功能模块，可能已被删除，请刷新页面。',
  SOCIAL_MEDIA_FLAG_CONFLICT: '这个设置刚被其他人改过。请点“重新读取”看最新设置，再决定是否保存。',
};

/** Plain text for the stable codes; never the raw code or server text. */
export function socialMediaFlagErrorText(error: unknown) {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : ERRORS.SOCIAL_MEDIA_FLAG_UNAVAILABLE;
}

export function isSocialMediaFlagConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'message' in error && error.message === 'SOCIAL_MEDIA_FLAG_CONFLICT');
}

export function socialMediaFlagSavedText(on: boolean) {
  return on ? '已保存：还没有确认定位的用户不能使用这个 Skill，会先被引导去做定位或导入已有定位。'
    : '已保存：这个 Skill 不再要求用户先有定位。';
}
