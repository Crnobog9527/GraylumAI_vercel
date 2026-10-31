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

const KIND_TEST = /(?<![\w.])(?:t\.|p_)?kind\s+(NOT\s+IN|IN|<>|!=|=)\s*(\([^)]*\)|'[^']*')/gi;
const TOKEN = /\b(END\s+IF|END\s+LOOP|END\s+CASE|ELSIF|IF|ELSE|THEN|CASE|END)\b/gi;

export const stripComments = sql => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const literals = text => [...text.matchAll(/'([^']*)'/g)].map(m => m[1]);

// { tests: how many kind tests the condition holds, holds: whether `kind` passes them all, pure: the condition is only kind tests }
export function judge(cond, kind) {
  if (/\bOR\b/i.test(cond)) return { tests: 0, holds: true, pure: false };
  const tests = [...cond.matchAll(KIND_TEST)];
  let holds = true;
  for (const [, op, rhs] of tests) {
    const inList = literals(rhs).includes(kind);
    const positive = /^(IN|=)$/i.test(op.replace(/\s+/g, ' '));
    if (positive !== inList) holds = false;
  }
  const rest = cond.replace(KIND_TEST, ' ').replace(/\b(AND|NOT)\b|[()\s]/gi, '');
  return { tests: tests.length, holds, pure: tests.length > 0 && rest === '' };
}

// The function body without the IF branches that `kind` cannot take.
export function pruneForKind(body, kind) {
  const text = stripComments(body);
  const dead = [];
  const stack = [];
  const closeBranch = (frame, at) => { if (frame.start !== null) { if (frame.dead) dead.push([frame.start, at]); frame.start = null; } };
  const open = (frame, condEnd, cond) => {
    const j = judge(cond, kind);
    frame.dead = (j.tests > 0 && !j.holds) || frame.taken;
    if (j.pure && j.holds) frame.taken = true;
    frame.start = condEnd;
  };
  for (const m of text.matchAll(TOKEN)) {
    const word = m[1].toUpperCase().replace(/\s+/g, ' ');
    const top = stack[stack.length - 1];
    if (word === 'IF') {
      const then = /\bTHEN\b/i.exec(text.slice(m.index + 2));
      if (!then) continue;
      const condEnd = m.index + 2 + then.index + then[0].length;
      const frame = { type: 'if', taken: false, start: null, dead: false };
      open(frame, condEnd, text.slice(m.index + 2, condEnd - then[0].length));
      stack.push(frame);
    } else if (word === 'ELSIF' && top?.type === 'if') {
      closeBranch(top, m.index);
      const then = /\bTHEN\b/i.exec(text.slice(m.index + 5));
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
    } else if (word === 'CASE') stack.push({ type: 'case' });
    else if ((word === 'END' || word === 'END CASE') && top?.type === 'case') stack.pop();
  }
  let out = '', from = 0;
  for (const [a, b] of dead.sort((x, y) => x[0] - y[0])) { if (a >= from) { out += text.slice(from, a); from = b; } }
  return out + text.slice(from);
}
