import { CheckIcon, ChevronDownIcon, QuoteIcon, SearchIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { CHARACTER_LINES } from "../office-mode/characterLines";
import { advisorAvatarSrc, getAllAdvisors, type ParsedAdvisor } from "../../lib/advisorIdentity";
import { useStartAdvisorChat } from "../../hooks/useStartAdvisorChat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface AdvisorChatLandingProps {
  /** The currently active advisor (extracted from the thread title). */
  readonly advisor: ParsedAdvisor;
}

/**
 * Empty-state landing for an advisor thread. Replaces NewThreadLanding for
 * threads under the hidden Advisors project so the user sees the character
 * they're talking to instead of the generic "Let's pipe some code in" copy.
 *
 * The dropdown lists every known advisor with a search-ahead filter. Picking
 * a different advisor spins up a fresh advisor thread via `useStartAdvisorChat`
 * (the same code path the /advisors page uses), so each switch produces a
 * brand new chat with the new persona.
 */
export const AdvisorChatLanding = memo(function AdvisorChatLanding({
  advisor,
}: AdvisorChatLandingProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { startAdvisorChat, isStartingAdvisorChat } = useStartAdvisorChat();

  const allAdvisors = getAllAdvisors();
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allAdvisors;
    return allAdvisors.filter((a) => a.displayName.toLowerCase().includes(q));
  }, [allAdvisors, search]);

  // Random one-liner from the same hand-authored pool the office NPCs use.
  // Re-rolled whenever the active advisor changes.
  const randomQuote = useMemo(() => {
    const lines = CHARACTER_LINES[advisor.id];
    if (!lines || lines.length === 0) return null;
    return lines[Math.floor(Math.random() * lines.length)] ?? null;
  }, [advisor.id]);

  return (
    <div className="-mt-[36px] flex h-full flex-col items-center justify-center gap-4">
      <img
        src={advisorAvatarSrc(advisor.id)}
        alt={advisor.displayName}
        draggable={false}
        className="h-40 w-auto object-contain"
      />
      <div className="flex flex-wrap items-baseline justify-center gap-x-2 text-center">
        <h2 className="text-2xl font-semibold text-foreground">Chat with</h2>
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setSearch("");
          }}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                disabled={isStartingAdvisorChat}
                className="inline-flex max-w-[420px] items-center gap-1.5 text-2xl font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
            }
          >
            <span className="min-w-0 truncate" title={advisor.displayName}>
              {advisor.shortName}
            </span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-60" />
          </PopoverTrigger>
          <PopoverPopup className="w-72" sideOffset={8}>
            <div className="-mx-4 -mt-4 px-3 pt-3 pb-2">
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1.5">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                  placeholder="Search advisors"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="-mx-4 -mb-4 max-h-72 overflow-y-auto px-1.5 pb-1.5">
              {filtered.map((candidate) => {
                const isActive = candidate.id === advisor.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    disabled={isStartingAdvisorChat}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => {
                      setOpen(false);
                      if (isActive) return;
                      void startAdvisorChat(candidate.id);
                    }}
                  >
                    <img
                      src={advisorAvatarSrc(candidate.id)}
                      alt=""
                      draggable={false}
                      loading="lazy"
                      className="size-6 shrink-0 object-contain"
                    />
                    <span className="flex-1 truncate">{candidate.displayName}</span>
                    {isActive && <CheckIcon className="size-3.5 shrink-0 text-foreground/70" />}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p className="px-2.5 py-3 text-center text-xs text-muted-foreground/50">
                  No advisors found
                </p>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      </div>
      {randomQuote && (
        <figure
          className="hidden max-w-xl flex-col items-center px-8 text-center [@media(min-height:720px)]:flex"
          style={{ marginTop: 36 }}
        >
          <QuoteIcon
            aria-hidden="true"
            className="mb-3 size-5 text-foreground/25"
            strokeWidth={1.75}
          />
          <blockquote className="font-serif text-base leading-relaxed italic text-foreground/75 sm:text-lg">
            {randomQuote}
          </blockquote>
        </figure>
      )}
    </div>
  );
});
