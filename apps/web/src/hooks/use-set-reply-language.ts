/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import type { ReplyLocale } from '@repo/api/src/shared/replyLanguage';
import { trpc } from '@/trpc/client';

/**
 * CHAT-LANGUAGE: how the top-bar switch changes the AI reply language. `shown` is the
 * language being saved while the save runs, then the saved one; choosing the current language does nothing.
 */
export function useSetReplyLanguage(current: ReplyLocale | undefined) {
  const utils = trpc.useUtils();
  const [failed, setFailed] = useState(false);
  const save = trpc.user.setReplyLanguage.useMutation({
    onMutate: () => setFailed(false),
    onSuccess: () => utils.user.getUserProfile.invalidate(),
    onError: () => setFailed(true),
  });
  const shown = save.isPending && save.variables ? save.variables.language : current;
  const choose = (language: ReplyLocale) => { if (language !== current) save.mutate({ language }); };
  return { shown, choose, saving: save.isPending, failed };
}
