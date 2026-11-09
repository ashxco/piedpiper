import type { ThreadId } from "@piedpiper/contracts";
import { GitBranchIcon, SearchIcon, XIcon } from "lucide-react";
import { type KeyboardEvent } from "react";

import type { SidebarThreadSummary } from "../../types";
import { type SidebarThreadSearchMatch, splitSearchHighlights } from "../Sidebar.logic";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { textDirection } from "~/markdown-text-direction";

export const SIDEBAR_SEARCH_RESULTS_ID = "sidebar-thread-search-results";

export function sidebarSearchResultElementId(threadId: ThreadId): string {
  return `thread-search-result-${threadId}`;
}

export function SidebarThreadSearchInput(props: {
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Id of the rendered results list, while one is shown. */
  resultsId?: string | undefined;
  /** Id of the arrow-key highlighted result, announced to screen readers. */
  activeDescendantId?: string | undefined;
}) {
  return (
    <div className="relative flex items-center">
      <SearchIcon className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground/70" />
      <input
        type="text"
        role="searchbox"
        aria-label="Search threads"
        placeholder="Search threads"
        spellCheck={false}
        autoComplete="off"
        aria-controls={props.resultsId}
        aria-activedescendant={props.activeDescendantId}
        className="h-7 w-full min-w-0 rounded-md border border-border bg-secondary pr-7 pl-7 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={props.onKeyDown}
      />
      {props.query.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-1 inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => props.onQueryChange("")}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function HighlightedText(props: { text: string; query: string }) {
  return (
    <>
      {splitSearchHighlights(props.text, props.query).map((segment) =>
        segment.highlighted ? (
          <span key={segment.start} className="font-semibold text-foreground">
            {segment.text}
          </span>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function searchSnippetLabel(role: SidebarThreadSearchMatch["role"]): string | null {
  if (role === "user") return "You:";
  if (role === "assistant") return "Agent:";
  return null;
}

export function SidebarThreadSearchResults(props: {
  query: string;
  matches: readonly SidebarThreadSearchMatch<ThreadId>[];
  activeIndex: number;
  routeThreadId: ThreadId | null;
  threadsById: Readonly<Record<string, SidebarThreadSummary>>;
  projectNameById: ReadonlyMap<string, string>;
  onOpenMatch: (match: SidebarThreadSearchMatch<ThreadId>) => void;
  onHoverIndex: (index: number) => void;
}) {
  if (props.matches.length === 0) {
    return (
      <p id={SIDEBAR_SEARCH_RESULTS_ID} className="px-3 pt-4 text-xs text-muted-foreground/70">
        No matching threads
      </p>
    );
  }
  return (
    <SidebarMenu
      id={SIDEBAR_SEARCH_RESULTS_ID}
      className="gap-0.5"
      aria-label="Thread search results"
    >
      {props.matches.map((match, index) => {
        const thread = props.threadsById[match.threadId];
        if (!thread) return null;
        const projectName = props.projectNameById.get(thread.projectId);
        const isHighlighted = index === props.activeIndex;
        const snippetLabel = searchSnippetLabel(match.role);
        return (
          <SidebarMenuItem key={match.threadId}>
            <SidebarMenuButton
              size="sm"
              id={sidebarSearchResultElementId(match.threadId)}
              data-testid={`thread-search-result-${match.threadId}`}
              data-highlighted={isHighlighted ? "true" : undefined}
              isActive={props.routeThreadId === match.threadId}
              className={`h-auto flex-col items-start gap-0.5 px-2 py-1.5 ${
                isHighlighted ? "bg-accent text-foreground" : ""
              }`}
              onMouseEnter={() => props.onHoverIndex(index)}
              onClick={() => props.onOpenMatch(match)}
            >
              <span className="flex w-full min-w-0 items-baseline gap-2">
                <span
                  dir={textDirection(thread.title) ?? "auto"}
                  className="min-w-0 flex-1 truncate text-xs text-foreground/90"
                >
                  {match.source === "title" ? (
                    <HighlightedText text={thread.title} query={props.query} />
                  ) : (
                    thread.title
                  )}
                </span>
                {match.pullRequestNumber === undefined ? null : (
                  <span className="shrink-0 rounded bg-foreground/8 px-1 text-[10px] font-semibold text-foreground tabular-nums">
                    #{match.pullRequestNumber}
                  </span>
                )}
                {projectName ? (
                  <span className="max-w-[40%] shrink-0 truncate text-[10px] text-muted-foreground/60">
                    {projectName}
                  </span>
                ) : null}
              </span>
              {match.snippet ? (
                <span className="line-clamp-2 w-full text-[11px] leading-snug text-muted-foreground/80">
                  {match.source === "branch" ? (
                    <GitBranchIcon className="mr-1 inline size-3 align-[-2px]" />
                  ) : null}
                  {snippetLabel ? (
                    <span className="font-medium text-muted-foreground">{snippetLabel} </span>
                  ) : null}
                  <HighlightedText text={match.snippet} query={props.query} />
                </span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
