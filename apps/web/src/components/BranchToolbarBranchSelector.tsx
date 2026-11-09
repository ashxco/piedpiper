import type { GitBranch } from "@piedpiper/contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import {
  type CSSProperties,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  gitBranchSearchInfiniteQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitAfterMutation,
  invalidateGitStatusQuery,
} from "../lib/gitReactQuery";
import {
  openPullRequestLink,
  prStatusIndicator,
  resolveBranchPullRequest,
} from "../lib/openPullRequestLink";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { parsePullRequestReference } from "../pullRequestReference";
import {
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  isContextMenuPress,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveWorktreeBaseBranchSeed,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";
import { openBranchNameContextMenu } from "./BranchToolbarBranchContextMenu";
import { PrStatusIcon } from "./sidebar/PrStatusIcon";
import { useBranchListVirtualizer } from "./BranchToolbarBranchSelector.virtualizer";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "./ui/combobox";
import { MiddleTruncate } from "./ui/middle-truncate";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface BranchToolbarBranchSelectorHandle {
  /** Opens the branch menu; false when the trigger is disabled. */
  open: () => boolean;
}

interface BranchToolbarBranchSelectorProps {
  ref?: Ref<BranchToolbarBranchSelectorHandle>;
  /** Shortcut label for composer.branch, shown in the trigger's tooltip. */
  shortcutLabel?: string | null;
  activeProjectCwd: string;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch } = input;
  if (!resolvedActiveBranch) {
    return "Select branch";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function BranchToolbarBranchSelector({
  ref,
  shortcutLabel,
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  effectiveEnvMode,
  envLocked,
  onSetThreadBranch,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");

  const branchStatusQuery = useQuery(gitStatusQueryOptions(branchCwd));
  // branchStatusQuery follows the thread's worktree; the project's own checkout root needs its cwd.
  const projectStatusQuery = useQuery(gitStatusQueryOptions(activeProjectCwd));
  const trimmedBranchQuery = branchQuery.trim();
  // Ref names cannot contain ASCII spaces, so the server search uses the sanitized name.
  const branchRefQuery = sanitizeNewRefName(trimmedBranchQuery);

  useEffect(() => {
    if (!branchCwd) return;
    void queryClient.prefetchInfiniteQuery(
      gitBranchSearchInfiniteQueryOptions({ cwd: branchCwd, query: "" }),
    );
  }, [branchCwd, queryClient]);

  const needsWorktreeBaseSeed =
    effectiveEnvMode === "worktree" && !activeWorktreePath && !activeThreadBranch;
  const {
    data: branchesSearchData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: isBranchesSearchPending,
    isPlaceholderData: isBranchesSearchPlaceholder,
  } = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      cwd: branchCwd,
      query: branchRefQuery,
      // Seeding needs the list with the menu closed, and a failed fetch must end pending.
      enabled: isBranchMenuOpen || needsWorktreeBaseSeed,
    }),
  );
  const branches = branchesSearchData?.pages.flatMap((page) => page.branches) ?? [];
  const currentGitBranch =
    branchStatusQuery.data?.branch ?? branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchByName = new Map(branches.map((branch) => [branch.name, branch] as const));
  const normalizedBranchQuery = trimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    prReference && onCheckoutPullRequestRequest ? `__checkout_pull_request__:${prReference}` : null;
  const canCreateBranch = !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  // The branch is created under its sanitized name, so the collision check must use it too.
  const newBranchName = sanitizeNewRefName(trimmedBranchQuery);
  const hasExactBranchMatch = branchByName.has(newBranchName);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems = [
    ...(checkoutPullRequestItemValue ? [checkoutPullRequestItemValue] : []),
    ...branches.map((branch) => branch.name),
    ...(createBranchItemValue && !hasExactBranchMatch ? [createBranchItemValue] : []),
  ];
  const filteredBranchPickerItems =
    normalizedBranchQuery.length === 0
      ? branchPickerItems
      : branchPickerItems.filter((itemValue) =>
          shouldIncludeBranchPickerItem({
            itemValue,
            normalizedQuery: normalizedBranchQuery,
            createBranchItemValue,
            checkoutPullRequestItemValue,
          }),
        );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const shouldVirtualizeBranchList = filteredBranchPickerItems.length > 40;
  const totalBranchCount = branchesSearchData?.pages[0]?.totalCount ?? 0;
  // Placeholder data is the previous search's result, so its paging counts don't apply yet.
  const isBranchesSearchLoading = isBranchesSearchPending || isBranchesSearchPlaceholder;
  const branchStatusText = isBranchesSearchLoading
    ? "Loading branches..."
    : isFetchingNextPage
      ? "Loading more branches..."
      : hasNextPage
        ? `Showing ${branches.length} of ${totalBranchCount} branches`
        : null;

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitAfterMutation(queryClient, {
        cwds: [branchCwd, activeProjectCwd],
      }).catch(() => undefined);
    });
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending) return;

    // In new-worktree mode, selecting a branch sets the base branch.
    if (isSelectingWorktreeBase) {
      onSetThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeProjectCheckoutRoot: projectStatusQuery.data?.workingTree.rootPath,
      activeWorktreePath,
      branch,
    });

    // If the branch already lives in a worktree, point the thread there.
    if (selectionTarget.reuseExistingWorktree) {
      onSetThreadBranch(branch.name, selectionTarget.nextWorktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = branch.isRemote
      ? deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        await api.git.checkout({ cwd: selectionTarget.checkoutCwd, branch: branch.name });
        await invalidateGitAfterMutation(queryClient, {
          cwds: [selectionTarget.checkoutCwd, branchCwd],
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to checkout branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      let nextBranchName = selectedBranchName;
      if (branch.isRemote) {
        const status = await api.git.status({ cwd: selectionTarget.checkoutCwd }).catch(() => null);
        if (status?.branch) {
          nextBranchName = status.branch;
        }
      }

      setOptimisticBranch(nextBranchName);
      onSetThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
    });
  };

  const createBranch = (rawName: string) => {
    const name = sanitizeNewRefName(rawName);
    const api = readNativeApi();
    if (!api || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(name);

      try {
        await api.git.createBranch({ cwd: branchCwd, branch: name });
        try {
          await api.git.checkout({ cwd: branchCwd, branch: name });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to checkout branch.",
            description: toBranchActionErrorMessage(error),
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      setOptimisticBranch(name);
      onSetThreadBranch(name, activeWorktreePath);
      setBranchQuery("");
    });
  };

  const worktreeBaseBranchSeed = resolveWorktreeBaseBranchSeed({
    branchQuery: branchRefQuery,
    branches,
    currentGitBranch,
    isPending: isBranchesSearchPending,
    isPlaceholderData: isBranchesSearchPlaceholder,
  });
  useEffect(() => {
    if (!needsWorktreeBaseSeed || !worktreeBaseBranchSeed) {
      return;
    }
    onSetThreadBranch(worktreeBaseBranchSeed, null);
  }, [needsWorktreeBaseSeed, onSetThreadBranch, worktreeBaseBranchSeed]);

  const handleOpenChange = (open: boolean) => {
    setIsBranchMenuOpen(open);
    if (!open) {
      setBranchQuery("");
      return;
    }
    if (isBranchMenuOpen) return;
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.branches(branchCwd),
    });
    // The trigger label and "current" badge come from the polled status, which can lag a terminal checkout.
    void invalidateGitStatusQuery(queryClient, branchCwd);
  };

  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);
  const maybeFetchNextBranchPage = () => {
    if (!isBranchMenuOpen || !hasNextPage || isFetchingNextPage || isBranchesSearchPlaceholder) {
      return;
    }

    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const distanceFromBottom =
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    if (distanceFromBottom > 96) {
      return;
    }

    void fetchNextPage().catch(() => undefined);
  };
  const branchListVirtualizer = useBranchListVirtualizer({
    count: filteredBranchPickerItems.length,
    estimateSize: (index) =>
      filteredBranchPickerItems[index] === checkoutPullRequestItemValue ? 44 : 28,
    scrollElementRef: branchListScrollElementRef,
    enabled: isBranchMenuOpen && shouldVirtualizeBranchList,
  });
  const virtualBranchRows = branchListVirtualizer.virtualRows;
  const measureBranchList = branchListVirtualizer.measure;
  const setBranchListRef = (element: HTMLDivElement | null) => {
    branchListScrollElementRef.current = (element?.parentElement as HTMLDivElement | null) ?? null;
    if (element) {
      measureBranchList();
    }
  };

  useEffect(() => {
    if (!isBranchMenuOpen || !shouldVirtualizeBranchList) return;
    queueMicrotask(() => {
      measureBranchList();
    });
  }, [
    measureBranchList,
    filteredBranchPickerItems.length,
    isBranchMenuOpen,
    shouldVirtualizeBranchList,
  ]);

  useEffect(() => {
    if (!isBranchMenuOpen) {
      return;
    }

    branchListScrollElementRef.current?.scrollTo({ top: 0 });
  }, [trimmedBranchQuery, isBranchMenuOpen]);

  const fetchNextBranchPageNearEnd = useEffectEvent(maybeFetchNextBranchPage);

  useEffect(() => {
    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement || !isBranchMenuOpen) {
      return;
    }

    const handleScroll = () => {
      fetchNextBranchPageNearEnd();
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [isBranchMenuOpen]);

  // Re-check after each page lands or a fetch settles, since the list may still end above the fold.
  useEffect(() => {
    fetchNextBranchPageNearEnd();
  }, [
    branches.length,
    hasNextPage,
    isBranchMenuOpen,
    isBranchesSearchPlaceholder,
    isFetchingNextPage,
  ]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });

  function renderPickerItem(itemValue: string, index: number, style?: CSSProperties) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => {
            if (!prReference || !onCheckoutPullRequestRequest) {
              return;
            }
            setIsBranchMenuOpen(false);
            setBranchQuery("");
            onComposerFocusRequest?.();
            onCheckoutPullRequestRequest(prReference);
          }}
        >
          <div className="flex min-w-0 flex-col items-start py-1">
            <span className="truncate font-medium">Checkout Pull Request</span>
            <span className="truncate text-muted-foreground text-xs">{prReference}</span>
          </div>
        </ComboboxItem>
      );
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => createBranch(trimmedBranchQuery)}
        >
          <span className="truncate">Create new branch "{newBranchName}"</span>
        </ComboboxItem>
      );
    }

    const branch = branchByName.get(itemValue);
    if (!branch) return null;

    const hasSecondaryWorktree = branch.worktreePath && branch.worktreePath !== activeProjectCwd;
    const badge = branch.current
      ? "current"
      : hasSecondaryWorktree
        ? "worktree"
        : branch.isRemote
          ? "remote"
          : branch.isDefault
            ? "default"
            : null;
    return (
      <ComboboxItem
        hideIndicator
        key={itemValue}
        index={index}
        value={itemValue}
        style={style}
        onClick={() => selectBranch(branch)}
        onContextMenu={(event) => openBranchNameContextMenu(event, itemValue)}
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <MiddleTruncate value={itemValue} className="flex-1" />
          {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
        </div>
      </ComboboxItem>
    );
  }

  const isBranchTriggerDisabled =
    (isBranchesSearchPending && branches.length === 0) || isBranchActionPending;

  useImperativeHandle(ref, () => ({
    open: () => {
      if (isBranchTriggerDisabled) return false;
      handleOpenChange(true);
      return true;
    },
  }));

  const branchPr = resolveBranchPullRequest(resolvedActiveBranch, branchStatusQuery.data);
  const branchPrStatus = prStatusIndicator(branchPr);
  const branchPrStateWord =
    branchPr?.state === "open" && branchPr.isDraft === true ? "draft" : branchPr?.state;
  const branchPrTooltip = branchPr
    ? `Open PR #${branchPr.number} (${branchPrStateWord}) in browser`
    : "";

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      virtualized={shouldVirtualizeBranchList}
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0) return;
        if (eventDetails.reason === "pointer") return;
        branchListVirtualizer.scrollToIndex(eventDetails.index, { align: "auto" });
      }}
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <div className="flex min-w-0 items-center gap-1">
        {branchPr && branchPrStatus ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={branchPrTooltip}
                  onClick={(event) => openPullRequestLink(event, branchPrStatus.url)}
                  className={cn(
                    "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium tabular-nums transition-colors hover:bg-muted/60",
                    branchPrStatus.colorClass,
                  )}
                />
              }
            >
              <PrStatusIcon label={branchPrStatus.label} className="size-3" />
              <span>#{branchPr.number}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{branchPrTooltip}</TooltipPopup>
          </Tooltip>
        ) : null}
        {/* The disabled trigger has pointer-events-none, so the wrapper takes the right-click. */}
        <span
          className="flex min-w-0"
          onContextMenu={(event) => openBranchNameContextMenu(event, resolvedActiveBranch)}
        >
          <ComboboxTrigger
            render={<Button variant="ghost" size="xs" />}
            className="min-w-0 text-muted-foreground/70 hover:text-foreground/80"
            disabled={isBranchTriggerDisabled}
            onMouseDown={(event) => {
              // Blocks only Base UI's open; the press still reaches window listeners.
              if (isContextMenuPress(event, navigator.platform)) event.preventBaseUIHandler();
            }}
            title={
              shortcutLabel ? `${triggerLabel} - Change branch (${shortcutLabel})` : triggerLabel
            }
          >
            <MiddleTruncate value={triggerLabel} showTitle={false} className="max-w-[240px]" />
            <ChevronDownIcon />
          </ComboboxTrigger>
        </span>
      </div>
      <ComboboxPopup align="end" side="top" className="w-80">
        <div className="border-b p-1">
          <ComboboxInput
            className="[&_input]:font-sans rounded-md"
            inputClassName="ring-0"
            placeholder="Search branches..."
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No branches found.</ComboboxEmpty>

        <ComboboxList ref={setBranchListRef} className="max-h-56">
          {shouldVirtualizeBranchList ? (
            <div
              className="relative"
              style={{
                height: `${branchListVirtualizer.totalSize}px`,
              }}
            >
              {virtualBranchRows.map((virtualRow) => {
                const itemValue = filteredBranchPickerItems[virtualRow.index];
                if (!itemValue) return null;
                return renderPickerItem(itemValue, virtualRow.index, {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                });
              })}
            </div>
          ) : (
            filteredBranchPickerItems.map((itemValue, index) => renderPickerItem(itemValue, index))
          )}
        </ComboboxList>
        {branchStatusText ? <ComboboxStatus>{branchStatusText}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}
