import { useEffect, useState } from "react";

import {
  DIFF_SCROLLER_SELECTOR,
  LAZY_DIFF_FILE_EVICTION_DELAY_MS,
  LAZY_DIFF_FILE_RETAIN_MARGIN_PX,
} from "../lib/lazyDiffFileMount";
import { useStableCallback } from "./useStableCallback";

type MountedFile = {
  key: string;
  element: HTMLElement;
  preserveHeight: (height: number) => void;
};

function createDiffFileEvictionObserver(
  evict: (files: ReadonlySet<MountedFile>, root: Element) => void,
) {
  let observer: IntersectionObserver | null = null;
  let root: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mounted = new Map<Element, MountedFile>();
  const distant = new Set<MountedFile>();
  const schedule = () => {
    if (timer !== undefined || distant.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (root) evict(distant, root);
    }, LAZY_DIFF_FILE_EVICTION_DELAY_MS);
  };
  const disconnect = () => {
    clearTimeout(timer);
    timer = undefined;
    observer?.disconnect();
    observer = null;
    root?.removeEventListener("focusout", schedule);
    root = null;
    mounted.clear();
    distant.clear();
  };
  return {
    schedule,
    disconnect,
    observe(element: HTMLElement, preserveHeight: MountedFile["preserveHeight"]) {
      const nextRoot = element.closest(DIFF_SCROLLER_SELECTOR);
      const key = element.getAttribute("data-diff-file-block");
      if (!nextRoot || key === null) return undefined;
      if (root !== nextRoot) {
        disconnect();
        root = nextRoot;
        root.addEventListener("focusout", schedule);
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const file = mounted.get(entry.target);
              if (!file) continue;
              if (entry.isIntersecting) distant.delete(file);
              else distant.add(file);
            }
            schedule();
          },
          { root, rootMargin: `${LAZY_DIFF_FILE_RETAIN_MARGIN_PX}px 0px` },
        );
      }
      const file = { key, element, preserveHeight };
      mounted.set(element, file);
      observer?.observe(element);
      return () => {
        observer?.unobserve(element);
        if (mounted.get(element) === file) {
          mounted.delete(element);
          distant.delete(file);
        }
      };
    },
  };
}

export type ObserveMountedDiffFile = ReturnType<typeof createDiffFileEvictionObserver>["observe"];

/** One observer and timer for the panel, regardless of how many viewers it holds. */
export function useDiffFileEviction(input: {
  enabled: boolean;
  requiredKeys: Iterable<string>;
  unmountFiles: (keys: ReadonlyArray<string>) => void;
}) {
  const evict = useStableCallback((files: ReadonlySet<MountedFile>, root: Element) => {
    if (!input.enabled) return;
    const required = new Set(input.requiredKeys);
    const viewport = root.getBoundingClientRect();
    const keys: string[] = [];
    // Read all heights before updating React, so an eviction never measures a half-swapped list.
    for (const { key, element, preserveHeight } of files) {
      if (required.has(key) || element.contains(document.activeElement)) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.bottom >= viewport.top - LAZY_DIFF_FILE_RETAIN_MARGIN_PX &&
        rect.top <= viewport.bottom + LAZY_DIFF_FILE_RETAIN_MARGIN_PX
      )
        continue;
      // The border stays on the wrapper; the replacement occupies only its content box.
      const style = getComputedStyle(element);
      preserveHeight(
        rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
      );
      keys.push(key);
    }
    if (keys.length > 0) input.unmountFiles(keys);
  });
  const [manager] = useState(() => createDiffFileEvictionObserver(evict));
  // A formerly required file may now be evictable even without another intersection event.
  useEffect(() => manager.schedule());
  useEffect(() => () => manager.disconnect(), [manager]);
  return manager.observe;
}
