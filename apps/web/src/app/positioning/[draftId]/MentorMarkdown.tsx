/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { stoppedCut } from "./stop-reply";

export function MentorMarkdown({ text, live, result = {}, className }: {
  text: string;
  live: boolean;
  result?: { stopped?: boolean; completeness?: string };
  className?: string;
}) {
  // A saved cut is still partial Markdown: keep the same presentation after the
  // live snapshot disappears and on reload, without changing the stored prefix.
  return <MessageMarkdown text={text} streaming={live || stoppedCut(result)} className={className}/>;
}
