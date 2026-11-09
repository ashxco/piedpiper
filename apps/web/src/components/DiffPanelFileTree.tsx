import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, FolderIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { buildTurnDiffTree, type TurnDiffTreeNode } from "../lib/turnDiffTree";
import { cn } from "../lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import {
  collectDiffTreeDirectoryPaths,
  type DiffFileStatus,
  type DiffFileTreeEntry,
} from "./DiffPanelFileTree.logic";

const STATUS_BADGES: Record<DiffFileStatus, { letter: string; label: string; className: string }> =
  {
    added: { letter: "A", label: "Added", className: "text-diff-addition" },
    deleted: { letter: "D", label: "Deleted", className: "text-diff-deletion" },
    renamed: { letter: "R", label: "Renamed", className: "text-info" },
    modified: { letter: "M", label: "Modified", className: "text-warning" },
  };

function useDiffFileTree(entries: ReadonlyArray<DiffFileTreeEntry>) {
  "use memo";
  const treeNodes = buildTurnDiffTree(entries);
  const statusByPath = new Map(entries.map((entry) => [entry.path, entry.status] as const));
  return {
    treeNodes,
    statusByPath,
    directoryPathsKey: collectDiffTreeDirectoryPaths(treeNodes).join("\u0000"),
  };
}

/** Navigator for the files in the diff panel's patch; directories start expanded. */
export function DiffPanelFileTree(props: {
  entries: ReadonlyArray<DiffFileTreeEntry>;
  activeFilePath: string | null;
  resolvedTheme: "light" | "dark";
  onSelectFile: (filePath: string) => void;
  onFileContextMenu?: (event: MouseEvent, filePath: string) => void;
}) {
  const { entries, activeFilePath, resolvedTheme, onSelectFile, onFileContextMenu } = props;
  const { treeNodes, statusByPath, directoryPathsKey } = useDiffFileTree(entries);
  const [expansion, setExpansion] = useState<{
    key: string;
    allExpanded: boolean;
    overrides: Record<string, boolean>;
  }>({ key: directoryPathsKey, allExpanded: true, overrides: {} });
  // A new file set (another turn) starts fully expanded again.
  const current =
    expansion.key === directoryPathsKey
      ? expansion
      : { key: directoryPathsKey, allExpanded: true, overrides: {} };
  const hasDirectories = directoryPathsKey.length > 0;

  const toggleDirectory = (path: string) => {
    setExpansion({
      ...current,
      overrides: {
        ...current.overrides,
        [path]: !(current.overrides[path] ?? current.allExpanded),
      },
    });
  };
  const toggleAllDirectories = () => {
    setExpansion({ key: directoryPathsKey, allExpanded: !current.allExpanded, overrides: {} });
  };

  const renderNode = (node: TurnDiffTreeNode, depth: number) => {
    const paddingLeft = `${6 + depth * 12}px`;
    if (node.kind === "directory") {
      const isExpanded = current.overrides[node.path] ?? current.allExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            className="group flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ paddingLeft }}
            aria-expanded={isExpanded}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 text-muted-foreground/70 transition-transform",
                isExpanded && "rotate-90",
              )}
            />
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
          </button>
          {isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const status = STATUS_BADGES[statusByPath.get(node.path) ?? "modified"];
    const isActive = node.path === activeFilePath;
    return (
      <button
        key={`file:${node.path}`}
        type="button"
        title={node.path}
        aria-current={isActive ? "true" : undefined}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive && "bg-accent text-foreground",
        )}
        style={{ paddingLeft }}
        onClick={() => onSelectFile(node.path)}
        onContextMenu={
          onFileContextMenu ? (event) => onFileContextMenu(event, node.path) : undefined
        }
      >
        <span aria-hidden="true" className="size-3 shrink-0" />
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11px]",
            isActive
              ? "text-foreground"
              : "text-muted-foreground/85 group-hover:text-foreground/90",
            statusByPath.get(node.path) === "deleted" &&
              "line-through decoration-muted-foreground/50",
          )}
        >
          {node.name}
        </span>
        {node.stat && hasNonZeroStat(node.stat) && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
        <span
          className={cn("w-2.5 shrink-0 text-center font-mono text-[10px]", status.className)}
          title={status.label}
          aria-label={status.label}
        >
          {status.letter}
        </span>
      </button>
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          Files <span className="tabular-nums text-muted-foreground/60">{entries.length}</span>
        </span>
        {hasDirectories && (
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={toggleAllDirectories}
            aria-label={current.allExpanded ? "Collapse all folders" : "Expand all folders"}
            title={current.allExpanded ? "Collapse all folders" : "Expand all folders"}
          >
            {current.allExpanded ? (
              <ChevronsDownUpIcon className="size-3.5" />
            ) : (
              <ChevronsUpDownIcon className="size-3.5" />
            )}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto p-1">
        {treeNodes.map((node) => renderNode(node, 0))}
      </div>
    </div>
  );
}
