/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferenceContent } from './reference-content';

it('renders untrusted evidence as text and only explicit safe source links, without inventing missing URLs', () => {
  const html = renderToStaticMarkup(<ReferenceContent payload={{projection:'research-result', result:{fixture:true, pagination:{complete:false}, objects:[
    {fields:{title:'<script>bad()</script>',summary:'A source'}, sourceUrl:'javascript:alert(1)', missingFields:['date']},
    {fields:{title:'Trusted URL shape'},sourceUrl:'https://example.com/source'},
    {fields:{username:'no-original-url'},sourceUrl:'https://secret@example.com/'},
  ]}}} />);
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('secret@');
  expect(html).toContain('href="https://example.com/source"');
  expect(html).toContain('模拟检索资料');
  expect(html).toContain('仅展示已取得的部分结果');
  expect(html.match(/供应商未提供原始来源链接/g)).toHaveLength(2);
});

it('displays user-provided notes without internal metadata or supplier costs', () => {
  const html=renderToStaticMarkup(<ReferenceContent payload={{text:'User reference',license:'unknown',cost:{actual:999}}} />);
  expect(html).toContain('User reference');
  expect(html).not.toContain('999');
  expect(html).not.toContain('license');
});
