/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * ENTITLEMENTS PR-2: the admin draft of one membership plan's permissions. Storage is entered
 * in decimal MB (1 MB = 1,000,000 bytes, plan P1) and saved as exact integer bytes. These checks
 * only help the admin; the server (`updateMembershipPlan`, `updateSystemSettings`) is the authority.
 */
export type MembershipPlanRow = {
  id: string;
  name: string;
  level: string;
  allow_export: string;
  allow_batch_export: string;
  allow_fusion_review: boolean;
  allow_fusion_compare: boolean;
  library_storage_bytes: number;
};

export type PlanDraft = {
  allowExport: boolean;
  allowBatchExport: boolean;
  allowFusionReview: boolean;
  allowFusionCompare: boolean;
  /** Decimal MB as typed. */
  storageMb: string;
};

export const BYTES_PER_MB = 1_000_000;
const MB_INPUT = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/;
export const FUSION_COMPARE_MIN = 2;
export const FUSION_COMPARE_MAX = 8;

/** Exact MB text for a byte count (no rounding: up to six decimals). */
export function bytesToMbText(bytes: number): string {
  const whole = Math.floor(bytes / BYTES_PER_MB);
  const fraction = String(bytes % BYTES_PER_MB).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Exact bytes for a decimal MB input, or null when it is not a valid non-negative amount. */
export function mbTextToBytes(text: string): number | null {
  const match = MB_INPUT.exec(text.trim());
  if (!match) return null;
  const fraction = (match[2] ?? '.').slice(1).padEnd(6, '0');
  const bytes = Number(match[1]) * BYTES_PER_MB + Number(fraction);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** Readable size: "2 GB（2,000,000,000 字节）", decimal units. */
export function describeBytes(bytes: number): string {
  const exact = `${bytes.toLocaleString('en-US')} 字节`;
  if (bytes === 0) return '0（不允许新增上传，已有资料仍可查看和删除）';
  const unit = bytes >= 1_000_000_000 ? { size: 1_000_000_000, name: 'GB' } : { size: BYTES_PER_MB, name: 'MB' };
  const value = Number((bytes / unit.size).toFixed(3));
  return `${value} ${unit.name}（${exact}）`;
}

export function planDraftFromRow(plan: MembershipPlanRow): PlanDraft {
  return {
    allowExport: plan.allow_export === 'true',
    allowBatchExport: plan.allow_batch_export === 'true',
    allowFusionReview: plan.allow_fusion_review,
    allowFusionCompare: plan.allow_fusion_compare,
    storageMb: bytesToMbText(plan.library_storage_bytes),
  };
}

export function storageProblem(draft: PlanDraft): string | null {
  return mbTextToBytes(draft.storageMb) === null ? '请填写不小于 0 的数字（单位 MB，最多 6 位小数）' : null;
}

/** The `admin.updateMembershipPlan` input for a valid draft; every permission field is sent explicitly. */
export function planUpdateInput(id: string, draft: PlanDraft) {
  const bytes = mbTextToBytes(draft.storageMb);
  if (bytes === null) return null;
  return {
    id,
    allowExport: draft.allowExport ? 'true' as const : 'false' as const,
    allowBatchExport: draft.allowBatchExport ? 'true' as const : 'false' as const,
    allowFusionReview: draft.allowFusionReview,
    allowFusionCompare: draft.allowFusionCompare,
    libraryStorageBytes: bytes,
  };
}

/**
 * The saved compare limit as the server reads it (a JSON integer 2–8), or null when it is missing or
 * invalid; the server then refuses new Fusion requests, so the page must not show a guessed value.
 */
export function readFusionCompareLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= FUSION_COMPARE_MIN && value <= FUSION_COMPARE_MAX
    ? value : null;
}

export function fusionCompareInput(text: string): number | null {
  return /^[0-9]+$/.test(text.trim()) ? readFusionCompareLimit(Number(text.trim())) : null;
}
