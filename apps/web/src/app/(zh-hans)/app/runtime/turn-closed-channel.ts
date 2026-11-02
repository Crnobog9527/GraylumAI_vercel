/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2: a turn's freeze is released when it closes, in whichever tab ran it. The other tabs of this browser are told, so a balance
 * read while that freeze was held is read again. No timer: one message per close. (A tab that never hears it, another browser or device, reads
 * again when the window is back.)
 */
const NAME = 'opc-turn-closed';
type Channel = Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'>;
const open = (): Channel | null => typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(NAME);

export function announceTurnClosed() {
  const channel = open();
  if (!channel) return;
  channel.postMessage('closed');
  channel.close();
}

/** Calls `onClosed` when another tab announces a close; returns the stop function. */
export function onTurnClosed(onClosed: () => void) {
  const channel = open();
  if (!channel) return () => {};
  channel.onmessage = () => onClosed();
  return () => channel.close();
}
