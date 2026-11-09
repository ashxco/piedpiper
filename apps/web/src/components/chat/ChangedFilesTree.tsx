import { type GitStatusResult, type TurnId } from "@piedpiper/contracts";
import { QueryClientContext } from "@tanstack/react-query";
import { type MouseEvent, memo, use, useState } from "react";
import { type TurnDiffFileChange } from "../../types";
import { showFileContextMenu } from "../../fileContextMenu";
import { resolveRepoRelativeFilePath } from "../../lib/diffPathResolution";
import { gitQueryKeys } from "../../lib/gitReactQuery";
import { readNativeApi } from "../../nativeApi";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { ChevronRightIcon, FolderIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { MiddleTruncate } from "../ui/middle-truncate";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

// Building the tree walks every file; keep it cached across expansion-state renders.
function useTurnDiffTree(files: ReadonlyArray<TurnDiffFileChange>) {
  "use memo";
  const treeNodes = buildTurnDiffTree(files);
  return { treeNodes, directoryPathsKey: collectDirectoryPaths(treeNodes).join("\u0000") };
}

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  /** Thread cwd; enables the right-click open/copy menu on file rows. */
  workspaceRoot?: string | undefined;
}) {
  const { files, allDirectoriesExpanded, onOpenTurnDiff, resolvedTheme, turnId, workspaceRoot } =
    props;
  // Optional so the tree still renders without a provider (static markup tests).
  const queryClient = use(QueryClientContext);
  const { treeNodes, directoryPathsKey } = useTurnDiffTree(files);
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = (pathValue: string) => {
    setDirectoryExpansionState((current) => {
      const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
      return {
        key: expansionStateKey,
        overrides: {
          ...nextOverrides,
          [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
        },
      };
    });
  };

  const openFileContextMenu = (event: MouseEvent, filePath: string) => {
    const api = readNativeApi();
    if (!api || !workspaceRoot) return;
    event.preventDefault();
    const repoRoot = queryClient?.getQueryData<GitStatusResult>(gitQueryKeys.status(workspaceRoot))
      ?.workingTree.rootPath;
    void showFileContextMenu({
      api,
      targetPath: resolveRepoRelativeFilePath(filePath, { cwd: workspaceRoot, repoRoot }),
      position: { x: event.clientX, y: event.clientY },
    }).catch((error) => {
      console.warn("Failed to run file context menu action.", error);
    });
  };

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ paddingLeft: `${leftPadding}px` }}
            aria-expanded={isExpanded}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div className="space-y-0.5">
              {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(turnId, node.path)}
        onContextMenu={workspaceRoot ? (event) => openFileContextMenu(event, node.path) : undefined}
      >
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <MiddleTruncate
          value={node.name}
          className="font-mono text-[11px] text-muted-foreground/80 group-hover:text-foreground/90"
        />
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>;
});

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
