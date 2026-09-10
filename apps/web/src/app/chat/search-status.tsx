/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import {publicSearchEvidence} from '@repo/api/src/services/providerUsage';
export function SearchStatus({evidence}:{evidence:unknown}) {
 const search=publicSearchEvidence(evidence);
 if(!search)return null;
 return <section aria-label="联网依据" className="mt-3 space-y-2 border-t pt-2 text-xs">
  <p>{search.status==='unavailable'?'本次未联网：当前模型或接口未启用可验证搜索。':search.status==='not_requested'?'本次未联网。':search.status==='unknown'?'联网执行与费用待确认，请保留原请求。':search.executed?`已联网：${search.queryCount} 个查询；联网附加 ${search.surchargeCredits} 积分。`:'本次未执行搜索，联网附加 0 积分。'}</p>
  {search.sources.length>0&&<ul>{search.sources.map(source=><li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">{source.title}</a></li>)}</ul>}
  {search.suggestionsHtml&&<iframe title="Google 搜索建议" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https: data:; base-uri \'none\'; form-action \'none\'">'+search.suggestionsHtml} className="w-full border-0"/>}
 </section>;
}
