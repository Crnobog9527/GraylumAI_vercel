'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { trpc } from '@/trpc/client';
import { useScrollPosition } from '@/components/opc/use-scroll-position';
import styles from './workspace-marketplace.module.css';

const categories=[['all','全部功能'],['writing','内容创作'],['marketing','营销文案'],['video','视频制作'],['business','商务办公'],['education','教育学习'],['coding','编程开发'],['analysis','分析洞察'],['creative','创意策划'],['other','其他分类']] as const;
export default function WorkspaceMarketplace(){
 const [category,setCategory]=useState<string>('all'),[search,setSearch]=useState(''),[page,setPage]=useState(1),[selected,setSelected]=useState(''),[returnTo,setReturnTo]=useState('');
 useEffect(()=>{const params=new URL(location.href).searchParams;setReturnTo(params.get('returnTo')??sessionStorage.getItem('opc-work-return')??'');setSelected(params.get('module')??'');},[]);
 const listing=trpc.modules.getModules.useQuery({category,limit:48,offset:(page-1)*48,sortBy:'newest'});
 const detail=trpc.modules.getModuleById.useQuery({id:selected},{enabled:Boolean(selected)});
 const runtimeChoices=trpc.runtime.choices.useQuery(undefined,{enabled:Boolean(selected)});
 const runnable=Boolean(runtimeChoices.data?.skills.some(skill=>skill.moduleId===selected));
 const modules=listing.data?.modules??[];
 const filtered=modules.filter(module=>(module.title+' '+(module.description??'')).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 const profile=trpc.user.getUserProfile.useQuery();
 const scrollProps=useScrollPosition(profile.data?.id?'opc-marketplace-scroll:'+profile.data.id+':'+(category+':'+page+':'+search):null,listing.isSuccess);
 const back=/^\/(runtime\?session=[0-9a-f-]{36}|positioning\/[0-9a-f-]{36}(\/topics)?)([&#?].*)?$/i.test(returnTo)?returnTo:'/positioning';
 return <WorkspaceFrame area="marketplace"><main className={styles.page}><header className={styles.header}><div><h1>功能广场</h1><p>浏览功能不会创建任务、发送消息或执行能力。</p></div><Link href={back}>返回当前工作 →</Link></header><div {...scrollProps} className={styles.content}><label className={styles.search}><Search size={17}/><input aria-label="查找功能" placeholder="查找功能" value={search} onChange={event=>setSearch(event.target.value)}/></label><div className={styles.categories} aria-label="功能分类">{categories.map(([id,label])=><button key={id} aria-pressed={category===id} onClick={()=>{setCategory(id);setPage(1);}}>{label}</button>)}</div><div className={styles.layout}><section className={styles.grid} aria-label="功能列表">{listing.isLoading&&<p>正在读取功能目录…</p>}{listing.error&&<p role="alert">功能目录当前不可用。</p>}{filtered.map(module=><button key={module.id} className={styles.card} aria-pressed={selected===module.id} onClick={()=>setSelected(module.id)}><span className={styles.art}>✦</span><strong>{module.title}</strong><small>{module.description}</small></button>)}{!listing.isLoading&&!filtered.length&&<p>没有匹配的功能。</p>}</section><aside className={styles.detail} aria-label="功能详情"><h2>{detail.data?.title??'选择一个功能'}</h2><p>{detail.data?.full_description??detail.data?.description??'先查看功能用途，再决定是否开始新任务。'}</p>{selected&&<><p className={styles.notice}>开始新任务会带入所选功能；当前工作和未发送输入保留。需要账号或来源时，请在新任务中明确选择。</p>{runtimeChoices.isLoading?<p role="status">正在核对本地可用能力…</p>:runnable?<Link className={styles.start} href={'/runtime?new=1&module='+encodeURIComponent(selected)}>用此功能开始新任务</Link>:<p role="status">这项功能尚未对当前工作环境开放执行；可以查看详情，不能从这里启动。</p>}</>}</aside></div><div className={styles.paging}><button disabled={page===1} onClick={()=>setPage(value=>value-1)}>上一页</button><span>第 {page} 页</span><button disabled={modules.length<48} onClick={()=>setPage(value=>value+1)}>下一页</button></div></div></main></WorkspaceFrame>;
}
