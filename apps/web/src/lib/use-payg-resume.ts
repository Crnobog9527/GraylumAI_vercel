/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  organizerBlockedNotices, paygResumeController, paygTurnNotices,
  type PaygResumeState, type PaygTurn,
} from './payg-wait';
export { openOrganizer } from './payg-wait';

/**
 * The page's BILL-PAYG pauses (see payg-wait.ts) bound to `runtime.resume` and React state.
 * `refetch` re-reads whatever the page shows of the session after every resume; `onResult`
 * sees each resume's answer before that (the report page reads its refusal code from it).
 */
export function usePaygResume(refetch: () => Promise<unknown>, onResult?: (result: unknown) => void) {
  const resume = trpc.runtime.resume.useMutation();
  const latest = useRef({ call: resume.mutateAsync, refetch, onResult });
  latest.current = { call: resume.mutateAsync, refetch, onResult };
  const [state, setState] = useState<PaygResumeState>({ resumingId: null, blockedId: null, outcomes: {} });
  const controller = useMemo(() => paygResumeController({
    call: async token => {
      const result = await latest.current.call(token);
      latest.current.onResult?.(result);
      return result;
    },
    refetch: () => latest.current.refetch(),
    onChange: setState,
  }), []);
  const onResume = (token: Parameters<typeof controller.resume>[0]) => void controller.resume(token);
  return {
    /** A resume is running; the page treats it as busy. */
    busy: state.resumingId !== null,
    admitted: controller.admitted,
    block: controller.block,
    turnNotices: (turn: PaygTurn, disabled?: boolean) => paygTurnNotices(turn, {
      resumingId: state.resumingId, outcome: state.outcomes[turn.executionId], disabled, onResume }),
    blockedNotices: (turns: readonly PaygTurn[] | undefined, disabled?: boolean) =>
      organizerBlockedNotices(turns, state.blockedId, { resumingId: state.resumingId, disabled, onResume }),
  };
}
