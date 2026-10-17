/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode, Ref } from "react";
import { PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import resultStyles from "@/components/opc/positioning-result.module.css";

/**
 * Display-only pieces of the positioning workspace: page header, step strip and the right-hand
 * checklist column. They take data and callbacks only (no queries, no sign-in), so the product
 * page and the landing page render the same markup.
 */

/** Title row of the positioning page: title, platform and state, work info, and reopening the right column. */
export function PositioningHeader({ title, status, onWorkInfo, showExpand, onExpand, headingLevel: Heading = 'h1' }: {
  title: string;
  /** The product page's title is its H1; a page that shows this header as an example under its own H1 passes 'h2'. */
  headingLevel?: 'h1' | 'h2';
  /** For example "整体规划 · 进行中". */
  status: string;
  onWorkInfo?: () => void;
  /** True while the right column is closed. */
  showExpand?: boolean;
  onExpand?: () => void;
}) {
  return (
    <header className={resultStyles.positionTop}>
      <Heading>{title}</Heading>
      <div className={resultStyles.positionActions}>
        <span>{status}</span>
        <button type="button" onClick={onWorkInfo}>工作信息</button>
        {showExpand && <button type="button" aria-label="展开右边栏" onClick={onExpand}><PanelRightOpen size={18}/></button>}
      </div>
    </header>
  );
}

export type PositioningStepChip = { id: string; title: string; valid: boolean; disabled?: boolean };

/** One button per positioning step; the selected one is filled, a confirmed one carries a check. */
export function PositioningStepStrip({ steps, selectedId, onSelect }: {
  steps: PositioningStepChip[];
  selectedId: string;
  onSelect?: (stepId: string) => void;
}) {
  return (
    <nav aria-label="定位步骤" className={resultStyles.phaseStrip} style={{gridTemplateColumns:`repeat(${steps.length},minmax(0,1fr))`}}>
      {steps.map((step, index) => (
        <Button
          key={step.id}
          variant={selectedId === step.id ? "default" : "outline"}
          aria-current={selectedId === step.id ? "step" : undefined}
          disabled={step.disabled}
          onClick={() => onSelect?.(step.id)}
        >
          {step.valid ? "✓ " : `${index + 1} `}{step.title}
        </Button>
      ))}
    </nav>
  );
}

/** The right column frame ("定位清单"); the checklist itself is `CaptureChecklist`. */
export function PositioningResultPanel({ subtitle, bodyRef, children }: {
  subtitle: string;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div className={resultStyles.panel}><header><h2>定位清单</h2><p>{subtitle}</p></header>
      <div className={resultStyles.body} ref={bodyRef}>{children}</div></div>
  );
}
