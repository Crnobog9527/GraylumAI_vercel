'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useLayoutEffect, useRef } from 'react';

/** Retain an owned view's reading position without replaying it on refetch. */
export function useScrollPosition(key:string|null,ready:boolean){
 const ref=useRef<HTMLDivElement>(null),restored=useRef<string|null>(null),touched=useRef(false),previousKey=useRef<string|null>(null);
 useLayoutEffect(()=>{restored.current=null;if(previousKey.current!==null)touched.current=false;previousKey.current=key;},[key]);
 useLayoutEffect(()=>{
  if(!key||!ready||!ref.current||restored.current===key)return;
  if(!touched.current){try{ref.current.scrollTop=Number(sessionStorage.getItem(key))||0;}catch{/* Optional preference. */}}
  restored.current=key;
 },[key,ready]);
 const takeControl=()=>{touched.current=true;};
 return {ref,onWheel:takeControl,onPointerDown:takeControl,onTouchStart:takeControl,onKeyDown:takeControl,onScroll:()=>{if(key&&restored.current===key&&ref.current)try{sessionStorage.setItem(key,String(ref.current.scrollTop));}catch{/* Optional preference. */}}};
}
