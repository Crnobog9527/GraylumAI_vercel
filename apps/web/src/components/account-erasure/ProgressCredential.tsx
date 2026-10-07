/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatProgressCredential, type ProgressCredential as Credential } from '@/lib/erasure-progress';

export function ProgressCredential({ credential }: { credential: Credential }) {
  const [notice, setNotice] = useState('');
  const value = formatProgressCredential(credential);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setNotice('凭证已复制，请保存在你信任的位置。'); }
    catch { setNotice('无法自动复制，请选中上方完整凭证手动复制。'); }
  };
  const save = () => {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'graylum-erasure-credential.txt';
      link.click();
      setNotice('已请求下载，请确认凭证文件已保存。');
    } catch { setNotice('无法下载，请复制或手动保存上方完整凭证。'); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000); }
  };
  return (
    <section className="space-y-3 sentry-block" aria-label="保存查询凭证">
      <label htmlFor="saved-erasure-credential" className="block text-sm font-medium">查询凭证</label>
      <textarea id="saved-erasure-credential" value={value} readOnly rows={3} autoComplete="off" spellCheck={false}
        className="w-full rounded-lg border p-3 font-mono text-sm break-all"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void copy()}>复制凭证</Button>
        <Button variant="outline" onClick={save}>保存凭证文件</Button>
      </div>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        持有凭证的人可以查看注销进度，请勿公开分享。凭证不能登录或恢复账号。
      </p>
      <p role="status" className="text-sm">{notice}</p>
    </section>
  );
}
