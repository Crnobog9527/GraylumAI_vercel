/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import type { AdoptChoice, AdoptProposed, AdoptRecorded, DetailSection, JuryDetail } from './jury-events';
import {
  adoptErrorLabel, choosable, chosenCount, isComplete, mockConfirm, mockPropose, needsConfirm, recordedState, setConfirmed, setUse, toChoices, unconfirmedSections,
  type Use,
} from './jury-adopt';
import { useDraftChoices } from './use-draft-choices';

export type Stale = 'none' | 'report' | 'proposal';

/**
 * The two server steps of the chapter choice (fusionReview.adopt and confirmAdoption). A refusal is thrown as an
 * Error whose message is the refusal code. The prototype answers with mock data; the real page calls the API.
 */
export type AdoptActions = {
  propose: (input: { requestId: string; choices: AdoptChoice[]; sections: readonly DetailSection[] }) => Promise<AdoptProposed | AdoptRecorded>;
  confirm: (input: { requestId: string; choices: AdoptChoice[]; proposal: AdoptProposed; decision: 'apply' | 'decline' }) => Promise<AdoptRecorded>;
  /** The choice was already recorded elsewhere (another tab): read the review again to show it. */
  onRecordedElsewhere?: () => void;
};

export const MOCK_ADOPT_ACTIONS: AdoptActions = {
  propose: async ({ sections, choices }) => mockPropose(sections, choices),
  confirm: async ({ proposal, decision }) => mockConfirm(proposal, decision),
};

const codeOf = (error: unknown) => (error instanceof Error ? error.message : '');
const newRequestId = () => crypto.randomUUID();

/**
 * Chapter choices in two steps, shaped after fusionReview.adopt and confirmAdoption (contract v6): choose per chapter,
 * then look at the field changes and the steps confirmed with them, then apply or decline. One request at a time, so
 * a double click submits once. The result page draws it; this holds the state and the rules.
 */
export function useAdoption(detail: JuryDetail, actions: AdoptActions = MOCK_ADOPT_ACTIONS) {
  const sections = detail.summary.sections;
  const { state, setState, clear } = useDraftChoices(detail.reviewId);
  const [proposal, setProposal] = useState<AdoptProposed | null>(null);
  const [result, setResult] = useState<AdoptRecorded | null>(detail.adoption);
  const [error, setError] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  // The proposal and its confirmation share one request id, so a retried confirmation is the same request.
  const requestId = useRef('');

  // A choice recorded elsewhere (another tab, an earlier visit) shows when the review is read again.
  useEffect(() => { if (detail.adoption) setResult(detail.adoption); }, [detail.adoption]);

  const run = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try { await work(); } catch (cause) {
      const code = codeOf(cause);
      if (code === 'FUSION_ADOPTION_STALE') setProposal(null); // outdated: the next look fetches and shows the new one
      if (code === 'FUSION_REVIEW_ADOPTED') { setProposal(null); actions.onRecordedElsewhere?.(); }
      setError(adoptErrorLabel(code));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const propose = () => run(async () => {
    if (!isComplete(state, sections)) {
      const unconfirmed = choosable(sections).some(item => needsConfirm(item, state));
      setError(adoptErrorLabel(unconfirmed ? 'FUSION_ADOPTION_CONFIRM_REQUIRED' : 'FUSION_ADOPTION_INCOMPLETE'));
      return;
    }
    setError(null);
    requestId.current = newRequestId();
    const answer = await actions.propose({ requestId: requestId.current, choices: toChoices(state, sections), sections });
    if (answer.state === 'recorded') { clear(); setResult(answer); } else setProposal(answer);
  });
  const confirm = (decision: 'apply' | 'decline') => run(async () => {
    if (!proposal) return;
    setError(null);
    const recorded = await actions.confirm({ requestId: requestId.current, choices: toChoices(state, sections), proposal, decision });
    clear();
    // A decline answers like "everything kept"; remember it was a decline so the page says so.
    setResult(decision === 'decline' ? { ...recorded, declined: true } : recorded);
  });

  // Once recorded, every chapter shows the choice made then, not this device's (possibly cleared) draft.
  const shown = result ? recordedState(result) : state;
  return {
    state: shown, proposal, result, error, later, busy,
    total: choosable(sections).length,
    done: chosenCount(shown, sections),
    unconfirmed: result ? [] : unconfirmedSections(shown, sections),
    locked: Boolean(result || proposal),
    use: (section: string, use: Use) => { setState(value => setUse(value, sections, section, use)); setError(null); },
    setConfirmed: (section: string, confirmed: boolean) => setState(value => setConfirmed(value, section, confirmed)),
    propose, confirm,
    back: () => { setProposal(null); setError(null); },
    putOff: () => setLater(true),
  };
}

export type Adoption = ReturnType<typeof useAdoption>;
