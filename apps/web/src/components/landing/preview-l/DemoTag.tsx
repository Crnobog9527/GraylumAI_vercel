/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import picture from './picture-l.module.css';

/** The pictures are examples: said above each one, never on top of its content (round six). */
export function DemoTag() {
  return <span className={picture.tag}>{DEMO_LABEL}</span>;
}
