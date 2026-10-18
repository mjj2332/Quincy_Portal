import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The latest committed `value`, for a callback that outlives the render it came from (an observer, a cached ref callback). Written
 * in a layout effect, never during render: a render React discards (a suspended transition, a StrictMode replay) must not leak its
 * value into a callback that runs later.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => { ref.current = value; });
  return ref;
}
