import { ADVISORS_PROJECT_ID } from "@piedpiper/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, PlayIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import {
  advisorAvatarSrc,
  advisorThreadTitle,
  type ParsedAdvisor,
} from "../../lib/advisorIdentity";
import { buildAdvisorSkillPrompt, getAdvisorMeta } from "../../lib/advisorSkills";
import { newCommandId, newThreadId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useUserProjects } from "../../storeSelectors";
import { toastManager } from "../ui/toast";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useNavigate } from "@tanstack/react-router";

interface AdvisorSkillLandingProps {
  readonly advisor: ParsedAdvisor;
}

export const AdvisorSkillLanding = memo(function AdvisorSkillLanding({
  advisor,
}: AdvisorSkillLandingProps) {
  const navigate = useNavigate();
  const meta = getAdvisorMeta(advisor.id);
  const visibleProjects = useUserProjects();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    visibleProjects[0]?.id ?? null,
  );
  const selectedProject = visibleProjects.find((p) => p.id === selectedProjectId);

  const [selectedSkillKey, setSelectedSkillKey] = useState<string>(meta?.skills[0]?.key ?? "");
  const selectedSkill = meta?.skills.find((s) => s.key === selectedSkillKey) ?? meta?.skills[0];

  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const handleStart = useCallback(async () => {
    if (!selectedProject || !selectedSkill || !meta || isStarting) return;
    const api = readNativeApi();
    if (!api) return;

    setIsStarting(true);
    try {
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const systemPrompt = buildAdvisorSkillPrompt(advisor.baseName, selectedSkill);

      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: ADVISORS_PROJECT_ID,
        title: advisorThreadTitle(advisor.id),
        modelSelection: {
          provider: "claudeAgent",
          model: selectedSkill.defaultModel,
          options: { contextWindow: "200k" },
        },
        runtimeMode: "full-access",
        // Agent mode — skill advisors need file read/write for skill
        // instructions and report output.
        interactionMode: "default",
        systemPrompt,
        branch: null,
        // worktreePath overrides the cwd so the agent operates in the
        // selected project's workspace, not the empty advisors dir.
        worktreePath: selectedProject.cwd,
        createdAt,
      });

      await navigate({ to: "/$threadId", params: { threadId } });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start session",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsStarting(false);
    }
  }, [advisor, isStarting, meta, navigate, selectedProject, selectedSkill]);

  if (!meta) return null;

  const hasMultipleSkills = meta.skills.length > 1;

  return (
    <div className="-mt-[36px] flex h-full flex-col items-center justify-center gap-5">
      {/* Avatar */}
      <img
        src={advisorAvatarSrc(advisor.id)}
        alt={advisor.displayName}
        draggable={false}
        className="h-36 w-auto object-contain"
      />

      {/* Role + name */}
      <div className="text-center">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">{meta.role}</h2>
        <p className="mt-1 text-sm text-foreground/50">with {advisor.shortName}</p>
      </div>

      {/* Blurb */}
      <p className="max-w-md text-center text-sm leading-relaxed text-foreground/60">
        {meta.blurb}
      </p>

      {/* Skill picker (multi-skill advisors only) */}
      {hasMultipleSkills && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {meta.skills.map((skill) => (
            <button
              key={skill.key}
              type="button"
              onClick={() => setSelectedSkillKey(skill.key)}
              title={skill.description}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                selectedSkillKey === skill.key
                  ? "bg-foreground/10 text-foreground"
                  : "text-foreground/40 hover:text-foreground/70"
              }`}
            >
              {skill.label}
            </button>
          ))}
        </div>
      )}

      {/* Skill description */}
      {selectedSkill && <p className="text-xs text-foreground/40">{selectedSkill.description}</p>}

      {/* Project picker */}
      <div className="w-full max-w-xs">
        <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-2 text-left text-sm transition-colors hover:border-foreground/20"
              />
            }
          >
            <FolderIcon className="size-4 shrink-0 text-foreground/40" />
            <span className="min-w-0 flex-1 truncate text-foreground/80">
              {selectedProject ? selectedProject.name : "Select a workspace…"}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-foreground/40" />
          </PopoverTrigger>
          <PopoverPopup className="w-72" sideOffset={8}>
            <div className="-mx-4 -mb-4 -mt-4 max-h-64 overflow-y-auto px-1.5 py-1.5">
              {visibleProjects.length === 0 ? (
                <p className="px-2.5 py-4 text-center text-xs text-muted-foreground/50">
                  No projects yet. Add one from the sidebar.
                </p>
              ) : (
                visibleProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setProjectPickerOpen(false);
                    }}
                  >
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{project.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground/60">
                        {project.cwd}
                      </div>
                    </div>
                    {project.id === selectedProjectId && (
                      <CheckIcon className="size-3.5 shrink-0 text-foreground/70" />
                    )}
                  </button>
                ))
              )}
            </div>
          </PopoverPopup>
        </Popover>
      </div>

      {/* CTA */}
      <button
        type="button"
        disabled={isStarting || !selectedProject}
        onClick={() => void handleStart()}
        className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition-all hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PlayIcon className="size-4" />
        {selectedSkill ? `Start ${selectedSkill.label}` : `Start ${meta.role}`}
      </button>
    </div>
  );
});
