/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { mentorScenario } from './lib/mentor.mjs';
// The worst case of a freeze at one call (Owner 11-01): the first freeze is too small, so every paid call tops up in turn_call_begin.
export default mentorScenario({ name: 'new:mentor-top-up', accountBound: false, holdCredits: 1 });
