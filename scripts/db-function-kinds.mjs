/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Per-turn-kind pruning for the closure check (CORE-PATH-V2 plan 3.1, Owner 2026-10-31 option A): a turn of one kind only walks the
// branches of a function that its kind can reach, so the closure is counted per kind and not over every kind at once.
// A branch is dropped only when its IF condition is a plain test on the turn's kind (`t.kind` / `p_kind` against string literals, no OR)
// that the kind being counted fails, or when an earlier branch of the same IF is a pure kind test that the kind passes. Anything
// else (other conditions, OR, CASE expressions) stays in, so pruning can only under-drop, never hide a call that could run.
export const KINDS = ['chat', 'mentor', 'report', 'compare', 'jury', 'jury_adopt', 'review'];

// The kinds a root can be called with. The fusion functions refuse every other kind in their first statement (turn_fusion_recovery
// only selects jury turns), so counting them for chat / mentor / report would count a path that raises or is never taken.
export function kindsOf(root) {
  if (root === 'turn_fusion_recovery') return ['jury', 'jury_adopt'];
  return root.startsWith('turn_fusion_') ? ['compare', 'jury', 'jury_adopt'] : KINDS;
}

// `p_kind` is the turn's kind only in these functions; elsewhere it is the close reason (completed, stopped ...) or something else.
export const P_KIND_IS_TURN_KIND = new Set(['turn_open', 'turn_fusion_open']);

const KIND_TEST = /(?<![\w.])(?:t\.|p_)?kind\s+(NOT\s+IN|IN|<>|!=|=)\s*(\([^)]*\)|'[^']*')/gi;
const TOKEN = /\b(END\s+IF|END\s+LOOP|END\s+CASE|ELSIF|IF|ELSE|THEN|CASE|END)\b/gi;

export const stripComments = sql => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const literals = text => [...text.matchAll(/'([^']*)'/g)].map(m => m[1]);

// { tests: how many kind tests the condition holds, holds: whether `kind` passes them all, pure: the condition is only kind tests }
export function judge(cond, kind, pKind = false) {
  // OR, and a NOT that is not part of NOT IN, are not evaluated: the branch stays.
  if (/\bOR\b/i.test(cond) || /\bNOT\b(?!\s+IN\b)/i.test(cond)) return { tests: 0, holds: true, pure: false };
  const tests = [...cond.matchAll(KIND_TEST)].filter(m => pKind || !/^p_/i.test(m[0]));
  let holds = true;
  for (const [, op, rhs] of tests) {
    const inList = literals(rhs).includes(kind);
    const positive = /^(IN|=)$/i.test(op.replace(/\s+/g, ' '));
    if (positive !== inList) holds = false;
  }
  const rest = cond.replace(KIND_TEST, x => (tests.some(t => t[0] === x) ? ' ' : x)).replace(/\b(AND|NOT)\b|[()\s]/gi, '');
  return { tests: tests.length, holds, pure: tests.length > 0 && rest === '' };
}

// `CASE <kind> WHEN 'a', 'b' THEN x ... ELSE y END` (the simple form): the WHEN branches whose literals do not include `kind` are dead,
// and so is the ELSE once a WHEN took the kind. A WHEN whose value is not only string literals is left in and takes nothing.
const CASE_PART = /\b(END\s+CASE|END\s+IF|END\s+LOOP|BEGIN|IF|CASE|END|WHEN|ELSE|THEN)\b/gi;
// `code` is the body with string contents blanked (same offsets as `text`), so a word inside a string is never read as a keyword.
function deadCaseBranches(code, text, from, kind) {
  const dead = [];
  let depth = 0, ifDepth = 0, taken = false, branch = null;
  const close = at => { if (branch) { if (branch.dead) dead.push([branch.start, at]); branch = null; } };
  CASE_PART.lastIndex = from;
  for (let m = CASE_PART.exec(code); m; m = CASE_PART.exec(code)) {
    const word = m[1].toUpperCase().replace(/\s+/g, ' ');
    // An IF inside a branch has its own ELSE; it is not the CASE's.
    // END LOOP ends a loop, not the CASE; a nested BEGIN block has an END of its own that is not told apart here: keep every branch.
    if (word === 'END LOOP') continue;
    if (word === 'BEGIN') return [];
    if (word === 'IF') ifDepth++;
    else if (word === 'END IF') ifDepth--;
    else if (word === 'CASE') depth++;
    else if (word === 'END' || word === 'END CASE') { if (depth === 0) { close(m.index); break; } depth--; }
    else if (depth === 0 && ifDepth === 0 && word === 'WHEN') {
      close(m.index);
      const then = /\bTHEN\b/i.exec(code.slice(m.index + 4));
      if (!then) break;
      const values = text.slice(m.index + 4, m.index + 4 + then.index);
      const plain = /^\s*'[^']*'(\s*,\s*'[^']*')*\s*$/.test(values);
      const has = plain && literals(values).includes(kind);
      branch = { start: m.index + 4 + then.index + then[0].length, dead: plain && !has };
      if (has) taken = true;
    } else if (depth === 0 && ifDepth === 0 && word === 'ELSE') { close(m.index); branch = { start: m.index + 4, dead: taken }; }
  }
  return dead;
}

// The function body without the IF branches that `kind` cannot take.
export function pruneForKind(body, kind, pKind = false) {
  const text = stripComments(body);
  const code = text.replace(/'(?:[^']|'')*'/g, q => `'${' '.repeat(q.length - 2)}'`);
  const dead = [];
  const stack = [];
  const closeBranch = (frame, at) => { if (frame.start !== null) { if (frame.dead) dead.push([frame.start, at]); frame.start = null; } };
  const open = (frame, condEnd, cond) => {
    const j = judge(cond, kind, pKind);
    frame.dead = (j.tests > 0 && !j.holds) || frame.taken;
    if (j.pure && j.holds) frame.taken = true;
    frame.start = condEnd;
  };
  for (const m of code.matchAll(TOKEN)) {
    const word = m[1].toUpperCase().replace(/\s+/g, ' ');
    const top = stack[stack.length - 1];
    if (word === 'IF') {
      const then = /\bTHEN\b/i.exec(code.slice(m.index + 2));
      if (!then) continue;
      const condEnd = m.index + 2 + then.index + then[0].length;
      const frame = { type: 'if', taken: false, start: null, dead: false };
      open(frame, condEnd, text.slice(m.index + 2, condEnd - then[0].length));
      stack.push(frame);
    } else if (word === 'ELSIF' && top?.type === 'if') {
      closeBranch(top, m.index);
      const then = /\bTHEN\b/i.exec(code.slice(m.index + 5));
      if (!then) continue;
      const condEnd = m.index + 5 + then.index + then[0].length;
      open(top, condEnd, text.slice(m.index + 5, condEnd - then[0].length));
    } else if (word === 'ELSE' && top?.type === 'if') {
      closeBranch(top, m.index);
      top.dead = top.taken;
      top.start = m.index + 4;
    } else if (word === 'END IF' && top?.type === 'if') {
      closeBranch(top, m.index);
      stack.pop();
    } else if (word === 'CASE') {
      stack.push({ type: 'case' });
      const simple = /^\s*(t\.kind|p_kind)\s+WHEN\b/i.exec(code.slice(m.index + 4));
      if (simple && (pKind || !/^p_/i.test(simple[1]))) dead.push(...deadCaseBranches(code, text, m.index + 4 + simple[0].length - 4, kind));
    }
    else if ((word === 'END' || word === 'END CASE') && top?.type === 'case') stack.pop();
  }
  let out = '', from = 0;
  for (const [a, b] of dead.sort((x, y) => x[0] - y[0])) { if (a >= from) { out += text.slice(from, a); from = b; } }
  return out + text.slice(from);
}
