import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@piedpiper/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitForkIcon,
  InfoIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { GitHubIcon } from "./Icons";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { toastManager, type ThreadToastData } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitQueryKeys,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitStatusQuery,
} from "~/lib/gitReactQuery";
import { newCommandId, randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadId: ThreadId | null;
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  statusOverride?: GitStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasOriginRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: checkout a branch before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (hasOpenPr) {
    return "View PR is currently unavailable.";
  }
  if (!hasBranch) {
    return "Detached HEAD: checkout a branch before creating a PR.";
  }
  if (hasChanges) {
    return "Commit local changes before creating a PR.";
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return 'Add an "origin" remote before creating a PR.';
  }
  if (!isAhead) {
    return "No local commits to include in a PR.";
  }
  if (isBehind) {
    return "Branch is behind upstream. Pull/rebase before creating a PR.";
  }
  return "Create PR is currently unavailable.";
}

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <GitHubIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <InfoIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <GitHubIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

export default function GitActionsControl({ gitCwd, activeThreadId }: GitActionsControlProps) {
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const activeServerThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [showRemoteSetup, setShowRemoteSetup] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [isAddingRemote, setIsAddingRemote] = useState(false);
  const [ghStatus, setGhStatus] = useState<{
    installed: boolean;
    authenticated: boolean;
  } | null>(null);
  const [ghRepoName, setGhRepoName] = useState("");
  const [ghRepoVisibility, setGhRepoVisibility] = useState<"public" | "private">("private");
  const [isCreatingGhRepo, setIsCreatingGhRepo] = useState(false);
  useEffect(() => {
    if (!showRemoteSetup || !gitCwd) {
      return;
    }
    let cancelled = false;
    setGhStatus(null);
    const api = readNativeApi();
    if (!api) return;
    void api.git
      .gitHubCliStatus({ cwd: gitCwd })
      .then((status) => {
        if (!cancelled) setGhStatus(status);
      })
      .catch(() => {
        if (!cancelled) setGhStatus({ installed: false, authenticated: false });
      });
    // Default repo name from cwd basename
    const segments = gitCwd.split(/[\\/]/);
    const basename = segments.findLast((segment) => segment.length > 0) ?? "";
    setGhRepoName(basename);
    return () => {
      cancelled = true;
    };
  }, [showRemoteSetup, gitCwd]);
  const submitAddRemote = useCallback(async () => {
    const url = remoteUrl.trim();
    if (!url || !gitCwd) return;
    setIsAddingRemote(true);
    try {
      const api = readNativeApi();
      if (!api) return;
      await api.git.addRemote({ cwd: gitCwd, url });
      await queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(gitCwd) });
      toastManager.add({
        type: "success",
        title: "Added origin remote",
        description: url,
        data: threadToastData,
      });
      setShowRemoteSetup(false);
      setRemoteUrl("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to add remote",
        description: error instanceof Error ? error.message : "An error occurred",
        data: threadToastData,
      });
    } finally {
      setIsAddingRemote(false);
    }
  }, [gitCwd, queryClient, remoteUrl, threadToastData]);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  let runGitActionWithToast: (input: RunGitActionWithToastInput) => Promise<void>;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadId || !activeServerThread || activeServerThread.branch === branch) {
        return;
      }

      const worktreePath = activeServerThread.worktreePath;
      const api = readNativeApi();
      if (api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: activeThreadId,
            branch,
            worktreePath,
          })
          .catch(() => undefined);
      }

      setThreadBranch(activeThreadId, branch, worktreePath);
    },
    [activeServerThread, activeThreadId, setThreadBranch],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  const { data: gitStatus = null, error: gitStatusError } = useQuery(gitStatusQueryOptions(gitCwd));
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasOriginRemote = gitStatus?.hasOriginRemote ?? false;
  const gitStatusForActions = gitStatus;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initMutation = useMutation(gitInitMutationOptions({ cwd: gitCwd, queryClient }));

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      cwd: gitCwd,
      queryClient,
    }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: gitCwd, queryClient }));

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;

  useEffect(() => {
    if (isGitActionRunning) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeServerThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    persistThreadBranchSync,
  ]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasOriginRemote),
    [gitStatusForActions, hasOriginRemote, isGitActionRunning],
  );
  const quickAction = useMemo(
    () => resolveQuickAction(gitStatusForActions, isGitActionRunning, hasOriginRemote),
    [gitStatusForActions, hasOriginRemote, isGitActionRunning],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [gitStatusForActions, threadToastData]);

  runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
    }: RunGitActionWithToastInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
      });
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });
      }

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `Running ${event.hookName}...`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Committing...";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Let the rejected mutation publish the error toast to avoid a
            // transient intermediate state before the final failure message.
            return;
        }

        updateActiveProgressToast();
      };

      const promise = runImmediateGitActionMutation.mutateAsync({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: applyProgressEvent,
      });

      try {
        const result = await promise;
        activeGitActionProgressRef.current = null;
        syncThreadBranchAfterGitAction(result);
        const closeResultToast = () => {
          toastManager.close(resolvedProgressToastId);
        };

        const toastCta = result.toast.cta;
        let toastActionProps: {
          children: string;
          onClick: () => void;
        } | null = null;
        if (toastCta.kind === "run_action") {
          toastActionProps = {
            children: toastCta.label,
            onClick: () => {
              closeResultToast();
              void runGitActionWithToast({
                action: toastCta.action.kind,
              });
            },
          };
        } else if (toastCta.kind === "open_pr") {
          toastActionProps = {
            children: toastCta.label,
            onClick: () => {
              const api = readNativeApi();
              if (!api) return;
              closeResultToast();
              void api.shell.openExternal(toastCta.url);
            },
          };
        }

        const successToastBase = {
          type: "success",
          title: result.toast.title,
          description: result.toast.description,
          timeout: 0,
          data: {
            ...scopedToastData,
            dismissAfterVisibleMs: 10_000,
          },
        } as const;

        if (toastActionProps) {
          toastManager.update(resolvedProgressToastId, {
            ...successToastBase,
            actionProps: toastActionProps,
          });
        } else {
          toastManager.update(resolvedProgressToastId, successToastBase);
        }
      } catch (err) {
        activeGitActionProgressRef.current = null;
        const errorMessage = err instanceof Error ? err.message : "An error occurred.";
        if (
          errorMessage.toLowerCase().includes("no git remote") ||
          errorMessage.toLowerCase().includes("no remote")
        ) {
          toastManager.close(resolvedProgressToastId);
          setShowRemoteSetup(true);
        } else {
          toastManager.update(resolvedProgressToastId, {
            type: "error",
            title: "Action failed",
            description: errorMessage,
            data: scopedToastData,
          });
        }
      }
    },
  );

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
    });
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      const promise = pullMutation.mutateAsync();
      toastManager.promise(promise, {
        loading: { title: "Pulling...", data: threadToastData },
        success: (result) => ({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
              : `${result.branch} is already synchronized.`,
          data: threadToastData,
        }),
        error: (err) => ({
          title: "Pull failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        }),
      });
      void promise.catch(() => undefined);
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  };

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [gitCwd, threadToastData],
  );

  if (!gitCwd) return null;

  return (
    <>
      {!isRepo ? (
        <Button
          variant="outline"
          size="xs"
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? "Initializing..." : "Initialize Git"}
        </Button>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          {gitStatus?.branch && <BranchPicker currentBranch={gitStatus.branch} gitCwd={gitCwd!} />}
          <Group aria-label="Git actions" className="shrink-0">
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                if (isGitActionRunning) {
                  toastManager.add({
                    type: "info",
                    title: "Please wait",
                    description: "A git action is already running.",
                  });
                  return;
                }
                if (quickAction.disabled) {
                  if (!hasOriginRemote) {
                    setShowRemoteSetup(true);
                  } else {
                    toastManager.add({
                      type: "info",
                      title: quickAction.label,
                      description: quickAction.hint ?? "This action is currently unavailable.",
                    });
                  }
                  return;
                }
                runQuickAction();
              }}
            >
              <GitQuickActionIcon quickAction={quickAction} />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                {quickAction.label}
              </span>
            </Button>
            <GroupSeparator className="hidden @3xl/header-actions:block" />
            <Menu
              onOpenChange={(open) => {
                if (open) void invalidateGitStatusQuery(queryClient, gitCwd);
              }}
            >
              <MenuTrigger
                render={<Button aria-label="Git action options" size="icon-xs" variant="outline" />}
              >
                <ChevronDownIcon aria-hidden="true" className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end" className="w-full">
                {gitActionMenuItems.map((item) => {
                  const disabledReason = getMenuActionDisabledReason({
                    item,
                    gitStatus: gitStatusForActions,
                    isBusy: isGitActionRunning,
                    hasOriginRemote,
                  });
                  return (
                    <MenuItem
                      key={`${item.id}-${item.label}`}
                      onClick={() => {
                        if (item.disabled) {
                          if (!hasOriginRemote && (item.id === "push" || item.id === "pr")) {
                            setShowRemoteSetup(true);
                          } else {
                            toastManager.add({
                              type: "info",
                              title: item.label,
                              description:
                                disabledReason ?? "This action is currently unavailable.",
                            });
                          }
                          return;
                        }
                        openDialogForMenuItem(item);
                      }}
                    >
                      <GitActionItemIcon icon={item.icon} />
                      {item.label}
                    </MenuItem>
                  );
                })}
                {gitStatusForActions?.branch === null && (
                  <p className="px-2 py-1.5 text-xs text-warning">
                    Detached HEAD: create and checkout a branch to enable push and PR actions.
                  </p>
                )}
                {gitStatusForActions &&
                  gitStatusForActions.branch !== null &&
                  !gitStatusForActions.hasWorkingTreeChanges &&
                  gitStatusForActions.behindCount > 0 &&
                  gitStatusForActions.aheadCount === 0 && (
                    <p className="px-2 py-1.5 text-xs text-warning">
                      Behind upstream. Pull/rebase first.
                    </p>
                  )}
                {gitStatusError && (
                  <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError.message}</p>
                )}
              </MenuPopup>
            </Menu>
          </Group>
        </div>
      )}

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setDialogCommitMessage("");
            setExcludedFiles(new Set());
            setIsEditingFiles(false);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
            <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-3 rounded-lg border border-input bg-muted/40 p-3 text-xs">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="font-medium">
                  {gitStatusForActions?.branch ?? "(detached HEAD)"}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          setExcludedFiles(
                            allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                          );
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">Files</span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        ({selectedFiles.length} of {allFiles.length})
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setIsEditingFiles((prev) => !prev)}
                    >
                      {isEditingFiles ? "Done" : "Edit"}
                    </Button>
                  )}
                </div>
                {!gitStatusForActions || allFiles.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-44 rounded-md border border-input bg-background">
                      <div className="space-y-1 p-1">
                        {allFiles.map((file) => {
                          const isExcluded = excludedFiles.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-accent/50"
                            >
                              {isEditingFiles && (
                                <Checkbox
                                  checked={!excludedFiles.has(file.path)}
                                  onCheckedChange={() => {
                                    setExcludedFiles((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(file.path)) {
                                        next.delete(file.path);
                                      } else {
                                        next.add(file.path);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                className="flex flex-1 items-center justify-between gap-3 text-left truncate"
                                onClick={() => openChangedFileInEditor(file.path)}
                              >
                                <span
                                  className={`truncate${isExcluded ? " text-muted-foreground" : ""}`}
                                >
                                  {file.path}
                                </span>
                                <span className="shrink-0">
                                  {isExcluded ? (
                                    <span className="text-muted-foreground">Excluded</span>
                                  ) : (
                                    <>
                                      <span className="text-success">+{file.insertions}</span>
                                      <span className="text-muted-foreground"> / </span>
                                      <span className="text-destructive">-{file.deletions}</span>
                                    </>
                                  )}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-end font-mono">
                      <span className="text-success">
                        +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-destructive">
                        -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">Commit message (optional)</p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder="Leave empty to auto-generate"
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsCommitDialogOpen(false);
                setDialogCommitMessage("");
                setExcludedFiles(new Set());
                setIsEditingFiles(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              Commit on new branch
            </Button>
            <Button size="sm" disabled={noneSelected} onClick={runDialogAction}>
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={showRemoteSetup}
        onOpenChange={(open) => {
          setShowRemoteSetup(open);
          if (!open) {
            setRemoteUrl("");
            setIsAddingRemote(false);
            setIsCreatingGhRepo(false);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Set up remote repository</DialogTitle>
            <DialogDescription>
              No git remote is configured. Connect to GitHub or paste a remote URL to enable push
              and pull request actions.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-4 space-y-5">
            {ghStatus?.installed && ghStatus.authenticated ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">
                  Create a new GitHub repository
                </p>
                <div className="flex items-center gap-2">
                  <input
                    className="h-8 flex-1 rounded-md border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-foreground/30 disabled:opacity-64"
                    placeholder="repo-name"
                    value={ghRepoName}
                    onChange={(e) => setGhRepoName(e.target.value)}
                    disabled={isCreatingGhRepo}
                  />
                  <select
                    className="h-8 rounded-md border border-border bg-secondary px-2 text-sm text-foreground focus:outline-none focus:border-foreground/30 disabled:opacity-64"
                    value={ghRepoVisibility}
                    onChange={(e) => setGhRepoVisibility(e.target.value as "public" | "private")}
                    disabled={isCreatingGhRepo}
                  >
                    <option value="private">Private</option>
                    <option value="public">Public</option>
                  </select>
                  <Button
                    size="sm"
                    className="min-w-[8.5rem]"
                    disabled={!ghRepoName.trim() || !gitCwd || isCreatingGhRepo}
                    onClick={() => {
                      const name = ghRepoName.trim();
                      if (!name || !gitCwd) return;
                      setIsCreatingGhRepo(true);
                      void (async () => {
                        try {
                          const api = readNativeApi();
                          if (!api) return;
                          const result = await api.git.gitHubCreateRepo({
                            cwd: gitCwd,
                            name,
                            visibility: ghRepoVisibility,
                          });
                          await queryClient.invalidateQueries({
                            queryKey: gitQueryKeys.status(gitCwd),
                          });
                          toastManager.add({
                            type: "success",
                            title: "Created GitHub repo",
                            description: result.htmlUrl,
                            data: threadToastData,
                          });
                          setShowRemoteSetup(false);
                        } catch (error) {
                          toastManager.add({
                            type: "error",
                            title: "Failed to create GitHub repo",
                            description:
                              error instanceof Error ? error.message : "An error occurred",
                            data: threadToastData,
                          });
                        } finally {
                          setIsCreatingGhRepo(false);
                        }
                      })();
                    }}
                  >
                    {isCreatingGhRepo ? "Creating..." : "Create & connect"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Uses <code className="font-mono">gh repo create</code> and sets the new repo as
                  your <code className="font-mono">origin</code>.
                </p>
              </div>
            ) : ghStatus && ghStatus.installed && !ghStatus.authenticated ? (
              <div className="rounded-lg bg-muted/30 px-3 py-2.5 space-y-1">
                <p className="text-xs font-medium text-foreground">GitHub CLI is not signed in</p>
                <p className="text-[11px] text-muted-foreground">
                  Run <code className="font-mono">gh auth login</code> to enable one-click connect.
                </p>
              </div>
            ) : null}
            <div>
              <label
                htmlFor="remote-url"
                className="block text-xs font-medium text-foreground mb-1.5"
              >
                Or paste a remote URL
              </label>
              <input
                id="remote-url"
                className="h-8 w-full rounded-md border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-foreground/30 disabled:opacity-64"
                placeholder="https://github.com/user/repo.git"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && remoteUrl.trim() && !isAddingRemote) {
                    e.preventDefault();
                    void submitAddRemote();
                  }
                }}
                disabled={isAddingRemote}
                autoFocus
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Supports HTTPS and SSH URLs (e.g. git@github.com:user/repo.git)
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowRemoteSetup(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="min-w-[6.5rem]"
              disabled={!remoteUrl.trim() || isAddingRemote}
              onClick={() => void submitAddRemote()}
            >
              {isAddingRemote ? "Adding..." : "Add remote"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function BranchPicker({ currentBranch, gitCwd }: { currentBranch: string; gitCwd: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadBranches = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    setLoading(true);
    try {
      const result = await api.git.listBranches({ cwd: gitCwd });
      setBranches(result.branches.map((b) => b.name));
    } catch {
      setBranches([]);
    }
    setLoading(false);
  }, [gitCwd]);

  const checkoutBranch = useCallback(
    async (branch: string) => {
      const api = readNativeApi();
      if (!api) return;
      try {
        await api.git.checkout({ cwd: gitCwd, branch });
        setOpen(false);
        setSearch("");
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Checkout failed",
          description: error instanceof Error ? error.message : "Failed to switch branch",
        });
      }
    },
    [gitCwd],
  );

  const createAndCheckout = useCallback(
    async (branchName: string) => {
      const api = readNativeApi();
      if (!api) return;
      try {
        await api.git.createBranch({ cwd: gitCwd, branch: branchName });
        await api.git.checkout({ cwd: gitCwd, branch: branchName });
        setOpen(false);
        setSearch("");
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch",
          description: error instanceof Error ? error.message : "An error occurred",
        });
      }
    },
    [gitCwd],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, search]);

  const trimmedSearch = search.trim();
  const canCreate =
    trimmedSearch.length > 0 &&
    !branches.some((b) => b.toLowerCase() === trimmedSearch.toLowerCase());

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void loadBranches();
        } else {
          setSearch("");
        }
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className="hidden @3xl/header-actions:inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          />
        }
      >
        <GitForkIcon className="size-3" />
        {currentBranch}
        <ChevronDownIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup className="w-64" sideOffset={8}>
        <div className="-mx-4 -mt-4 px-3 pt-3 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1.5">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
            <input
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
              placeholder="Search or create branch..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) {
                  e.preventDefault();
                  void createAndCheckout(trimmedSearch);
                }
              }}
              autoFocus
            />
          </div>
        </div>
        <div className="-mx-4 -mb-4 max-h-56 overflow-y-auto px-1.5 pb-1.5">
          {loading ? (
            <p className="px-2.5 py-3 text-center text-xs text-muted-foreground/50">Loading...</p>
          ) : (
            <>
              {filtered.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
                  onClick={() => void checkoutBranch(branch)}
                >
                  <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{branch}</span>
                  {branch === currentBranch && (
                    <CheckIcon className="size-3.5 shrink-0 text-foreground/70" />
                  )}
                </button>
              ))}
              {filtered.length === 0 && !canCreate && (
                <p className="px-2.5 py-3 text-center text-xs text-muted-foreground/50">
                  No branches found
                </p>
              )}
              {canCreate && (
                <div className="mt-1 border-t border-border pt-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => void createAndCheckout(trimmedSearch)}
                  >
                    <PlusIcon className="size-3.5 shrink-0" />
                    <span>
                      Create <strong className="text-foreground">{trimmedSearch}</strong>
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
