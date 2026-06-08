// React hook for consuming the lib/i18n layer.
//
// Calls translate() through a `useSyncExternalStore`-style version
// counter, so every setLocale() flips a number and every component
// using `t = useT()` re-renders.
//
// Pattern instead of `useState + useEffect`:
//   - one subscription per consumer is fine for the chat shell's
//     handful of UI strings
//   - keeps `t` referentially stable between renders within the
//     same locale so memoised children don't re-render needlessly

import { useSyncExternalStore } from "react";
import {
  getLocale,
  subscribeLocale,
  translate,
  type Locale,
  type TranslationKey,
} from "../lib/i18n";

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function useT(): (key: TranslationKey) => string {
  // Re-bind translate on every locale change. Returning `translate`
  // verbatim wouldn't trigger a re-render because the function
  // identity is stable; reading the locale through the store
  // ensures consumers re-render when it flips.
  useLocale();
  return translate;
}
