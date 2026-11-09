import type { ComposerDropDataTransfer } from "./composerFolderDrop";

export interface WorkspaceFileDragEvent {
  readonly dataTransfer: ComposerDropDataTransfer & {
    readonly types: ReadonlyArray<string>;
    dropEffect: string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  // React's synthetic `defaultPrevented` is a stale snapshot; the native flag is live.
  readonly nativeEvent: { readonly defaultPrevented: boolean };
  preventDefault(): void;
}

export interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
  /** Takes the whole drop so folders and non-image files route as they do on the composer. */
  addDroppedItems?(dataTransfer: ComposerDropDataTransfer): void;
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

/** Drag handlers for the whole chat column; files go through the composer attach path. */
export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      // A nested target (the composer) that already handled the drop owns the files.
      const handledByChild = event.nativeEvent.defaultPrevented;
      event.preventDefault();
      host.setDragActive(false);
      if (handledByChild) return;
      if (host.addDroppedItems) {
        host.addDroppedItems(event.dataTransfer);
        return;
      }
      host.addFiles(Array.from(event.dataTransfer.files));
    },
  };
}

/** Routes a drag event to the matching handler by its type, so one listener serves all four props. */
export function handleWorkspaceFileDragEvent(
  host: WorkspaceFileDropHost,
  event: WorkspaceFileDragEvent & { readonly type: string },
): void {
  const handlers = makeWorkspaceFileDropHandlers(host);
  if (event.type === "dragenter") handlers.onDragEnter(event);
  else if (event.type === "dragover") handlers.onDragOver(event);
  else if (event.type === "dragleave") handlers.onDragLeave(event);
  else if (event.type === "drop") handlers.onDrop(event);
}
