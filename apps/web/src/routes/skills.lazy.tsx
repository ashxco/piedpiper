import { createLazyFileRoute } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  GlobeIcon,
  SearchIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Components } from "react-markdown";
import type { MergedSkill, SkillDetailResult } from "@piedpiper/contracts";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { OFFICIAL_SKILL_SOURCES } from "../components/skills/officialSkillSources";
import { isElectron } from "../env";
import { getWsRpcClient } from "../wsRpcClient";

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-4 mt-8 text-2xl font-bold text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-6 text-xl font-semibold text-foreground">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 text-base font-semibold text-foreground">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-2 mt-3 text-sm font-semibold text-foreground">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-3 leading-relaxed text-foreground/80">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-foreground/80">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return <code className="text-[13px]">{children}</code>;
    }
    return (
      <code className="rounded bg-secondary px-1.5 py-0.5 text-[13px] text-foreground">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg bg-secondary/80 p-4 text-sm">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-foreground/20 pl-4 italic text-foreground/60">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-foreground/10">{children}</thead>,
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-xs font-semibold text-foreground/60">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-t border-foreground/5 px-3 py-2 text-foreground/80">{children}</td>
  ),
  hr: () => <hr className="my-6 border-foreground/10" />,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
};

function SkillsPage() {
  const { state: sidebarState } = useSidebar();
  const collapsedPadding =
    isElectron && sidebarState === "collapsed" ? { paddingLeft: 128 } : undefined;
  const [skills, setSkills] = useState<MergedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<MergedSkill | null>(null);
  const [detail, setDetail] = useState<SkillDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    getWsRpcClient()
      .skills.search({ pageSize: 500 })
      .then((result) => {
        if (!disposed) setSkills([...result.skills]);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const loadDetail = useCallback((skill: MergedSkill) => {
    setSelectedSkill(skill);
    setDetail(null);
    setDetailLoading(true);
    getWsRpcClient()
      .skills.getDetail({
        id: skill.id,
        ...(skill.localPath ? { localPath: skill.localPath } : {}),
        ...(skill.owner ? { owner: skill.owner } : {}),
        ...(skill.repo ? { repo: skill.repo } : {}),
      })
      .then(setDetail)
      .catch(() => undefined)
      .finally(() => setDetailLoading(false));
  }, []);

  const handleUninstall = useCallback(
    async (skill: MergedSkill, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!skill.localPath) return;
      if (!window.confirm(`Uninstall "${skill.name}"? This will remove the skill directory.`))
        return;
      try {
        await getWsRpcClient().skills.uninstall({ skillPath: skill.localPath });
        setSkills((prev) => prev.filter((s) => s.id !== skill.id));
        if (selectedSkill?.id === skill.id) {
          setSelectedSkill(null);
          setDetail(null);
        }
      } catch {
        // Silent failure
      }
    },
    [selectedSkill],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, search]);

  if (selectedSkill) {
    return (
      <SidebarInset className="overflow-hidden bg-transparent flex flex-col h-full relative">
        <div
          className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-6"
          style={collapsedPadding}
        >
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              setSelectedSkill(null);
              setDetail(null);
            }}
          >
            <ArrowLeftIcon className="size-4" />
            Back to skills
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            <div className="mb-6">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-foreground">{selectedSkill.name}</h1>
                {selectedSkill.installed ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-500">
                    <CheckCircle2Icon className="size-3" />
                    Installed
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    <GlobeIcon className="size-3" />
                    Registry
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-foreground/70">{selectedSkill.description}</p>
              {selectedSkill.localPath && (
                <div className="mt-4 flex items-center justify-between rounded-lg border border-foreground/[0.06] bg-foreground/[0.02] px-4 py-3">
                  <div>
                    <p className="text-xs text-foreground/50">Installed at</p>
                    <p className="mt-0.5 text-xs text-foreground/45 font-mono">
                      {selectedSkill.localPath}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5 text-red-400 hover:bg-red-500/10 hover:text-red-400 border-red-500/20"
                    onClick={(e) => void handleUninstall(selectedSkill, e)}
                  >
                    <Trash2Icon className="size-3.5" />
                    Uninstall
                  </Button>
                </div>
              )}
            </div>

            {detailLoading && (
              <div className="py-12 text-center text-sm text-foreground/50">
                Loading skill content...
              </div>
            )}

            {detail && (
              <div className="skill-markdown max-w-none text-sm text-foreground/90">
                {detail.localContent && (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {detail.localContent}
                  </ReactMarkdown>
                )}
                {detail.registryContent && !detail.localContent && (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {detail.registryContent}
                  </ReactMarkdown>
                )}
              </div>
            )}
          </div>
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="overflow-hidden bg-transparent flex flex-col h-full relative">
      {/* Header */}
      <div
        className="drag-region flex h-[52px] shrink-0 items-center justify-between border-b border-border px-6"
        style={collapsedPadding}
      >
        <div className="flex items-center gap-3">
          <WrenchIcon className="size-5 text-foreground/70" />
          <h1 className="text-lg font-semibold text-foreground">Skills</h1>
        </div>
        <span className="text-xs text-foreground/45">{skills.length} installed</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-8 py-6">
          {/* Search installed */}
          {skills.length > 0 && (
            <div className="group mb-6 flex items-center gap-3 border-b border-foreground/10 pb-3 transition-colors focus-within:border-foreground/30">
              <SearchIcon className="size-4 shrink-0 text-foreground/45 group-focus-within:text-foreground/60" />
              <input
                className="min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-foreground/40 focus:outline-none"
                placeholder="Search installed skills..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="rounded-full p-1 text-foreground/45 transition-colors hover:text-foreground"
                  onClick={() => setSearch("")}
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Installed skills */}
          {loading ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <div className="size-5 animate-spin rounded-full border-2 border-foreground/10 border-t-foreground/50" />
              <span className="text-xs text-foreground/50">Scanning skills...</span>
            </div>
          ) : filtered.length > 0 ? (
            <>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-foreground/50">
                Installed ({filtered.length})
              </h2>
              <div className="mb-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className="group rounded-xl border border-foreground/[0.06] bg-foreground/[0.02] p-4 text-left transition-all hover:border-foreground/15 hover:bg-foreground/[0.05]"
                    onClick={() => loadDetail(skill)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground group-hover:text-foreground">
                        {skill.name}
                      </h3>
                      <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                    </div>
                    {skill.description && (
                      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-foreground/60">
                        {skill.description}
                      </p>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : !search ? (
            <div className="mb-10 rounded-xl border border-dashed border-foreground/10 p-8 text-center">
              <p className="text-sm text-foreground/50">No skills installed yet</p>
              <p className="mt-1 text-xs text-foreground/40">
                Browse official skills below to get started
              </p>
            </div>
          ) : (
            <div className="mb-10 py-8 text-center">
              <p className="text-sm text-foreground/50">
                No installed skills match &ldquo;{search}&rdquo;
              </p>
            </div>
          )}

          {/* Official Skills Directory */}
          <div className="border-t border-foreground/5 pt-8">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Official Skills</h2>
                <p className="mt-0.5 text-xs text-foreground/50">
                  Curated skills from technology makers on skills.sh
                </p>
              </div>
              <a
                href="https://skills.sh/official"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-full border border-foreground/10 px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
              >
                <GlobeIcon className="size-3" />
                Browse all on skills.sh
              </a>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {OFFICIAL_SKILL_SOURCES.map((source) => (
                <a
                  key={source.owner}
                  href={`https://skills.sh/${source.owner}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group rounded-xl border border-foreground/[0.06] bg-foreground/[0.02] p-4 transition-all hover:border-foreground/15 hover:bg-foreground/[0.05]"
                >
                  <div className="flex items-center gap-3">
                    <img
                      src={`https://github.com/${source.owner}.png?size=48`}
                      alt=""
                      className="size-9 rounded-full bg-muted ring-1 ring-foreground/5"
                      loading="lazy"
                    />
                    <div className="truncate text-sm font-semibold text-foreground">
                      {source.owner}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <span className="inline-flex items-center rounded-md bg-foreground/[0.05] px-2 py-0.5 font-mono text-[11px] text-foreground/45">
                      {source.repo}
                    </span>
                    <span className="inline-flex items-center rounded-md bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-foreground/45">
                      {source.repos} repo{source.repos === 1 ? "" : "s"}
                    </span>
                    <span className="inline-flex items-center rounded-md bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-foreground/45">
                      {source.skills} skill{source.skills === 1 ? "" : "s"}
                    </span>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createLazyFileRoute("/skills")({
  component: SkillsPage,
});
