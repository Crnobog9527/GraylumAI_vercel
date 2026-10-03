/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import golden from './historyLegacyGolden.json';
import {openRouterRequestBody,PROVIDER_REQUEST_FORMATS,type RequestContext} from './providerRequest';
import {frozenCallPolicy} from '../bill2/service';
// Captured from the implementation branch's unmodified staging source before H1,
// using the existing #591 request corpus. Never regenerate from the candidate.
it.each(golden)('unchanged pre-H1 cached bytes and hash: $context.providerRequestFormat / $phase',f=>{
 const wire=openRouterRequestBody(f.request,{context:f.context as RequestContext,policy:frozenCallPolicy.parse(f.policy),
  phase:f.phase,primaryDialogue:f.phase==='skill'});
 expect(wire).toBe(f.output);expect(createHash('sha256').update(wire).digest('hex')).toBe(f.requestHash);
});
it('pre-H1 corpus covers every frozen request format',()=>{
 for(const format of PROVIDER_REQUEST_FORMATS)expect(golden.some(f=>f.context.providerRequestFormat===format)).toBe(true);
});
