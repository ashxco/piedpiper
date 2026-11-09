import type { AgentSessionProjectCandidate } from "@piedpiper/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  addAgentSessionProjects,
  defaultAgentSessionProjectSelection,
  describeAgentSessionProject,
} from "../agentSessionProjects.logic";
import { findExistingProjectByPath } from "../hooks/useAddProjectFromPath";
import { dispatchProjectArchived, isProjectArchived } from "../lib/projectArchive";
import { newCommandId, newProjectId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { RelativeTime } from "./RelativeTime";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

async function createProject(candidate: AgentSessionProjectCandidate): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("Not connected to the server.");
  // The scan ran a moment ago, so a project added since then is not an error.
  const existing = findExistingProjectByPath(useStore.getState().projects, candidate.path);
  if (existing) {
    // Returning early would skip the unarchive the server does on project.create.
    if (isProjectArchived(existing)) await dispatchProjectArchived(api, existing.id, null);
    return;
  }
  await api.orchestration.dispatchCommand({
    type: "project.create",
    commandId: newCommandId(),
    projectId: newProjectId(),
    title: candidate.title,
    workspaceRoot: candidate.path,
    defaultModelSelection: null,
    createdAt: new Date().toISOString(),
  });
}

/** Scans on open: suggesting folders means reading transcripts, so it only runs when asked. */
export function AgentSessionProjectPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [isAdding, setIsAdding] = useState(false);
  return (
    <Dialog
      open={open}
      // Closing mid-batch would not stop it, and it would then close a reopened picker.
      onOpenChange={(nextOpen) => {
        if (nextOpen || !isAdding) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!isAdding}>
        <AgentSessionProjectPickerContent
          isAdding={isAdding}
          onAddingChange={setIsAdding}
          onClose={() => onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function AgentSessionProjectPickerContent({
  isAdding,
  onAddingChange,
  onClose,
}: {
  isAdding: boolean;
  onAddingChange: (isAdding: boolean) => void;
  onClose: () => void;
}) {
  const scanQuery = useQuery({
    queryKey: ["agentSessionProjectScan"],
    queryFn: () => {
      const api = readNativeApi();
      if (!api) throw new Error("Not connected to the server.");
      return api.projects.scanAgentSessions();
    },
    // The scan is local, so being offline must not park it as pending.
    networkMode: "always",
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [addedPaths, setAddedPaths] = useState<ReadonlySet<string>>(new Set());

  const candidates = (scanQuery.data?.candidates ?? []).filter(
    (candidate) => !addedPaths.has(candidate.path),
  );
  // Untouched until the user changes something, so the defaults apply once the scan lands.
  // Measured from when the scan landed, since a running session writes after the dialog opens.
  const selected =
    selection ?? defaultAgentSessionProjectSelection(candidates, scanQuery.dataUpdatedAt);
  const selectedCandidates = candidates.filter((candidate) => selected.has(candidate.path));

  const toggle = (path: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(path);
    else next.delete(path);
    setSelection(next);
  };

  const addSelected = async () => {
    onAddingChange(true);
    const { added, failed } = await addAgentSessionProjects(selectedCandidates, createProject);
    onAddingChange(false);
    setAddedPaths(new Set([...addedPaths, ...added]));
    if (added.length > 0) {
      toastManager.add({
        type: "success",
        title: added.length === 1 ? "Added 1 project" : `Added ${added.length} projects`,
      });
    }
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title:
          failed.length === 1
            ? "Failed to add 1 project"
            : `Failed to add ${failed.length} projects`,
        description: failed[0]?.message,
      });
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add projects from Claude Code and Codex</DialogTitle>
        <DialogDescription>
          Folders you have worked in, found in your local session history. Only the folder paths are
          used; nothing from your sessions is stored.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {scanQuery.isPending ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Looking for projects...</p>
        ) : scanQuery.isError ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-destructive">
              {scanQuery.error instanceof Error ? scanQuery.error.message : "The scan failed."}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => scanQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {candidates.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No new projects found in your session history.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {selectedCandidates.length} of {candidates.length} selected
                  </p>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={isAdding}
                      onClick={() =>
                        setSelection(new Set(candidates.map((candidate) => candidate.path)))
                      }
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={isAdding}
                      onClick={() => setSelection(new Set())}
                    >
                      Select none
                    </Button>
                  </div>
                </div>
                <div className="max-h-80 divide-y divide-border/40 overflow-y-auto rounded-lg border border-border/60">
                  {candidates.map((candidate) => (
                    <AgentSessionProjectRow
                      key={candidate.path}
                      candidate={candidate}
                      checked={selected.has(candidate.path)}
                      disabled={isAdding}
                      onCheckedChange={(checked) => toggle(candidate.path, checked)}
                    />
                  ))}
                </div>
              </>
            )}
            {scanQuery.data?.truncated ? (
              <p className="text-xs text-muted-foreground">
                Some sessions could not be checked, so this list may be incomplete.
              </p>
            ) : null}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" disabled={isAdding} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isAdding || selectedCandidates.length === 0}
          onClick={() => void addSelected()}
        >
          {isAdding
            ? "Adding..."
            : selectedCandidates.length === 1
              ? "Add 1 project"
              : `Add ${selectedCandidates.length} projects`}
        </Button>
      </DialogFooter>
    </>
  );
}

function AgentSessionProjectRow({
  candidate,
  checked,
  disabled,
  onCheckedChange,
}: {
  candidate: AgentSessionProjectCandidate;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent/50">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {candidate.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground" title={candidate.path}>
          {candidate.path}
        </span>
        <span className="block text-xs text-muted-foreground/70">
          {describeAgentSessionProject(candidate)}
          {candidate.lastActiveAt ? (
            <>
              {", "}
              <RelativeTime timestamp={candidate.lastActiveAt} />
            </>
          ) : null}
        </span>
      </span>
    </label>
  );
}
