interface StatQuery<T> {
  data?: T | null;
  isError?: boolean;
}

// 统计数字只在真正读到后显示；读取中显示省略号，失败显示"读取失败"，不用 0 冒充。
export function summaryStat<T>(query: StatQuery<T>, pick: (data: T) => number | null | undefined): string {
  const value = query.data ? pick(query.data) : undefined;
  if (typeof value === 'number') return value.toLocaleString();
  return query.isError ? '读取失败' : '…';
}
