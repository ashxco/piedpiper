import { useEffect, useRef, useState } from "react";

import {
  addMountedDiffFileKeys,
  DIFF_SCROLLER_SELECTOR,
  LAZY_DIFF_FILE_MOUNT_ROOT_MARGIN_PX,
  LAZY_DIFF_FILE_MOUNTS_PER_FRAME,
  pickDiffFileKeysToMount,
  resolveMountedDiffFileKeys,
  shouldLazyMountDiffFiles,
} from "../lib/lazyDiffFileMount";
import { useStableCallback } from "./useStableCallback";
import { useDiffFileEviction } from "./useDiffFileEviction";

/** Set by DiffPanelFilePlaceholder, naming the file it stands in for. */
const DIFF_FILE_PLACEHOLDER_KEY_ATTRIBUTE = "data-diff-file-placeholder";

const NO_KEYS: ReadonlySet<string> = new Set();

/** The placeholders in range, mounted a few each frame, nearest the viewport first. */
function createDiffFileMountQueue(mountFiles: (keys: ReadonlyArray<string>) => void) {
  const placeholders = new Map<string, Element>();
  let scroller: Element | null = null;
  let frameId = 0;
  const drain = () => {
    frameId = 0;
    if (!scroller || placeholders.size === 0) return;
    mountFiles(
      pickDiffFileKeysToMount(
        Array.from(placeholders, ([key, element]) => {
          const { top, bottom } = element.getBoundingClientRect();
          return { key, top, bottom };
        }),
        scroller.getBoundingClientRect(),
        LAZY_DIFF_FILE_MOUNTS_PER_FRAME,
      ),
    );
    // A file leaves when its placeholder goes, not here. So a slow commit holds back the next files,
    // and a reset that drops this update has the file asked for again rather than lost.
    frameId = window.requestAnimationFrame(drain);
  };
  return {
    enter(key: string, placeholder: Element, root: Element) {
      placeholders.set(key, placeholder);
      scroller = root;
      if (frameId === 0) frameId = window.requestAnimationFrame(drain);
    },
    leave(key: string) {
      placeholders.delete(key);
    },
    cancel() {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
      placeholders.clear();
    },
  };
}

/**
 * Which files of a long patch have a viewer. A file nearing the viewport waits its turn for one, so
 * a fast scroll only pays for where it stops. A file in `requiredKeys` or passed to `mountFiles` gets
 * one straight away. Distant viewers can be evicted again unless the file is required.
 */
export function useLazyDiffFileMount(input: {
  resetKey: string;
  fileKeys: ReadonlyArray<string>;
  /** Files something is about to look inside, wherever they are scrolled to. */
  requiredKeys: Iterable<string>;
}) {
  const { resetKey, fileKeys, requiredKeys } = input;
  const [state, setState] = useState({ resetKey, keys: NO_KEYS });
  const currentKeys = state.resetKey === resetKey ? state.keys : NO_KEYS;
  const mountedKeys = resolveMountedDiffFileKeys(currentKeys, { fileKeys, requiredKeys });
  // In render, so a required file never commits as a placeholder first.
  if (state.resetKey !== resetKey || mountedKeys !== state.keys) {
    setState({ resetKey, keys: mountedKeys });
  }

  const mountFiles = useStableCallback((keys: Iterable<string>) => {
    setState((current) => {
      const keysAfter = addMountedDiffFileKeys(current.keys, keys);
      return keysAfter === current.keys ? current : { ...current, keys: keysAfter };
    });
  });

  const unmountFiles = useStableCallback((keys: ReadonlyArray<string>) => {
    setState((current) => {
      const next = new Set(current.keys);
      for (const key of keys) next.delete(key);
      return next.size === current.keys.size ? current : { ...current, keys: next };
    });
  });
  const active = shouldLazyMountDiffFiles(fileKeys.length);
  const observeMountedFile = useDiffFileEviction({ enabled: active, requiredKeys, unmountFiles });

  const scrollerObserverRef = useRef<{ root: Element; observer: IntersectionObserver } | null>(
    null,
  );
  const [mountQueue] = useState(() => createDiffFileMountQueue(mountFiles));

  useEffect(
    () => () => {
      mountQueue.cancel();
      scrollerObserverRef.current?.observer.disconnect();
      scrollerObserverRef.current = null;
    },
    [mountQueue],
  );

  /** A ref callback for placeholders. One observer serves them all. */
  const observePlaceholder = useStableCallback((element: HTMLElement | null) => {
    const root = element?.closest(DIFF_SCROLLER_SELECTOR);
    if (!element || !root) return undefined;
    if (scrollerObserverRef.current?.root !== root) {
      scrollerObserverRef.current?.observer.disconnect();
      const margin = `${LAZY_DIFF_FILE_MOUNT_ROOT_MARGIN_PX}px`;
      scrollerObserverRef.current = {
        root,
        observer: new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const key = entry.target.getAttribute(DIFF_FILE_PLACEHOLDER_KEY_ATTRIBUTE);
              if (key === null) continue;
              if (entry.isIntersecting) mountQueue.enter(key, entry.target, root);
              else mountQueue.leave(key);
            }
          },
          { root, rootMargin: `${margin} 0px ${margin} 0px` },
        ),
      };
    }
    const { observer } = scrollerObserverRef.current;
    observer.observe(element);
    return () => {
      observer.unobserve(element);
      const key = element.getAttribute(DIFF_FILE_PLACEHOLDER_KEY_ATTRIBUTE);
      if (key !== null) mountQueue.leave(key);
    };
  });

  return {
    /** False for an ordinary diff, where every shown file is mounted. */
    active,
    mountedKeys,
    mountFiles,
    observePlaceholder,
    observeMountedFile,
  };
}
