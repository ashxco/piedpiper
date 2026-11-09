import { describe, expect, it, vi } from "vitest";

import {
  handleWorkspaceFileDragEvent,
  makeWorkspaceFileDropHandlers,
  type WorkspaceFileDragEvent,
  type WorkspaceFileDropHost,
} from "./workspaceFileDrop";

function makeDragEvent(options?: {
  types?: string[];
  files?: File[];
  movedWithinTarget?: boolean;
  defaultPrevented?: boolean;
}) {
  const preventDefault = vi.fn();
  const event = {
    dataTransfer: {
      types: options?.types ?? ["Files"],
      files: options?.files ?? [],
      dropEffect: "none",
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    nativeEvent: { defaultPrevented: options?.defaultPrevented ?? false },
    preventDefault,
  } satisfies WorkspaceFileDragEvent;
  return { event, preventDefault };
}

function makeHost() {
  const setDragActive = vi.fn();
  const addFiles = vi.fn();
  const host = { setDragActive, addFiles } satisfies WorkspaceFileDropHost;
  return { host, setDragActive, addFiles };
}

describe("makeWorkspaceFileDropHandlers", () => {
  it("activates the target for an external file drag", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent();

    makeWorkspaceFileDropHandlers(host).onDragEnter(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setDragActive).toHaveBeenCalledWith(true);
  });

  it("marks drag-over as a copy", () => {
    const { host } = makeHost();
    const { event } = makeDragEvent();

    makeWorkspaceFileDropHandlers(host).onDragOver(event);

    expect(event.dataTransfer.dropEffect).toBe("copy");
  });

  it("ignores non-file drags", () => {
    const { host, setDragActive, addFiles } = makeHost();
    const { event, preventDefault } = makeDragEvent({ types: ["text/plain"] });

    const handlers = makeWorkspaceFileDropHandlers(host);
    handlers.onDragOver(event);
    handlers.onDrop(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDragActive).not.toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("does not flicker when the drag moves between children", () => {
    const { host, setDragActive } = makeHost();
    const { event } = makeDragEvent({ movedWithinTarget: true });

    const handlers = makeWorkspaceFileDropHandlers(host);
    handlers.onDragEnter(event);
    handlers.onDragLeave(event);

    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("clears the active state when the drag leaves the column", () => {
    const { host, setDragActive } = makeHost();
    const { event } = makeDragEvent();

    makeWorkspaceFileDropHandlers(host).onDragLeave(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
  });

  it("forwards dropped files and clears the active state", () => {
    const file = new File(["contents"], "example.png", { type: "image/png" });
    const { host, setDragActive, addFiles } = makeHost();
    const { event } = makeDragEvent({ files: [file] });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addFiles).toHaveBeenCalledWith([file]);
  });

  it("does not add files twice when the composer already handled the drop", () => {
    const file = new File(["contents"], "example.png", { type: "image/png" });
    const { host, setDragActive, addFiles } = makeHost();
    const { event } = makeDragEvent({ files: [file], defaultPrevented: true });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("hands the whole drop to the host when it routes dropped items itself", () => {
    const file = new File(["contents"], "notes.ts", { type: "text/plain" });
    const { host, addFiles } = makeHost();
    const addDroppedItems = vi.fn();
    const { event } = makeDragEvent({ files: [file] });

    makeWorkspaceFileDropHandlers({ ...host, addDroppedItems }).onDrop(event);

    expect(addDroppedItems).toHaveBeenCalledWith(event.dataTransfer);
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("routes events to the handler for their type", () => {
    const file = new File(["contents"], "example.png", { type: "image/png" });
    const { host, setDragActive, addFiles } = makeHost();

    handleWorkspaceFileDragEvent(host, { ...makeDragEvent().event, type: "dragenter" });
    expect(setDragActive).toHaveBeenLastCalledWith(true);

    handleWorkspaceFileDragEvent(host, { ...makeDragEvent({ files: [file] }).event, type: "drop" });
    expect(setDragActive).toHaveBeenLastCalledWith(false);
    expect(addFiles).toHaveBeenCalledWith([file]);

    handleWorkspaceFileDragEvent(host, { ...makeDragEvent().event, type: "click" });
    expect(setDragActive).toHaveBeenCalledTimes(2);
  });
});
