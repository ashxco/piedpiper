import type { GitListCommitsResult } from "@piedpiper/contracts";
import { cn } from "../lib/utils";

export function DiffCommitPicker(props: {
  commits: GitListCommitsResult["commits"];
  search: string;
  selected?: string | undefined;
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelect: (sha: string) => void;
}) {
  const query = props.search.trim().toLowerCase();
  const commits = props.commits.filter((commit) =>
    `${commit.sha} ${commit.subject} ${commit.author}`.toLowerCase().includes(query),
  );
  return (
    <div className="mt-1 border-t border-border pt-1">
      <p className="px-2.5 py-1.5 text-xs text-muted-foreground">Commits</p>
      {commits.map((commit) => (
        <button
          key={commit.sha}
          type="button"
          onClick={() => props.onSelect(commit.sha)}
          className={cn(
            "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent",
            props.selected === commit.sha && "bg-accent/50",
          )}
        >
          <span className="w-full truncate text-xs text-foreground">{commit.subject}</span>
          <span className="text-[11px] text-muted-foreground">
            {commit.sha.slice(0, 8)} · {commit.author}
          </span>
        </button>
      ))}
      {props.loading ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading commits…</p>
      ) : props.error ? (
        <p className="px-2.5 py-2 text-xs text-destructive">Could not load commits.</p>
      ) : commits.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">No commits found.</p>
      ) : null}
      {props.hasMore && (
        <button
          type="button"
          onClick={props.onLoadMore}
          disabled={props.loading}
          className="px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Load more commits
        </button>
      )}
    </div>
  );
}
