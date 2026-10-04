/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {finishWaitingOrganizer} from './waitingOrganizer';
const executionId='10000000-0000-4000-8000-000000000001';
const requestId='10000000-0000-4000-8000-000000000002';
const waiting={executionId,state:'waiting_credits' as const,cursor:3,epoch:5,remainingCalls:1};
it('does not call the host without a pending organizer',async()=>{
 const resume=vi.fn();
 expect(await finishWaitingOrganizer({},requestId,resume)).toBeNull();
 expect(resume).not.toHaveBeenCalled();
});
it('bare admission holds the new request without inventing an execution host',async()=>{
 expect(await finishWaitingOrganizer({waitingOrganizer:waiting},requestId)).toEqual({
  ...waiting,code:'RUNTIME_WAITING_CREDITS',admitted:false,blockedRequestId:requestId,
 });
});
it('only resumes the saved execution cursor and epoch before allowing the next admission',async()=>{
 const resume=vi.fn().mockResolvedValue({state:'completed',body:'old reply',summary:'old organization'});
 expect(await finishWaitingOrganizer({waitingOrganizer:waiting},requestId,resume)).toBeNull();
 expect(resume).toHaveBeenCalledExactlyOnceWith({executionId,cursor:3,epoch:5});
});
it.each(['waiting_credits','waiting_resume','cost_pending','cancelled'] as const)(
 'does not admit the new request when the original organizer returns %s',async state=>{
 const result={state,executionId,cursor:4,epoch:6,remainingCalls:1};
 expect(await finishWaitingOrganizer({waitingOrganizer:waiting},requestId,vi.fn().mockResolvedValue(result)))
  .toEqual({...result,admitted:false,blockedRequestId:requestId});
});
it.each(['RUNTIME_RESUME_CONFLICT','RUNTIME_RESUME_SOURCE_CHANGED'])(
 'propagates %s without running a new admission',async code=>{
 const resume=vi.fn().mockRejectedValue(new Error(code));
 await expect(finishWaitingOrganizer({waitingOrganizer:waiting},requestId,resume)).rejects.toThrow(code);
 expect(resume).toHaveBeenCalledTimes(1);
});
it('fails closed on a malformed durable waiting token',async()=>{
 const resume=vi.fn();
 await expect(finishWaitingOrganizer({waitingOrganizer:{...waiting,epoch:-1}},requestId,resume)).rejects.toThrow();
 expect(resume).not.toHaveBeenCalled();
});

it.each(['running','interrupted','cost_pending'])(
 'does not take ownership of an original organizer in %s',async state=>{
 const resume=vi.fn();
 await expect(finishWaitingOrganizer({waitingOrganizer:{...waiting,state}},requestId,resume))
  .rejects.toMatchObject({reason:'RUNTIME_ORGANIZER_PENDING'});
 expect(resume).not.toHaveBeenCalled();
});

it('allows the new message only after an exhausted original wait has been cancelled',async()=>{
 const resume=vi.fn().mockResolvedValue({state:'cancelled'});
 expect(await finishWaitingOrganizer({waitingOrganizer:{...waiting,remainingCalls:0}},requestId,resume)).toBeNull();
 expect(await finishWaitingOrganizer({waitingOrganizer:waiting},requestId,resume))
  .toMatchObject({admitted:false,state:'cancelled'});
});
