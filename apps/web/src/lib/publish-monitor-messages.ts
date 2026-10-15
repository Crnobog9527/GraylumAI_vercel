/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** PUBLISH-MONITOR connect page: fixed, readable texts for each refusal code (never raw server text). */
const MESSAGES: Record<string, string> = {
  PUBLISH_MONITOR_REQUEST_INVALID: '这次连接已失效（超时、已处理，或不是在这个浏览器里发起的），请回到账号页重新连接。',
  PUBLISH_MONITOR_AUTHORIZATION_CHANGED: '这个账号的授权在确认前发生了变化，请重新连接一次。',
  PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE: '这个社媒账号已被其他 Graylum 用户连接。请联系对方，或换一个账号。',
  PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE: '这个社媒账号已经挂在你的另一个品牌账号下，不能重复挂。',
  PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED: '这个品牌账号已经连接了另一个社媒账号，请先断开再连接。',
  PUBLISH_MONITOR_ENTITLEMENT_REQUIRED: '连接社媒账号读取作品数据需要会员；一键发布需要对应会员权益。',
  PUBLISH_MONITOR_DISABLED: '这个功能还没有开放。',
  PUBLISH_MONITOR_ACCOUNT_CLOSED: '账号已注销或停用，不能连接。',
  PUBLISH_MONITOR_PROVIDER_BUSY: '连接服务繁忙，请稍后再试。',
  PUBLISH_MONITOR_PLATFORM_UNSUPPORTED: '这个平台暂不支持连接。',
  LOGIN_REQUIRED: '请先登录。',
  MAINTENANCE: '系统维护中，请稍后再试。',
};
export function connectErrorMessage(code: string | null | undefined): string {
  return (code && MESSAGES[code]) || '连接暂时没有完成，请稍后重试。';
}
