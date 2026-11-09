import { resolvePastedPath } from "@piedpiper/shared/path";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { type KeyboardEvent, type RefObject, useEffect, useId, useState } from "react";

import { isImeComposingKeyboardEvent } from "../../lib/imeComposition";
import { getWsRpcClient } from "~/wsRpcClient";
import {
  completeProjectPath,
  isBrowsableProjectPath,
  moveProjectPathHighlight,
  type ProjectPathListing,
  type ProjectPathSuggestion,
  visibleProjectPathSuggestions,
} from "./projectPathSuggestions.logic";

const SUGGESTIONS_DEBOUNCE_MS = 150;
const SUGGESTIONS_STALE_TIME_MS = 5_000;

export function SidebarProjectPathInput({
  inputRef,
  ...props
}: {
  value: string;
  hasError: boolean;
  canSubmit: boolean;
  isAdding: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [highlight, setHighlight] = useState<number | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const listId = useId();

  const path = props.value.trim();
  const isBrowsable = isBrowsableProjectPath(path);
  const [debouncedPath] = useDebouncedValue(isBrowsable ? path : "", {
    wait: SUGGESTIONS_DEBOUNCE_MS,
  });
  const listing = useQuery({
    queryKey: ["projects", "browse-directories", debouncedPath],
    queryFn: async (): Promise<ProjectPathListing> => {
      const result = await getWsRpcClient().projects.browseDirectories({
        partialPath: debouncedPath,
      });
      return { queriedPath: debouncedPath, entries: result.entries };
    },
    enabled: debouncedPath.length > 0,
    staleTime: SUGGESTIONS_STALE_TIME_MS,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const suggestions = isBrowsable ? visibleProjectPathSuggestions(listing.data, path) : [];
  const isOpen = suggestions.length > 0 && !isDismissed;
  const activeIndex = highlight !== null && highlight < suggestions.length ? highlight : null;
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (activeIndex === null) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId]);

  const changeValue = (value: string) => {
    setHighlight(null);
    setIsDismissed(false);
    props.onValueChange(value);
  };

  const accept = (suggestion: ProjectPathSuggestion | undefined) => {
    if (suggestion) changeValue(completeProjectPath(suggestion));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
    if (isOpen && event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      accept(suggestions[activeIndex ?? 0]);
    } else if (isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlight(moveProjectPathHighlight(activeIndex, direction, suggestions.length));
    } else if (event.key === "Enter") {
      if (isOpen && activeIndex !== null) accept(suggestions[activeIndex]);
      else props.onSubmit();
    } else if (event.key === "Escape") {
      if (isOpen) {
        // Only the list closes: the chat layout's selection clear and the mobile sheet stay put.
        event.preventDefault();
        event.stopPropagation();
        setIsDismissed(true);
      } else {
        props.onCancel();
      }
    }
  };

  return (
    <>
      <div className="flex gap-1.5">
        <input
          ref={inputRef}
          className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
            props.hasError
              ? "border-red-500/70 focus:border-red-500"
              : "border-border focus:border-ring"
          }`}
          placeholder="/path/to/project"
          role="combobox"
          aria-label="Project folder path"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-activedescendant={isOpen && activeIndex !== null ? optionId(activeIndex) : undefined}
          value={props.value}
          onChange={(event) => changeValue(resolvePastedPath(props.value, event.target.value))}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
          onClick={props.onSubmit}
          disabled={!props.canSubmit}
        >
          {props.isAdding ? "Adding..." : "Add"}
        </button>
      </div>
      {isOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching folders"
          className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-secondary py-0.5"
          // Keeps focus in the box, so Tab and Enter carry on working after a click.
          onMouseDown={(event) => event.preventDefault()}
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.fullPath}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              title={suggestion.fullPath}
              className={`flex cursor-pointer items-center gap-2 px-2 py-0.5 font-mono text-[11px] text-foreground/80 hover:bg-accent hover:text-foreground ${
                index === activeIndex ? "bg-accent text-foreground" : ""
              }`}
              onClick={() => accept(suggestion)}
            >
              <span className="min-w-0 flex-1 truncate">{suggestion.name}</span>
              {index === (activeIndex ?? 0) && (
                <span className="shrink-0 font-sans text-[10px] text-muted-foreground/70">Tab</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
