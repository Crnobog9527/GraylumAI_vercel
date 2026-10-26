/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import resultStyles from "@/components/opc/positioning-result.module.css";
import { REPORT_ACTION, reportActionLabel } from "./report-gen";

export const CHARGE_CONFIRM_TEXT = {
  ask: (price: number) => `确认生成报告？确认后将扣除 ${price.toLocaleString("zh-CN")} 积分。`,
  cancel: "取消",
  confirm: (price: number) => `确认并扣 ${price.toLocaleString("zh-CN")} 积分`,
} as const;

/**
 * 先确认再扣 (Owner): every way into a paid report start (first generation, 重新生成 after a failed one, the first
 * report of a revision round) asks first, with the same fixed price and no estimate. One confirmation starts one request;
 * the gate lets only the first click through until the offer changes (a double click starts nothing twice).
 */
export function createChargeGate() {
  let asking = false, used = false;
  return {
    asking: () => asking,
    ask: () => { asking = true; used = false; },
    cancel: () => { asking = false; },
    /** True for the first confirmation only; the box closes either way. */
    confirm: () => {
      const first = asking && !used;
      if (first) used = true;
      asking = false;
      return first;
    },
  };
}

/** The pure view: the offer button, or (asking) the confirmation with the fixed price. */
export function ReportChargeView({ asking, retry, price, disabled, onAsk, onCancel, onConfirm }:
  { asking: boolean; retry: boolean; price: number | null | undefined; disabled: boolean;
    onAsk: () => void; onCancel: () => void; onConfirm: () => void }) {
  if (!asking || typeof price !== "number") {
    return (
      <div className={resultStyles.consentActions}>
        <Button disabled={disabled} onClick={onAsk}>{reportActionLabel(retry ? REPORT_ACTION.retry : REPORT_ACTION.start, price)}</Button>
      </div>
    );
  }
  return (
    <div className={resultStyles.consentActions} role="group" aria-label="确认扣费">
      <p>{CHARGE_CONFIRM_TEXT.ask(price)}</p>
      <Button variant="outline" onClick={onCancel}>{CHARGE_CONFIRM_TEXT.cancel}</Button>
      <Button disabled={disabled} onClick={onConfirm}>{CHARGE_CONFIRM_TEXT.confirm(price)}</Button>
    </div>
  );
}

export function ReportChargeAction({ retry, price, busy, onStart }:
  { retry: boolean; price: number | null | undefined; busy: boolean; onStart: () => void }) {
  const gate = useRef(createChargeGate());
  const [asking, setAsking] = useState(false);
  return (
    <ReportChargeView asking={asking} retry={retry} price={price} disabled={busy}
      onAsk={() => { gate.current.ask(); setAsking(true); }}
      onCancel={() => { gate.current.cancel(); setAsking(false); }}
      onConfirm={() => { const go = gate.current.confirm(); setAsking(false); if (go) onStart(); }} />
  );
}
