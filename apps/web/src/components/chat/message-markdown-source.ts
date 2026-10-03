/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for MessageMarkdown: link policy, line breaks and the
// streaming tail. Kept free of React so they are unit-testable on their own.

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Only absolute http(s) and mailto links survive; everything else is dropped. */
export function safeMessageHref(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? trimmed : "";
  } catch {
    return "";
  }
}

type MdNode = { type: string; value?: string; children?: MdNode[] };

function splitSoftBreaks(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("\n")) {
      child.value.split("\n").forEach((part, index) => {
        if (index > 0) next.push({ type: "break" });
        if (part) next.push({ type: "text", value: part });
      });
      continue;
    }
    splitSoftBreaks(child);
    next.push(child);
  }
  node.children = next;
}

/**
 * Chat replies were shown with pre-wrap, and models write single newlines as
 * line breaks. Keep that: a soft line break inside a paragraph becomes <br>.
 */
export function remarkSoftBreaks() {
  return (tree: MdNode) => splitSoftBreaks(tree);
}

function closeTrailingMarker(line: string, marker: string): string {
  const count = line.split(marker).length - 1;
  if (count % 2 === 0) return line;
  const at = line.lastIndexOf(marker);
  const rest = line.slice(at + marker.length);
  // A marker that has only just arrived has nothing to format yet: hide it.
  if (!rest.trim()) return line.slice(0, at).trimEnd();
  return line.trimEnd() + marker;
}

/**
 * While a reply is still streaming, close an emphasis or inline-code marker
 * that is open on the last line, so text does not flip between literal
 * asterisks and bold on every chunk. An open code fence is left alone: it
 * already renders as a code block to the end of the text.
 */
export function closePartialMarkdown(text: string): string {
  const fences = text.match(/^\s{0,3}(```|~~~)/gm)?.length ?? 0;
  if (fences % 2 === 1) return text;
  const cut = text.lastIndexOf("\n") + 1;
  let last = text.slice(cut);
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(last)) return text;
  const ticks = last.split("`").length - 1;
  if (ticks % 2 === 1) return text.slice(0, cut) + closeTrailingMarker(last, "`");
  last = closeTrailingMarker(last, "**");
  return text.slice(0, cut) + last;
}
