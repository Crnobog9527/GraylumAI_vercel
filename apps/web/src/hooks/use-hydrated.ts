/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False while the page is still the server-rendered HTML, true once the browser's scripts have taken it over. A server-rendered form
 * can be filled and clicked long before its submit handler exists; that click submits the form natively. A submit button that is off
 * until this is true cannot be clicked in that gap, and pressing Enter in a field does nothing while the default button is off.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
