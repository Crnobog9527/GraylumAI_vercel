/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// One-time wrapper for disposable test processes, matching the original harness.
exports.installLocalFetchGuard = function installLocalFetchGuard({stagingOrigin,gatewayOrigin}={}) {
  const original=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    let mapped;
    if(stagingOrigin&&url.origin===stagingOrigin) mapped=gatewayOrigin+url.pathname+url.search;
    if(stagingOrigin&&url.origin==='https://openrouter.ai'&&url.pathname==='/api/v1/chat/completions') {
      mapped=gatewayOrigin+'/__official_chat';
    }
    if(mapped)return original(input instanceof Request?new Request(mapped,input):mapped,init);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('LOCAL_ONLY_NETWORK');
    return original(input,init);
  };
};
