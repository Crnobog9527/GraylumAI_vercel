/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
/** Numeric-only accounting of the exact empty-history admission envelope, including escaping. */
export interface ResearchCapacity {
  inputBudgetBytes: number;
  fixedInstructionsBytes: number;
  currentInputHostBytes: number;
  existingToolsBytes: number;
  researchToolsBytes: number;
  researchHostDeltaBytes: number;
  resultReserveBytes: number;
  envelopeReserveBytes: number;
  totalRequiredBytes: number;
  deficitBytes: number;
}

export function researchCapacity(input: {
  instructions: string; currentInput: string; inputBudgetBytes: number; existingToolsBytes: number;
  researchToolsBytes: number; researchHostDeltaBytes: number; resultReserveBytes: number;
}): ResearchCapacity {
  const fixedInstructionsBytes = Buffer.byteLength(JSON.stringify(input.instructions));
  const requestBytes = Buffer.byteLength(JSON.stringify({instructions: input.instructions,
    messages: [{role: 'user', content: input.currentInput}]}));
  const emptyBytes = Buffer.byteLength(JSON.stringify({instructions: '', messages: []}));
  const currentInputHostBytes = requestBytes - fixedInstructionsBytes - emptyBytes;
  const envelopeReserveBytes = emptyBytes + 1024;
  const totalRequiredBytes = requestBytes + 1024 + input.existingToolsBytes + input.researchToolsBytes +
    input.researchHostDeltaBytes + input.resultReserveBytes;
  return {inputBudgetBytes: input.inputBudgetBytes, fixedInstructionsBytes, currentInputHostBytes,
    existingToolsBytes: input.existingToolsBytes, researchToolsBytes: input.researchToolsBytes,
    researchHostDeltaBytes: input.researchHostDeltaBytes, resultReserveBytes: input.resultReserveBytes,
    envelopeReserveBytes, totalRequiredBytes, deficitBytes: Math.max(0, totalRequiredBytes - input.inputBudgetBytes)};
}
