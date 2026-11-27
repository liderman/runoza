import { useCallback, useLayoutEffect, useRef } from "react";
/** Stable event handler, with the state from the latest committed render. */
export function useEventCallback<A extends unknown[], R>(
  callback: (...args: A) => R,
) {
  const current = useRef(callback);
  useLayoutEffect(() => {
    current.current = callback;
  });
  return useCallback((...args: A) => current.current(...args), []);
}
