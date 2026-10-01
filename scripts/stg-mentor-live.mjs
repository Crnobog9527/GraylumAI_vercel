/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Temporary loopback transport for the existing isolated runner; no service or database.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {mentorSender,sha256} from '../packages/api/src/scripts/ac0Probe/mentorLive.ts';
import {fileLedger,acquireLedgerLock} from '../packages/api/src/scripts/ac0Probe/ledger.ts';
import {accountHome,assertOutsideRepository} from '../packages/api/src/scripts/ac0Probe/paths.ts';

export async function liveBridge({maxUsd,evidencePath,output}) {
  assertOutsideRepository(output);assertOutsideRepository(evidencePath);
  const evidenceRaw=readFileSync(evidencePath,'utf8');
  if(sha256(evidenceRaw)!=='040cd0d08c833ad83ad1814f5d5c4c0befff435b6361d24d670bcde7d67c6bc5')
    throw new Error('MENTOR_APPROVED_EVIDENCE_REQUIRED');
  const evidence=JSON.parse(evidenceRaw);
  const key=process.env.AC0_OPENROUTER_API_KEY?.trim();
  if(!key||/\s/.test(key))throw new Error('MENTOR_KEY_REQUIRED');
  const ledgerPath=join(accountHome(),'.graylum/ac0/ledger.json');
  const release=acquireLedgerLock(ledgerPath);
  const secret=randomUUID();let sender,server;
  try {
    sender=mentorSender({maxUsd,ledger:fileLedger(ledgerPath),authorization:'Bearer '+key,upstream:fetch,
      slots:evidence.rows.map(row=>({...row,model:row.model.startsWith('google/')?'G':row.model.startsWith('anthropic/')?'S':'L'})),
      save:record=>appendFileSync(join(output,'mentor-live-results.jsonl'),JSON.stringify(record)+'\n',{mode:0o600})});
    let mainComplete=false,passed=[],reviewDone=false,reviewFailed=false;
    server=createServer(async(req,res)=>{
      if(req.headers.authorization!=='Bearer '+secret){res.writeHead(403).end();return;}
      try {
        if(req.method!=='POST')throw new Error('POST_ONLY');
        const chunks=[];let length=0;
        for await(const part of req){length+=part.length;if(length>200000)throw new Error('BODY_LIMIT');chunks.push(part);}
        const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(req.url==='/main-complete') {
          if(mainComplete||sender.totals.run.calls!==80)throw new Error('MAIN_INCOMPLETE');
          mainComplete=true;
          void (async()=>{
          // Semantic grading is manual, using the existing blind-review material.
          // Stay in the same locked batch; never restart to obtain fresh run caps.
          const terminal=createInterface({input:process.stdin,output:process.stdout});
          try {
            console.log('Main complete. Grade blind-review.json using the approved rubric; lock judgments before revealing private-blind-mapping.json.');
            const answer=await terminal.question('Enter JSON {"G":{"cards":0,"recommended":0,"format":0,"fabrications":0,"contradictions":0},"S":{...}}; no default: ');
            const grades=JSON.parse(answer);
            for(const model of ['G','S']) {
              const g=grades[model];
              if(!g||![g.cards,g.recommended,g.format,g.fabrications,g.contradictions].every(Number.isSafeInteger)||
                g.cards<0||g.cards>40||g.recommended<0||g.recommended>18||g.format<0||g.format>40||
                g.fabrications<0||g.contradictions<0)throw new Error('GRADING_INVALID');
              if(g.cards>=36&&g.recommended>=17&&g.format>=39&&g.fabrications===0&&g.contradictions===0)passed.push(model);
            }
            appendFileSync(join(output,'mentor-live-results.jsonl'),JSON.stringify({phase:'manual-main-review',grades,passed})+'\n',{mode:0o600});
          } finally {terminal.close();}
            reviewDone=true;
          })().catch(()=>{reviewFailed=true;sender.stop();});
          res.writeHead(200,{'Content-Type':'application/json'}).end('{"pending":true}');return;
        }
        if(req.url==='/review-status') {
          if(!mainComplete||reviewFailed)throw new Error('REVIEW_FAILED');
          res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({pending:!reviewDone,passed}));return;
        }
        if(req.url!=='/request')throw new Error('PATH_DENIED');
        if(request.slot.phase==='e2e'&&(!reviewDone||!passed.includes(request.slot.id.split('-')[0])))
          throw new Error('E2E_QUALITY_GATE');
        if(mainComplete&&request.slot.phase==='main-single-turn')throw new Error('MAIN_ALREADY_COMPLETE');
        await sender.send(request.raw,request.slot,{
          headers:response=>res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json',
            ...(response.headers.get('x-generation-id')?{'x-generation-id':response.headers.get('x-generation-id')}:{})}),
          chunk:bytes=>{if(res.destroyed)throw new Error('CLIENT_DISCONNECTED');res.write(bytes);},
        });
        res.end();
      }catch{sender.stop();if(res.headersSent)res.destroy();else res.writeHead(409).end('MENTOR_STOP');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    return {url:'http://127.0.0.1:'+server.address().port,secret,
      close:async()=>{sender.stop();await new Promise(resolve=>server.close(resolve));release();}};
  }catch(error){server?.close();release();throw error;}
}
