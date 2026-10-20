'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import Link from 'next/link';
import { isLibraryScanRecognitionEnabled } from '@/lib/library-sandbox/feature-flag';
import { recognizeImagesInBrowser } from '@/lib/library-sandbox/ocr/client';
import { characterAccuracy } from '@/lib/library-sandbox/ocr/accuracy';
import { sandboxErrorMessage, SandboxError } from '@/lib/library-sandbox/errors';

/**
 * LIB-2d speed check (LIB_DOCS_PLAN §4.5: a mid-range computer must read a page in ≤ 20 s). Recognises four synthetic
 * sample pages bundled with the site (no user file, nothing uploaded, nothing charged) and shows seconds per page and
 * accuracy, as text the tester copies back.
 */
const SAMPLE_BASE = '/library-sandbox/ocr/samples/';
const LABEL: Record<string, string> = { clean: '清晰的整页', phone_photo: '手机拍照的整页', upside_down: '倒着扫的整页（要识别两遍）',
  word_embedded: 'Word 里的小截图' };
type Row = { id: string; label: string; seconds: number; accuracy: number | null; error?: string };

export default function ScanCheckPage() {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [rows, setRows] = useState<Row[]>([]);
  const [setup, setSetup] = useState<number | null>(null);
  const [error, setError] = useState('');
  const enabled = isLibraryScanRecognitionEnabled();

  async function run() {
    setState('running'); setRows([]); setSetup(null); setError('');
    try {
      const expected = await (await fetch(SAMPLE_BASE + 'expected.json')).json() as Array<{ id: string; category: string; text: string }>;
      const images = await Promise.all(expected.map(async (sample) => (await fetch(`${SAMPLE_BASE}${sample.id}.jpg`)).blob()));
      // The first run includes downloading and starting the recognition program (about 20 MB, cached afterwards).
      const warm = performance.now();
      await recognizeImagesInBrowser([images[3]!]);
      setSetup((performance.now() - warm) / 1000);
      for (const [i, sample] of expected.entries()) {
        const started = performance.now();
        const [page] = await recognizeImagesInBrowser([images[i]!]);
        const seconds = (performance.now() - started) / 1000;
        const row: Row = page!.ok
          ? { id: sample.id, label: LABEL[sample.category] ?? sample.category, seconds, accuracy: characterAccuracy(sample.text, page!.text) }
          : { id: sample.id, label: LABEL[sample.category] ?? sample.category, seconds, accuracy: null, error: sandboxErrorMessage(page!.code, 'pdf') };
        setRows((current) => [...current, row]);
      }
      setState('done');
    } catch (failure) {
      setError(failure instanceof SandboxError ? sandboxErrorMessage(failure.code, 'pdf') : '测速没能完成，请刷新后重试。');
      setState('error');
    }
  }

  const slowest = rows.length ? Math.max(...rows.map((r) => r.seconds)) : 0;
  const average = rows.length ? rows.reduce((sum, r) => sum + r.seconds, 0) / rows.length : 0;
  const report = [
    `浏览器：${typeof navigator === 'undefined' ? '' : navigator.userAgent}`,
    `CPU 线程数：${typeof navigator === 'undefined' ? '' : navigator.hardwareConcurrency}`,
    setup === null ? '' : `第一次准备（下载并启动识别程序）：${setup.toFixed(1)} 秒`,
    ...rows.map((r) => `${r.label}：${r.seconds.toFixed(1)} 秒，准确率 ${r.accuracy === null ? '失败 ' + r.error : (r.accuracy * 100).toFixed(1) + '%'}`),
    rows.length ? `平均每页 ${average.toFixed(1)} 秒，最慢 ${slowest.toFixed(1)} 秒（门槛：每页不超过 20 秒）` : '',
  ].filter(Boolean).join('\n');

  return <main style={{ maxWidth: 720, margin: '32px auto', padding: '0 16px', lineHeight: 1.7 }}>
    <h1 style={{ fontSize: 22, fontWeight: 600 }}>扫描件识别测速</h1>
    <p>在这台电脑上识别 4 张自带的测试页面，看每页要多少秒。不会上传任何文件，也不扣积分。测试时请不要切换到别的标签页。</p>
    {!enabled && <p role="status">这个功能还没有开启。</p>}
    {enabled && <button type="button" onClick={() => { void run(); }} disabled={state === 'running'}
      style={{ padding: '8px 16px', border: '1px solid currentColor', borderRadius: 6 }}>
      {state === 'running' ? '正在测速…' : state === 'idle' ? '开始测速' : '再测一次'}
    </button>}
    {state === 'running' && <p role="status">正在识别第 {rows.length + 1} / 4 页…第一次要先下载识别程序，可能需要一两分钟。</p>}
    {error && <p role="alert">{error}</p>}
    {report && (state === 'done' || rows.length > 0) && <>
      <h2 style={{ fontSize: 17, fontWeight: 600, marginTop: 24 }}>结果（复制下面这段发回）</h2>
      <textarea readOnly value={report} rows={10} style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
        aria-label="测速结果"/>
    </>}
    <p style={{ marginTop: 24 }}><Link href="/app/library">返回资料库</Link></p>
  </main>;
}
