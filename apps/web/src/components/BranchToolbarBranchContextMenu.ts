import type { ContextMenuItem, NativeApi } from "@piedpiper/contracts";
import type { MouseEvent as ReactMouseEvent } from "react";

import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "./ui/toast";

const COPY_BRANCH_NAME_ACTION = "copy-branch-name";
const BRANCH_NAME_CONTEXT_MENU_ITEMS: ContextMenuItem<typeof COPY_BRANCH_NAME_ACTION>[] = [
  { id: COPY_BRANCH_NAME_ACTION, label: "Copy branch name" },
];

export type BranchNameContextMenuResult = "copied" | "cancelled";

/** Shows the branch-name menu and copies the name when chosen; rejects when the copy fails. */
export async function runBranchNameContextMenu(input: {
  api: Pick<NativeApi, "contextMenu">;
  branchName: string;
  position: { x: number; y: number };
  copy?: (value: string) => Promise<void>;
}): Promise<BranchNameContextMenuResult> {
  const choice = await input.api.contextMenu.show(BRANCH_NAME_CONTEXT_MENU_ITEMS, input.position);
  if (choice !== COPY_BRANCH_NAME_ACTION) return "cancelled";
  await (input.copy ?? writeTextToClipboard)(input.branchName);
  return "copied";
}

/** Right-click handler for branch triggers and rows: offers "Copy branch name" with a toast. */
export function openBranchNameContextMenu(event: ReactMouseEvent, branchName: string | null) {
  if (!branchName) return;
  const api = readNativeApi();
  if (!api) return;
  event.preventDefault();
  event.stopPropagation();
  void runBranchNameContextMenu({
    api,
    branchName,
    position: { x: event.clientX, y: event.clientY },
  }).then(
    (result) => {
      if (result !== "copied") return;
      toastManager.add({ type: "success", title: "Branch name copied", description: branchName });
    },
    (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy branch name",
        description: error instanceof Error ? error.message : "Clipboard unavailable.",
      });
    },
  );
}
