/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageMarkdown } from "./MessageMarkdown";
import { closePartialMarkdown, safeMessageHref } from "./message-markdown-source";

const render = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(MessageMarkdown, { text, streaming }));

describe("MessageMarkdown: formatting", () => {
  it("renders headings, emphasis and lists", () => {
    const html = render("## 定位结论\n\n### 受众\n\n**重点**和*补充*\n\n- 第一条\n- 第二条\n\n1. 先做\n2. 再做");
    expect(html).toContain("<h2>定位结论</h2>");
    expect(html).toContain("<h3>受众</h3>");
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<em>补充</em>");
    expect(html).toMatch(/<ul>\s*<li>第一条<\/li>\s*<li>第二条<\/li>\s*<\/ul>/);
    expect(html).toMatch(/<ol>\s*<li>先做<\/li>\s*<li>再做<\/li>\s*<\/ol>/);
  });

  it("renders GFM tables inside a horizontal scroll wrapper", () => {
    const html = render("| 平台 | 频率 |\n| --- | --- |\n| 小红书 | 每周 3 篇 |");
    expect(html).toMatch(/<div class="[^"]*tableScroll[^"]*"><table>/);
    expect(html).toContain("<th>平台</th>");
    expect(html).toContain("<td>每周 3 篇</td>");
  });

  it("renders code blocks, inline code, blockquotes and rules", () => {
    const html = render("用 `npm` 安装\n\n```ts\nconst a = 1;\n```\n\n> 引用一句\n\n---");
    expect(html).toContain("<code>npm</code>");
    expect(html).toContain('<pre><code class="language-ts">const a = 1;\n</code></pre>');
    expect(html).toMatch(/<blockquote>\s*<p>引用一句<\/p>\s*<\/blockquote>/);
    expect(html).toContain("<hr/>");
  });

  it("keeps single newlines as line breaks, like the old plain-text view", () => {
    expect(render("第一行\n第二行")).toMatch(/<p>第一行<br\/>\s*第二行<\/p>/);
  });
});

describe("MessageMarkdown: safety", () => {
  it("opens http(s) and mailto links in a new tab without opener access", () => {
    const html = render("[官网](https://example.com/a) [写信](mailto:hi@example.com)");
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">官网</a>');
    expect(html).toContain('<a href="mailto:hi@example.com" target="_blank" rel="noopener noreferrer">写信</a>');
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "/relative/path",
    "//evil.example/x",
  ])("drops the unsafe or relative link %s and keeps its text", href => {
    const html = render(`[点这里](${href})`);
    expect(html).not.toContain("<a");
    expect(html).not.toMatch(/javascript|vbscript|data:|evil/i);
    expect(html).toContain("<span>点这里</span>");
  });

  it("never renders raw HTML from the model", () => {
    const html = render('前文<script>alert(1)</script><img src=x onerror="alert(1)"><b>粗</b>\n\n<div onclick="x()">块</div>');
    expect(html).not.toMatch(/<script|<img|onerror|onclick|<b>|<div onclick/);
    expect(html).toContain("前文");
  });

  it("shows a markdown image as its alt text without loading it", () => {
    const html = render("![示意图](https://tracker.example/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("<span>示意图</span>");
  });

  it("allows only absolute http, https and mailto hrefs", () => {
    expect(safeMessageHref(" https://a.example ")).toBe("https://a.example");
    expect(safeMessageHref("http://a.example")).toBe("http://a.example");
    expect(safeMessageHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeMessageHref("ftp://a.example")).toBe("");
    expect(safeMessageHref("#top")).toBe("");
  });
});

describe("MessageMarkdown: streaming input", () => {
  it("closes bold that is still open on the last line", () => {
    expect(closePartialMarkdown("前文\n这是**重点内")).toBe("前文\n这是**重点内**");
    expect(render("这是**重点内", true)).toContain("<strong>重点内</strong>");
  });

  it("hides a marker that has only just arrived", () => {
    expect(closePartialMarkdown("这是 **")).toBe("这是");
    expect(closePartialMarkdown("用 `")).toBe("用");
  });

  it("closes open inline code before looking at emphasis", () => {
    expect(closePartialMarkdown("运行 `pnpm **x")).toBe("运行 `pnpm **x`");
  });

  it("leaves balanced text, rules and open code fences unchanged", () => {
    expect(closePartialMarkdown("**完整**")).toBe("**完整**");
    expect(closePartialMarkdown("上文\n***")).toBe("上文\n***");
    const fence = "示例：\n```\nconst a = **b";
    expect(closePartialMarkdown(fence)).toBe(fence);
    expect(render(fence, true)).toContain("<pre><code>const a = **b\n</code></pre>");
  });

  it("renders a half-received table header as text without breaking", () => {
    const html = render("对比如下：\n\n| 平台 | 频", true);
    expect(html).not.toContain("<table");
    expect(html).toContain("| 平台 | 频");
  });

  it("does not alter a completed reply", () => {
    expect(render("这是**重点内")).toContain("这是**重点内");
  });
});
