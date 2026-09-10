/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Counts requests at the actual loopback provider HTTP boundary.
export function chatProviderFixture() {
  const calls = [], released = new Set();
  let balanceFault = null;
  return async (req, res) => {
    if (req.url === '/__chat_balance_fault') {
      if (req.method === 'POST') {
        const chunks=[]; for await(const chunk of req)chunks.push(chunk);
        const config=JSON.parse(Buffer.concat(chunks).toString());
        balanceFault=config.actor?{...config,seen:0}:null;
      }
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(balanceFault));return true;
    }
    const u=new URL(req.url,'http://127.0.0.1');
    // Fault only this test actor's service-role balance GET, never auth/profile
    // admission, browser reads, RPCs, or writes. Successful attempts continue to
    // the real narrow-ACL PostgREST/SQL fixture.
    if(balanceFault&&req.method==='GET'&&u.pathname==='/rest/v1/profiles'&&u.searchParams.get('select')==='credits'&&u.searchParams.get('id')==='eq.'+balanceFault.actor) {
      let role;try{role=JSON.parse(Buffer.from((req.headers.authorization??'').split('.')[1],'base64url').toString()).role;}catch{}
      if(role==='service_role') {
        balanceFault.seen++;
        if(balanceFault.seen<=(balanceFault.skip??0))return false;
        if(balanceFault.remaining>0){
          balanceFault.remaining--;
          if(balanceFault.kind==='hang')return true;
          if(balanceFault.kind==='network'){res.destroy();return true;}
          const code=balanceFault.kind==='permission'?'42501':balanceFault.kind==='pool'?'PGRST003':'57014';
          res.writeHead(code==='42501'?403:code==='PGRST003'?504:500,{'Content-Type':'application/json'}).end(JSON.stringify({code,message:'private balance fixture detail'}));return true;
        }
      }
    }
    if (req.url === '/__chat_calls') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(calls)); return true;
    }
    if (req.url?.startsWith('/__chat_release/')) {
      released.add(decodeURIComponent(req.url.slice('/__chat_release/'.length))); res.writeHead(200).end(); return true;
    }
    if (req.url !== '/__chat_model_fixture') return false;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const message = body.messages.at(-1).content;
    const key = message.match(/CHAT_CASE_[a-zA-Z0-9_-]+/)?.[0] ?? message;
    calls.push({ key, model: body.model, receivedAt: Date.now() });
    if (message.includes('REFUSED')) {
      const payload={error:{code:message.includes('STRING')?'rate_limit_exceeded':429,message:'Local rate limit'}};
      if(message.includes('METERED'))payload.usage={prompt_tokens:800,completion_tokens:30};
      if(message.includes('PARTIAL'))payload.choices=[{message:{content:'partial'}}];
      res.writeHead(message.includes('HTTP200')?200:message.includes('SERVER_ERROR')?500:429, {'Content-Type':'application/json'}).end(message.includes('HTML')?'<html>unavailable</html>':JSON.stringify(payload)); return true;
    }
    if (message.includes('HOLD')) {
      const started = Date.now();
      while (!released.has(key) && Date.now()-started < 30000) await new Promise(r => setTimeout(r, 50));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: '+JSON.stringify({ choices: [{ delta: { content: 'Local answer '+key } }] })+'\n\n');
    if (message.includes('UNKNOWN')) { res.end(); return true; }
    res.write('data: '+JSON.stringify({ choices: [], usage: { prompt_tokens:800, completion_tokens:30, total_tokens:830 } })+'\n\n');
    res.end('data: [DONE]\n\n'); return true;
  };
}
