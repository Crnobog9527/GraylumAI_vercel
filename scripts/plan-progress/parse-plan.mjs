// 从 MASTER_PLAN.md 的第 7.1 节任务表和"历史 PR 对照"表解析任务定义。只读，不做网络访问。

export const TASK_NAME = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const TOKEN_BOUNDARY = '[A-Za-z0-9-]';

export function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined).split('|');
  return cells.map((cell) => cell.trim());
}

function isSeparator(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

// 返回 heading 之后的第一张表：表头和数据行（每行附带 1 起的行号）。
export function readTableAfter(lines, headingPattern) {
  const start = lines.findIndex((line) => /^#{2,4} /.test(line) && headingPattern.test(line));
  if (start < 0) throw new Error(`MASTER_PLAN 里找不到标题：${headingPattern}`);
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (/^#{2,3} /.test(lines[i])) throw new Error(`标题 ${headingPattern} 下没有表格`);
    i += 1;
  }
  const header = splitRow(lines[i] ?? '');
  if (!header || !isSeparator(splitRow(lines[i + 1] ?? '') ?? [])) {
    throw new Error(`标题 ${headingPattern} 下的表格格式不对（第 ${i + 1} 行）`);
  }
  const rows = [];
  for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j += 1) {
    rows.push({ line: j + 1, cells: splitRow(lines[j]) });
  }
  return { header, rows };
}

function columnIndex(header, label) {
  const index = header.findIndex((cell) => cell.replace(/\*/g, '').startsWith(label));
  if (index < 0) throw new Error(`任务表缺少"${label}"列`);
  return index;
}

const stripParens = (text) => text.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');

// "PAY-COMMON → PAY-WAFFO"：箭头后面的任务依赖前一组；"、"分隔同组任务。
export function parseTaskCell(cell, line) {
  const groups = stripParens(cell.replace(/\*/g, ''))
    .split('→')
    .map((group) => group.split(/[、，,]/).map((name) => name.trim()).filter(Boolean));
  const tasks = [];
  groups.forEach((names, index) => {
    for (const name of names) {
      if (!TASK_NAME.test(name)) {
        throw new Error(`第 ${line} 行的任务名"${name}"不是规范任务名（大写字母、数字和连字符）`);
      }
      tasks.push({ name, chainDeps: index > 0 ? groups[index - 1] : [] });
    }
  });
  if (tasks.length === 0) throw new Error(`第 ${line} 行没有任务名`);
  return tasks;
}

export function findTaskNames(text, names) {
  const found = [];
  for (const name of names) {
    const pattern = new RegExp(`(?<!${TOKEN_BOUNDARY})${name}(?!${TOKEN_BOUNDARY})`);
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

export function findPrRefs(text) {
  return [...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

// 标注列：用"；"分隔多条，每条是"完成"、"关闭：原因"或"阻塞：原因"，可加"任务名："前缀只作用于该任务。
export function parseAnnotations(cell, rowNames, line) {
  const result = new Map(rowNames.map((name) => [name, null]));
  const entries = cell.split('；').map((entry) => entry.trim()).filter((entry) => entry && entry !== '—');
  for (const entry of entries) {
    let targets = rowNames;
    let body = entry;
    const prefix = entry.match(/^([A-Z][A-Z0-9-]*)[：:]\s*(.+)$/);
    if (prefix && rowNames.includes(prefix[1])) {
      targets = [prefix[1]];
      body = prefix[2];
    }
    const match = body.match(/^(完成|关闭|阻塞)(?:[：:]\s*(.+))?$/);
    if (!match) throw new Error(`第 ${line} 行的标注"${entry}"无法识别，只能写 完成 / 关闭：原因 / 阻塞：原因`);
    if (match[1] !== '完成' && !match[2]) throw new Error(`第 ${line} 行的"${match[1]}"标注要写明原因`);
    for (const target of targets) result.set(target, { kind: match[1], reason: match[2] ?? '' });
  }
  return result;
}

export function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/<br\s*\/?>/g, ' ')
    .trim();
}

function parseHistory(lines, taskNames) {
  const history = new Map();
  const { rows } = readTableAfter(lines, /历史 PR 对照/);
  for (const { line, cells } of rows) {
    const name = cells[0].replace(/\*/g, '').trim();
    if (!taskNames.has(name)) throw new Error(`历史 PR 对照第 ${line} 行的任务"${name}"不在任务表里`);
    const refs = [...cells[1].matchAll(/#(\d+)(（方案）)?/g)].map((match) => ({
      number: Number(match[1]),
      plan: Boolean(match[2]),
    }));
    history.set(name, [...(history.get(name) ?? []), ...refs]);
  }
  return history;
}

export function parsePlan(markdown) {
  const lines = markdown.split('\n');
  const { header, rows } = readTableAfter(lines, /^### 7\.1 /);
  const col = {
    phase: columnIndex(header, '阶段'),
    task: columnIndex(header, '任务'),
    content: columnIndex(header, '内容'),
    deps: columnIndex(header, '依赖'),
    risk: columnIndex(header, '风险'),
    size: columnIndex(header, '规模'),
    note: columnIndex(header, '标注'),
  };
  const phases = [];
  const tasks = [];
  let phase = null;
  for (const { line, cells } of rows) {
    const phaseCell = cells[col.phase].replace(/\*/g, '').trim();
    if (phaseCell) {
      phase = phaseCell;
      phases.push(phase);
    }
    if (!phase) throw new Error(`任务表第 ${line} 行之前没有阶段`);
    const rowTasks = parseTaskCell(cells[col.task], line);
    const annotations = parseAnnotations(cells[col.note], rowTasks.map((task) => task.name), line);
    for (const task of rowTasks) {
      tasks.push({
        name: task.name,
        phase,
        line,
        chainDeps: task.chainDeps,
        depsText: cells[col.deps],
        content: plainText(cells[col.content]),
        risk: plainText(cells[col.risk]),
        size: plainText(cells[col.size]),
        annotation: annotations.get(task.name),
      });
    }
  }
  const names = tasks.map((task) => task.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`任务名 ${duplicate} 在任务表里出现了不止一次`);
  const nameSet = new Set(names);
  // 长名字先匹配，避免 CI-TRUST 抢走 CI-TRUST-1 之类（边界检查之外的第二道保险）。
  const byLength = [...names].sort((a, b) => b.length - a.length);
  for (const task of tasks) {
    const textDeps = findTaskNames(stripParens(task.depsText), byLength).filter((name) => name !== task.name);
    task.deps = [...new Set([...task.chainDeps, ...textDeps])];
    task.depPrs = [...new Set(findPrRefs(task.depsText))];
    delete task.chainDeps;
  }
  const dateMatch = markdown.match(/整理日期：(\d{4}-\d{2}-\d{2})/);
  return {
    phases,
    tasks,
    history: parseHistory(lines, nameSet),
    planSince: dateMatch ? dateMatch[1] : null,
  };
}
