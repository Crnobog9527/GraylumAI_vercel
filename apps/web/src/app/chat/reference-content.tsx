/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Display only the permission-filtered evidence returned by the server.
// Provider text never becomes HTML, an instruction or an automatic network fetch.
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function sourceLink(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch { /* Missing or unsafe links remain plain evidence. */ }
}
export function ReferenceContent({ payload }: { payload: unknown }) {
  const p = record(payload), result = record(p.result);
  if (typeof p.text === "string")
    return <p className="whitespace-pre-wrap break-words">{p.text}</p>;
  if (p.projection !== "research-result" || !Array.isArray(result.objects))
    return <p>已保存的参考资料</p>;
  return <div className="space-y-3">
    <p className="text-xs text-[var(--text-tertiary)]">
      {result.fixture === true ? "模拟检索资料 · 用于本地测试" : "外部检索资料"}
      {text(result.fetchedAt) && ` · 获取于 ${text(result.fetchedAt)}`}
    </p>
    {result.objects.slice(0, 100).map((item, index) => {
      const object = record(item), fields = record(object.fields);
      const link = sourceLink(object.sourceUrl);
      return <article key={index} className="space-y-1 border-l border-[var(--border-primary)] pl-3">
        <p className="font-medium">{text(fields.title) || text(fields.display_name) || text(fields.username) || `资料 ${index + 1}`}</p>
        <p className="whitespace-pre-wrap break-words">{text(fields.summary) || text(fields.full_text) || text(fields.description) || "此条结果未提供摘要。"}</p>
        {text(fields.created_at) && <p className="text-xs">发布时间：{text(fields.created_at)}</p>}
        {link ? <a className="underline" href={link} target="_blank" rel="noopener noreferrer">查看原始来源</a> : <p className="text-xs">供应商未提供原始来源链接</p>}
        {Array.isArray(object.missingFields) && object.missingFields.length > 0 && <p className="text-xs">部分信息未提供，请结合其他资料核对。</p>}
      </article>;
    })}
    {record(result.pagination).complete === false && <p className="text-xs">仅展示已取得的部分结果。</p>}
    <p className="text-xs text-[var(--text-tertiary)]">检索资料不等于已核实的结论。</p>
  </div>;
}
