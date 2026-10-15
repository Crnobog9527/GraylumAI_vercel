/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import type { AdoptProposed, AdoptRecorded, JuryDetail } from './jury-events';
import {
  adoptErrorLabel, choosable, chosenCount, isComplete, mockConfirm, mockPropose, needsConfirm, setConfirmed, setUse, toChoices, type Use,
} from './jury-adopt';
import { useDraftChoices } from './use-draft-choices';

export type Stale = 'none' | 'report' | 'proposal';

/**
 * Chapter choices in two steps, shaped after fusionReview.adopt and confirmAdoption (contract v6): choose per chapter,
 * then look at the field changes and the steps confirmed with them, then apply or decline. Mock calls only. The
 * result page draws it; this holds the state and the rules.
 */
export function useAdoption(detail: JuryDetail) {
  const sections = detail.summary.sections;
  const { state, setState, clear } = useDraftChoices(detail.reviewId);
  const [proposal, setProposal] = useState<AdoptProposed | null>(null);
  const [result, setResult] = useState<AdoptRecorded | null>(detail.adoption);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<Stale>('none');
  const [later, setLater] = useState(false);

  const propose = () => {
    if (stale === 'report') { setError(adoptErrorLabel('REPORT_REVISION_STALE')); return; }
    if (!isComplete(state, sections)) {
      const unconfirmed = choosable(sections).some(item => needsConfirm(item, state));
      setError(adoptErrorLabel(unconfirmed ? 'FUSION_ADOPTION_CONFIRM_REQUIRED' : 'FUSION_ADOPTION_INCOMPLETE'));
      return;
    }
    setError(null);
    const answer = mockPropose(sections, toChoices(state, sections));
    if (answer.state === 'recorded') { clear(); setResult(answer); } else setProposal(answer);
  };
  const confirm = (decision: 'apply' | 'decline') => {
    if (!proposal) return;
    if (decision === 'apply' && stale === 'proposal') {
      // The proposal the user saw is outdated: drop it, so the next look fetches and shows the new one.
      setProposal(null);
      setStale('none');
      setError(adoptErrorLabel('FUSION_ADOPTION_STALE'));
      return;
    }
    setError(null);
    clear();
    setResult(mockConfirm(proposal, decision));
  };

  return {
    state, proposal, result, error, stale, later,
    total: choosable(sections).length,
    done: chosenCount(state, sections),
    locked: Boolean(result || proposal),
    use: (section: string, use: Use) => { setState(value => setUse(value, sections, section, use)); setError(null); },
    setConfirmed: (section: string, confirmed: boolean) => setState(value => setConfirmed(value, section, confirmed)),
    propose, confirm, setStale,
    back: () => { setProposal(null); setError(null); },
    putOff: () => setLater(true),
  };
}

export type Adoption = ReturnType<typeof useAdoption>;
