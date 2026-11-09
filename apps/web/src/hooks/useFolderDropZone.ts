import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from "react";

function hasNativeFileDrop(event: ReactDragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export interface FolderDropHandlers {
  readonly onDragOver: (event: ReactDragEvent) => void;
  readonly onDragEnter: (event: ReactDragEvent) => void;
  readonly onDragLeave: (event: ReactDragEvent) => void;
  readonly onDrop: (event: ReactDragEvent) => void;
}

export interface UseFolderDropZoneResult {
  readonly isDroppingFolder: boolean;
  readonly dropHandlers: FolderDropHandlers;
}

/**
 * Reusable folder drag-and-drop zone. Tracks nested drag enter/leave with a
 * counter so the overlay state stays correct when the cursor moves over child
 * elements, ignores non-file drags, and resolves dropped files to absolute
 * paths via the desktop bridge before invoking the supplied callback.
 *
 * Used by the sidebar so dropping over the project list adds projects.
 */
export function useFolderDropZone(onDropPath: (filePath: string) => void): UseFolderDropZoneResult {
  const [isDroppingFolder, setIsDroppingFolder] = useState(false);
  const dropCounterRef = useRef(0);

  const onDragOver = useCallback((event: ReactDragEvent) => {
    if (!hasNativeFileDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragEnter = useCallback((event: ReactDragEvent) => {
    if (!hasNativeFileDrop(event)) return;
    if (event.target instanceof Element && event.target.closest("[data-file-drop-target]")) {
      dropCounterRef.current = 0;
      setIsDroppingFolder(false);
      return;
    }
    event.preventDefault();
    dropCounterRef.current += 1;
    setIsDroppingFolder(true);
  }, []);

  const onDragLeave = useCallback((_event: ReactDragEvent) => {
    dropCounterRef.current -= 1;
    if (dropCounterRef.current <= 0) {
      dropCounterRef.current = 0;
      setIsDroppingFolder(false);
    }
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent) => {
      event.preventDefault();
      dropCounterRef.current = 0;
      setIsDroppingFolder(false);

      const files = Array.from(event.dataTransfer.files);
      for (const file of files) {
        const filePath = window.desktopBridge?.getPathForFile(file);
        if (filePath) {
          onDropPath(filePath);
        }
      }
    },
    [onDropPath],
  );

  return {
    isDroppingFolder,
    dropHandlers: {
      onDragOver,
      onDragEnter,
      onDragLeave,
      onDrop,
    },
  };
}
