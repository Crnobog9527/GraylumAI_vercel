/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
type QueryError = { message?: string; data?: { code?: string } | null };
export function workspaceErrorMessage(error: QueryError | null | undefined): string {
  switch (error?.data?.code) {
    case 'UNAUTHORIZED': return '登录已失效，请重新登录后重试。';
    // Another account's link and a missing item get the same reply on purpose.
    case 'NOT_FOUND': return '找不到这项内容，或你没有查看权限。请确认链接是否正确，或使用自己账号下的内容。';
    case 'FORBIDDEN':
    case 'PRECONDITION_FAILED':
    case 'SERVICE_UNAVAILABLE': return error.message || '当前工作空间暂不可用，请稍后重试。';
    default: {
      const diagnostic = error?.message?.match(/诊断编号：[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
      return '读取失败，请重试；现有资料不会因此消失。' + (diagnostic ? `（${diagnostic}）` : '');
    }
  }
}
export function QueryNotice({ error, loading, label, retry }: {
  error?: QueryError | null; loading?: boolean; label: string; retry: () => unknown;
}) {
  if (error) return <p role="alert">{label}：{workspaceErrorMessage(error)} <button type="button" onClick={() => { void retry(); }}>重试</button></p>;
  if (loading) return <p role="status">正在读取{label}…</p>;
  return null;
}
