/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { createContext, useContext } from 'react';

/**
 * What the fixed product window (StageM) shows: the positioning conversation, the week's conversation, the report, or
 * nothing (a region with its own windows or the plan cards takes the screen). A region names its scene with
 * `data-scene` on its wrapper.
 */
export type SceneM = 'ask' | 'ops' | 'report' | 'none';

/** The week's step on screen: region 3's tabs set it, the fixed window shows that step's conversation. */
export const OpsStepContext = createContext<{ step: number; setStep: (step: number) => void }>({ step: 0, setStep: () => undefined });

export const useOpsStep = () => useContext(OpsStepContext);
