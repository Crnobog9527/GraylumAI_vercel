'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';
import { MAX_ROWS_PER_CALL } from '@repo/api/src/services/publishMonitor/manualImport';
import { FIELDS, buildRows, suggestMapping, type Field, type Mapping } from '@/lib/publish-monitor/table-import/mapping';
import { TableImportError, parseTable, type Grid } from '@/lib/publish-monitor/table-import/table';
import type { Brand } from './brands';
import { dataErrorMessage, errorCode, metricLabel, platformName } from './labels';

/**
 * PUBLISH-MONITOR PR-7 (plan §4.3, §9 item 6): import numbers from a platform's exported table. The file is read in
 * the browser; the user checks and corrects the column mapping, sees every row that will be written and every row
 * that will not, and only then confirms. Nothing is written before that. Screenshot import is a later task (PR-3c).
 */
const FIELD_LABEL: Record<string, string> = { postId: '作品编号', url: '作品链接', postedAt: '发布时间', title: '标题' };
const fieldLabel = (field: Field) => FIELD_LABEL[field] ?? metricLabel(field);

const TABLE_ERRORS: Record<string, string> = {
  TABLE_EMPTY: '表格是空的。', TABLE_TOO_LARGE: '文件太大（最大 5MB）。', TABLE_TOO_MANY_ROWS: '行数太多（最多 1,000 行）。',
  TABLE_TOO_MANY_COLUMNS: '列数太多（最多 50 列）。', TABLE_CELL_TOO_LONG: '有单元格内容太长。',
  TABLE_ENCODING: '读不出文字编码，请另存为 UTF-8 的 CSV 再试。', TABLE_MALFORMED: '文件格式有问题，请重新导出。',
  TABLE_FORMAT_UNSUPPORTED: '只支持 CSV 和 XLSX 文件。',
};
const ROW_ERRORS: Record<string, string> = {
  POST_KEY_MISSING: '没有作品编号或链接', POST_KEY_TOO_LONG: '作品编号太长', NUMBER_INVALID: '数字读不出来',
  DATE_INVALID: '日期读不出来', URL_INVALID: '链接不是公开的 https 地址', METRICS_EMPTY: '没有任何数据列',
};

export function ManualImport({ brands, onImported }: { brands: Brand[]; onImported: () => void }) {
  const accounts = brands.flatMap(b => b.accounts);
  const [projectId, setProjectId] = useState('');
  const [grid, setGrid] = useState<Grid | null>(null), [mapping, setMapping] = useState<Mapping>([]);
  const [fileError, setFileError] = useState(''), [done, setDone] = useState('');
  const [busy, setBusy] = useState(false), [submitError, setSubmitError] = useState('');
  const importRows = trpc.publishMonitor.manualImport.useMutation();
  const built = useMemo(() => (grid ? buildRows(grid, mapping) : null), [grid, mapping]);

  async function readFile(file: File | undefined) {
    setGrid(null); setFileError(''); setDone(''); setSubmitError('');
    if (!file) return;
    try {
      const parsed = await parseTable(file.name, new Uint8Array(await file.arrayBuffer()));
      setGrid(parsed); setMapping(suggestMapping(parsed.header));
    } catch (cause) {
      setFileError(cause instanceof TableImportError ? TABLE_ERRORS[cause.code] ?? '读不出这个文件。' : '读不出这个文件。');
    }
  }
  async function confirm() {
    if (!built || built.rows.length === 0 || !projectId) return;
    setBusy(true); setSubmitError('');
    let written = 0;
    try {
      for (let start = 0; start < built.rows.length; start += MAX_ROWS_PER_CALL) {
        const result = await importRows.mutateAsync({ accountProjectId: projectId, origin: 'table',
          rows: built.rows.slice(start, start + MAX_ROWS_PER_CALL) });
        written += result.inserted + result.updated;
      }
      setDone(`已导入 ${written} 条。`); setGrid(null); onImported();
    } catch (cause) {
      setSubmitError(`${written > 0 ? `已导入 ${written} 条，后面的没有导入：` : ''}${dataErrorMessage(errorCode(cause))}`);
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-3" aria-labelledby="pm-import">
      <h2 id="pm-import" className="text-base font-semibold">表格导入</h2>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        从平台后台导出作品数据表（CSV 或 XLSX），在这里核对后导入。导入的数据单独标为“手动导入”，不和自动读取的混在一起；不扣积分。</p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="导入到哪个品牌账号" className="rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-primary)' }}
          value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">选择品牌账号</option>
          {accounts.map(a => <option key={a.projectId} value={a.projectId}>
            {a.businessName} · {platformName(a.platform)} · {a.label}</option>)}
        </select>
        <input aria-label="选择表格文件" type="file" accept=".csv,.xlsx,text/csv" onChange={event => readFile(event.target.files?.[0])} />
      </div>
      {fileError && <p role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>{fileError}</p>}
      {done && <p role="status" className="text-sm">{done}</p>}
      {grid && built && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="text-left text-xs" aria-label="列对应关系">
              <thead><tr>{grid.header.map((name, column) => <th key={column} className="pr-3 font-medium">{name || `第 ${column + 1} 列`}</th>)}</tr></thead>
              <tbody><tr>{grid.header.map((_, column) => (
                <td key={column} className="pr-3">
                  <select aria-label={`第 ${column + 1} 列对应`} className="rounded border px-1 py-0.5" style={{ borderColor: 'var(--border-primary)' }}
                    value={mapping[column] ?? ''}
                    onChange={event => setMapping(m => m.map((f, i) => (i === column ? (event.target.value || null) as Field | null : f)))}>
                    <option value="">不导入</option>
                    {FIELDS.map(field => <option key={field} value={field}>{fieldLabel(field)}</option>)}
                  </select>
                </td>
              ))}</tr></tbody>
            </table>
          </div>
          {built.duplicateFields.length > 0 && <p role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>
            这些项目对应了不止一列：{built.duplicateFields.map(fieldLabel).join('、')}。请只保留一列。</p>}
          <p className="text-sm">可以导入 {built.rows.length} 条{built.errors.length > 0 ? `，${built.errors.length} 行不会导入：` : '。'}</p>
          {built.rows.length > 0 && <RowPreview rows={built.rows} />}
          {built.errors.length > 0 && (
            <ul className="max-h-40 overflow-y-auto text-xs" style={{ color: 'var(--text-secondary)' }}>
              {built.errors.slice(0, 50).map((e, i) => (
                <li key={i}>第 {e.line} 行：{ROW_ERRORS[e.code] ?? e.code}
                  {e.column !== undefined ? `（${grid.header[e.column] || `第 ${e.column + 1} 列`}）` : ''}</li>
              ))}
              {built.errors.length > 50 && <li>……还有 {built.errors.length - 50} 行</li>}
            </ul>
          )}
          {submitError && <p role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>{submitError}</p>}
          <Button disabled={busy || !projectId || built.rows.length === 0 || built.duplicateFields.length > 0} onClick={confirm}>
            {busy ? '正在导入…' : `确认导入 ${built.rows.length} 条`}</Button>
          {!projectId && <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>先选择要导入到哪个品牌账号。</p>}
        </div>
      )}
    </section>
  );
}

/** The rows that will be written, as the server will store them (first 20; the count above is the full total). */
function RowPreview({ rows }: { rows: ReturnType<typeof buildRows>['rows'] }) {
  const metrics = [...new Set(rows.flatMap(row => Object.keys(row.metrics)))];
  return (
    <div className="overflow-x-auto">
      <table className="text-left text-xs" aria-label="将要导入的行">
        <thead><tr><th className="pr-3 font-medium">作品</th><th className="pr-3 font-medium">发布时间</th>
          {metrics.map(key => <th key={key} className="pr-3 font-medium">{metricLabel(key)}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 20).map((row, i) => (
            <tr key={i}><td className="max-w-[240px] truncate pr-3">{row.titleExcerpt || row.postKey}</td>
              <td className="pr-3">{row.postedAt ? row.postedAt.slice(0, 10) : '未提供'}</td>
              {metrics.map(key => {
                const value = (row.metrics as Record<string, number | undefined>)[key];
                return <td key={key} className="pr-3">{value === undefined ? '—' : value.toLocaleString('zh-CN')}</td>;
              })}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 && <p className="text-xs">只显示前 20 条。</p>}
    </div>
  );
}
