import { useLocation, useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";

import { isImeComposingKeyboardEvent } from "../../lib/imeComposition";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { searchSettings, type SettingsSearchEntry } from "./settingsSearch";

/** Search box in the settings header that jumps to a setting. */
export function SettingsSearchField({ className }: { className?: string }) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const listId = useId();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const results = searchSettings(query);
  const showList = isOpen && query.trim().length > 0;
  const active = results[Math.min(activeIndex, results.length - 1)];

  const select = (entry: SettingsSearchEntry) => {
    setQuery("");
    setActiveIndex(0);
    setIsOpen(false);
    void navigate({
      to: entry.to,
      hash: entry.anchor ?? "",
      hashScrollIntoView: false,
      // The hash is cleared after the reveal, so a same-tab jump would leave a no-op Back entry.
      replace: entry.to === pathname,
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
    if (event.key === "Escape") {
      // With an empty field this stays unhandled, so Escape still closes settings.
      if (query.length === 0) return;
      event.preventDefault();
      setQuery("");
      setActiveIndex(0);
      return;
    }
    if (!showList || results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const current = Math.min(activeIndex, results.length - 1);
      setActiveIndex((current + step + results.length) % results.length);
      return;
    }
    if (event.key === "Enter" && active) {
      event.preventDefault();
      select(active);
    }
  };

  return (
    <div className={cn("relative min-w-0", className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        nativeInput
        type="search"
        size="sm"
        role="combobox"
        aria-label="Search settings"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active ? `${listId}-${active.id}` : undefined}
        placeholder="Search settings"
        spellCheck={false}
        autoComplete="off"
        className="[&_input]:pl-7"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching settings"
          className="absolute top-full right-0 z-50 mt-1 max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg [-webkit-app-region:no-drag]"
        >
          {results.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">No matching settings</li>
          ) : (
            results.map((entry) => (
              <li
                key={entry.id}
                id={`${listId}-${entry.id}`}
                role="option"
                aria-selected={entry === active}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs",
                  entry === active && "bg-accent text-accent-foreground",
                )}
                // Selecting must not blur the field first, which would close the list.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(results.indexOf(entry))}
                onClick={() => select(entry)}
              >
                <span className="truncate font-medium">{entry.title}</span>
                <span className="shrink-0 text-muted-foreground">{entry.section}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
