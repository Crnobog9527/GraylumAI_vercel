#!/usr/bin/env node
// 只读核对：staging 的已应用记录（supabase_migrations.schema_migrations）和仓库的迁移文件是否一一对得上。
// 迁移编号允许空号（Owner 2026-10-25）后，"漏应用"不再靠编号连续发现，改用这个核对。
// 不连接数据库，只读取保存好的查询结果：
//
//   supabase db query --linked -o json \
//     "select version, name from supabase_migrations.schema_migrations" > <快照.json>
//   node scripts/check-staging-migrations-applied.mjs <快照.json> [迁移目录]
//
// 记录的两种写法都认：name 是完整文件名去掉 .sql（现在 mig-apply.sh 的写法），
// 或 name 只有名称部分（早期写法，version 是 4 位编号或时间戳）。
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_FILENAME = /^(?<number>\d{4})_(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;

// 0001–0043 和 0063 早于 staging 记账，staging 上没有对应记录（2026-10-25 只读核对）。
const UNRECORDED_HISTORY_MAX = 43;
const UNRECORDED_FILES = new Set(['0063_bill_1_reconciliation_select_contract']);
// staging 上的临时演练记录，仓库里没有对应文件（2026-10-25 只读核对）。
const KNOWN_EXTRA_RECORD = [
  /^erasure_executor_probe_success_20261008$/,
  /^0256_fusion_review_flow_early_[0-9a-f]{8}$/,
];

export function parseSnapshot(text) {
  const start = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const data = arrayStart !== -1 && (start === -1 || arrayStart < start)
    ? JSON.parse(text.slice(arrayStart, text.lastIndexOf(']') + 1))
    : JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
  const rows = Array.isArray(data) ? data : data.rows;
  if (!Array.isArray(rows)) throw new Error('快照里没有 rows 列表');
  return rows.map((row) => ({ version: String(row.version ?? ''), name: String(row.name ?? '') }));
}

export function compareApplied(rows, filenames) {
  const files = [];
  const errors = [];
  for (const filename of filenames) {
    if (!filename.endsWith('.sql')) continue;
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match?.groups) {
      errors.push(`迁移文件名格式不对：${filename}`);
      continue;
    }
    files.push({ stem: filename.slice(0, -4), number: Number(match.groups.number), name: match.groups.name });
  }
  const byStem = new Map(files.map((file) => [file.stem, file]));
  const applied = new Set();

  for (const row of rows) {
    const direct = byStem.get(row.name) ?? byStem.get(`${row.version}_${row.name}`);
    const byName = files.filter((file) => file.name === row.name);
    const file = direct ?? (byName.length === 1 ? byName[0] : undefined);
    // 同一迁移记两次（0048、0137、0138 历史上重放过）不算漏应用，不报错。
    if (file) {
      applied.add(file.stem);
    } else if (!KNOWN_EXTRA_RECORD.some((pattern) => pattern.test(row.name))) {
      errors.push(`staging 有应用记录、仓库里找不到对应文件：version ${row.version} name ${row.name}`);
    }
  }

  for (const file of files) {
    if (applied.has(file.stem)) continue;
    if (file.number <= UNRECORDED_HISTORY_MAX || UNRECORDED_FILES.has(file.stem)) continue;
    errors.push(`仓库有迁移、staging 没有应用记录：${file.stem}.sql`);
  }
  return errors;
}

async function main() {
  const [snapshot, directory = 'packages/db/migrations'] = process.argv.slice(2);
  if (!snapshot) {
    console.error('用法：node scripts/check-staging-migrations-applied.mjs <快照.json> [迁移目录]');
    process.exitCode = 2;
    return;
  }
  const rows = parseSnapshot(await readFile(snapshot, 'utf8'));
  const errors = compareApplied(rows, await readdir(path.resolve(directory)));
  if (errors.length > 0) {
    for (const error of errors) console.error(`staging 迁移核对失败：${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`staging 迁移核对通过：${rows.length} 条应用记录和仓库文件对得上。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
