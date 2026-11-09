import { type ProjectId } from "@piedpiper/contracts";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { selectableProjects } from "~/lib/projectArchive";

import { ProjectFavicon } from "../ProjectFavicon";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface NewThreadLandingProps {
  activeProject: { id: ProjectId; name: string } | null | undefined;
  allProjects: ReadonlyArray<{
    id: ProjectId;
    name: string;
    cwd: string;
    archivedAt?: string | null | undefined;
  }>;
  onSwitchProject: (projectId: ProjectId) => void;
  onAddProject: () => void;
}

export const NewThreadLanding = memo(function NewThreadLanding({
  activeProject,
  allProjects,
  onSwitchProject,
  onAddProject,
}: NewThreadLandingProps) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const projects = selectableProjects(allProjects);
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [allProjects, search]);

  return (
    <div className="-mt-[36px] flex h-full flex-col items-center justify-center gap-2">
      <img src="/empty-thread.png" alt="" className="size-48 object-contain" draggable={false} />
      <div className="text-center">
        <h2 className="text-2xl font-semibold text-foreground">Let's pipe some code in</h2>
        {activeProject && (
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
                  className="mt-1 inline-flex max-w-[420px] items-center gap-1.5 text-2xl text-muted-foreground transition-colors hover:text-foreground"
                />
              }
            >
              <span className="min-w-0 truncate" title={activeProject.name}>
                {activeProject.name}
              </span>
              <ChevronDownIcon className="size-4 shrink-0 opacity-60" />
            </PopoverTrigger>
            <PopoverPopup className="w-64" sideOffset={8}>
              <div className="-mx-4 -mt-4 px-3 pt-3 pb-2">
                <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1.5">
                  <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                  <input
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                    placeholder="Search projects"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>
              <div className="-mx-4 -mb-4 max-h-56 overflow-y-auto px-1.5 pb-1.5">
                {filtered.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
                    onClick={() => {
                      setOpen(false);
                      onSwitchProject(project.id);
                    }}
                  >
                    <ProjectFavicon cwd={project.cwd} className="text-muted-foreground/70!" />
                    <span className="flex-1 truncate">{project.name}</span>
                    {project.id === activeProject.id && (
                      <CheckIcon className="size-3.5 shrink-0 text-foreground/70" />
                    )}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-2.5 py-3 text-center text-xs text-muted-foreground/50">
                    No projects found
                  </p>
                )}
                <div className="mt-1 border-t border-border pt-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      setOpen(false);
                      onAddProject();
                    }}
                  >
                    <PlusIcon className="size-3.5 shrink-0" />
                    <span>Add new project</span>
                  </button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        )}
      </div>
    </div>
  );
});
