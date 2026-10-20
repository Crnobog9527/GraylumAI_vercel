/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { notFound } from 'next/navigation';
import { AgentFirstWorkspaceSample } from './agent-first-workspace-sample';

export default function AgentFirstPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <AgentFirstWorkspaceSample />;
}
