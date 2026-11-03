/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {LIBRARY_READ_GUIDE,LIBRARY_SEARCH_GUIDE} from './libraryReadTool';
/** Fixed tool descriptions; admission sizes them with the turn path's own formula. */
function sourceToolDescription(name: string, workspaceContext?: boolean, library?: boolean, retrieval?: boolean): string {
 const base=name==='search'?'Search current sources through the explicitly enabled local search adapter.':
  workspaceContext?'Read owned business context only when relevant. Omit query to list positioning/account/topic metadata; '+
   'pass an exact returned id to read that source. Read-only; no internet access.':'Read the selected source only.';
 // LIB-4: admission sizes the same text, so pass `library` there when the execution freezes references (4b).
 return name==='read_source'&&(library||retrieval)?base+LIBRARY_READ_GUIDE+(retrieval?LIBRARY_SEARCH_GUIDE:''):base;
}
export function sourceToolBytes(names: string[], workspaceContext?: boolean, library?: boolean, retrieval?: boolean): number {
 return Buffer.byteLength(JSON.stringify(names.map(name=>({name,description:sourceToolDescription(name,workspaceContext,library,retrieval)}))));
}
