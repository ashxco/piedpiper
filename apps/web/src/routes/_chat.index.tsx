import { createFileRoute } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon, FolderSearchIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { AgentSessionProjectPicker } from "../components/AgentSessionProjectPicker";
import { isElectron } from "../env";
import { useAddProjectFromPath } from "../hooks/useAddProjectFromPath";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { selectableProjects } from "../lib/projectArchive";
import { cn } from "../lib/utils";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useUserProjects } from "../storeSelectors";

function ChatIndexRouteView() {
  const projects = selectableProjects(useUserProjects());
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const { handleNewThread } = useHandleNewThread();
  const { pickAndAddProject } = useAddProjectFromPath({
    onSuccess: () => {},
  });

  const hasProjects = projects.length > 0;

  return (
    <div
      {...workspaceAreaProps("content", 1, "New thread")}
      className="flex h-full min-w-0 flex-1 flex-col bg-background surface-grain"
    >
      {isElectron && <div className="drag-region h-[52px] shrink-0" />}

      <div
        // Dark window-button symbols are unreadable on the first-run gradient, so it starts below them.
        className={cn(
          "-mt-[52px] flex flex-1 flex-col items-center justify-center",
          !hasProjects && "wco:not-dark:mt-0",
        )}
        style={
          hasProjects
            ? undefined
            : {
                background:
                  "radial-gradient(50% 50% at 50% 35%, #000 0%, transparent 100%), radial-gradient(60% 60% at 50% 35%, rgba(88, 28, 135, 0.25) 0%, transparent 100%), radial-gradient(50% 50% at 15% 80%, rgba(126, 34, 206, 0.18) 0%, transparent 100%), radial-gradient(50% 50% at 85% 75%, rgba(59, 130, 246, 0.12) 0%, transparent 100%), #0a0a0f",
              }
        }
      >
        {hasProjects ? (
          <>
            <img
              src="/empty-thread.png"
              alt=""
              className="mb-5 size-48 object-contain"
              draggable={false}
            />
            <p className="mb-8 text-2xl font-semibold text-foreground">
              What would you like to build today?
            </p>

            <div className="w-full max-w-md px-6">
              <button
                type="button"
                onClick={() => void pickAndAddProject()}
                className="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-secondary/50 px-4 py-3 text-left transition-colors hover:bg-accent/50"
              >
                <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground/40" />
                <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground/85">
                  Add New Project
                </p>
              </button>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="mt-2 flex w-full cursor-pointer items-center gap-3 rounded-xl bg-secondary/50 px-4 py-3 text-left transition-colors hover:bg-accent/50"
              >
                <FolderSearchIcon className="size-4 shrink-0 text-muted-foreground/40" />
                <p className="min-w-0 flex-1 text-[13px] font-medium text-foreground/85">
                  Find Projects from Claude Code and Codex
                </p>
              </button>

              {(() => {
                const sorted = projects.toSorted((a, b) => {
                  const aTime = a.updatedAt ?? a.createdAt ?? "";
                  const bTime = b.updatedAt ?? b.createdAt ?? "";
                  return bTime.localeCompare(aTime);
                });
                const q = search.trim().toLowerCase();
                const filtered = q
                  ? sorted.filter((p) => p.name.toLowerCase().includes(q))
                  : sorted;
                return (
                  <div className="mt-4 overflow-hidden rounded-xl bg-secondary/50">
                    {projects.length > 5 && (
                      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/30" />
                        <input
                          type="text"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Search projects..."
                          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/30 outline-none"
                        />
                      </div>
                    )}
                    <div className="max-h-[220px] divide-y divide-border/40 overflow-y-auto">
                      {filtered.length === 0 ? (
                        <p className="px-4 py-3 text-center text-[13px] text-muted-foreground/40">
                          No projects found
                        </p>
                      ) : (
                        filtered.map((project) => (
                          <button
                            key={project.id}
                            type="button"
                            onClick={() => {
                              // No options: a reused draft resets to no branch/worktree and
                              // the default env mode.
                              void handleNewThread(project.id);
                            }}
                            className="group flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/50"
                          >
                            <FolderIcon className="size-4 shrink-0 text-muted-foreground/40" />
                            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85">
                              {project.name}
                            </p>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center px-6" style={{ marginTop: -80 }}>
            <img
              src="/piedpiper-overview.png"
              alt="Pied Piper"
              className="size-[460px] object-contain"
              draggable={false}
            />
            <h1
              className="text-5xl font-bold tracking-tight"
              style={{
                background: "linear-gradient(135deg, #e2e8f0, #ffffff, #94a3b8)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Pied Piper
            </h1>
            <p className="mt-6 max-w-lg text-center text-base leading-relaxed text-white/60">
              A minimal GUI for coding agents. Manage projects, orchestrate AI workflows, and watch
              your team work from the office.
            </p>
            <button
              type="button"
              onClick={() => void pickAndAddProject()}
              className="mt-8 inline-flex cursor-pointer items-center gap-2 rounded-full border border-border px-8 py-3 text-base font-medium text-foreground transition-colors hover:bg-accent"
            >
              <FolderPlusIcon className="size-4" />
              Add Project
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="mt-4 cursor-pointer text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Find projects from Claude Code and Codex
            </button>
          </div>
        )}
      </div>
      <AgentSessionProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
