/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Temporary loopback transport for the existing isolated runner; no service or database.
import {checkOpenRouterUS,requireMentorProxy} from './stg-mentor-network.mjs';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {mentorSender,sha256} from '../packages/api/src/scripts/ac0Probe/mentorLive.ts';
import {fileLedger,acquireLedgerLock} from '../packages/api/src/scripts/ac0Probe/ledger.ts';
import {accountHome,assertOutsideRepository} from '../packages/api/src/scripts/ac0Probe/paths.ts';

export async function liveBridge({maxUsd,evidencePath,output,evidenceHash,frozenHead}) {
  requireMentorProxy();
  assertOutsideRepository(output);assertOutsideRepository(evidencePath);
  const evidenceRaw=readFileSync(evidencePath,'utf8');
  if(sha256(evidenceRaw)!==evidenceHash)
    throw new Error('MENTOR_APPROVED_EVIDENCE_REQUIRED');
  const evidence=JSON.parse(evidenceRaw);
  if(evidence.frozenHead!==frozenHead||evidence.mode!=='offline-only'||evidence.rows.length!==80)
    throw new Error('MENTOR_FROZEN_EVIDENCE_REQUIRED');
  const key=process.env.AC0_OPENROUTER_API_KEY?.trim();
  if(!key||/\s/.test(key))throw new Error('MENTOR_KEY_REQUIRED');
  const ledgerPath=join(accountHome(),'.graylum/ac0/ledger.json');
  const release=acquireLedgerLock(ledgerPath);
  const secret=randomUUID();let sender,server;
  try {
    sender=mentorSender({maxUsd,ledger:fileLedger(ledgerPath),authorization:'Bearer '+key,upstream:fetch,
      slots:evidence.rows.map(row=>({...row,model:row.model.startsWith('google/')?'G':row.model.startsWith('anthropic/')?'S':'DENIED'})),
      save:record=>appendFileSync(join(output,'mentor-live-results.jsonl'),JSON.stringify(record)+'\n',{mode:0o600})});
    let networkReady=false;
    const inFlight=new Set();
    let mainComplete=false;
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
          sender.stop();
          res.writeHead(200,{'Content-Type':'application/json'}).end('{"complete":true}');return;
        }
        if(req.url!=='/request')throw new Error('PATH_DENIED');
        if(request.slot.phase!=='main-single-turn')throw new Error('MAIN_ONLY');
        if(mainComplete&&request.slot.phase==='main-single-turn')throw new Error('MAIN_ALREADY_COMPLETE');
        if(!networkReady){
          const proof=await checkOpenRouterUS().catch(error=>{
            appendFileSync(join(output,'mentor-live-results.jsonl'),JSON.stringify({phase:'network-preflight',
              status:'stopped',stopReason:'MENTOR_OPENROUTER_US_NOT_CONFIRMED'})+'\n',{mode:0o600});
            throw error;
          });
          appendFileSync(join(output,'mentor-live-results.jsonl'),JSON.stringify(proof)+'\n',{mode:0o600});
          networkReady=true;
        }
        let clientDisconnected=false;
        res.on('error',()=>{clientDisconnected=true;});
        res.on('close',()=>{if(!res.writableFinished)clientDisconnected=true;});
        const sending=sender.send(request.raw,request.slot,{
          closed:()=>clientDisconnected||res.destroyed,
          headers:response=>res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json',
            ...(response.headers.get('x-generation-id')?{'x-generation-id':response.headers.get('x-generation-id')}:{})}),
          chunk:bytes=>{if(clientDisconnected||res.destroyed)throw new Error('CLIENT_DISCONNECTED');res.write(bytes);},
        });
        inFlight.add(sending);
        try{await sending;}finally{inFlight.delete(sending);}
        res.end();
      }catch{sender.stop();if(res.headersSent)res.destroy();else res.writeHead(409).end('MENTOR_STOP');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    return {url:'http://127.0.0.1:'+server.address().port,secret,
      close:async()=>{
        sender.stop();
        await Promise.allSettled([...inFlight]);
        await new Promise(resolve=>server.close(resolve));release();
      }};
  }catch(error){server?.close();release();throw error;}
}
