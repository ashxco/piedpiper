import { type ThreadId } from "@piedpiper/contracts";
import { createLazyFileRoute } from "@tanstack/react-router";
import { Suspense, lazy, useMemo } from "react";

// Lazy-loaded so the office's heavy dep tree (CHARACTER_LINES, AGENT_LINES,
// WORKING_MESSAGES, npc tier arrays, the seat layout, the joystick, etc.)
// lands in its own chunk instead of the chat critical path. The office is
// only ever rendered when the user navigates to /virtual-office.
const OfficeMode = lazy(() =>
  import("../components/office-mode/OfficeMode").then((mod) => ({ default: mod.OfficeMode })),
);
import { SidebarInset } from "../components/ui/sidebar";
import { useStore } from "../store";
import { useUserProjects } from "../storeSelectors";

function VirtualOfficePage() {
  const projects = useUserProjects();
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);

  const projectThreads = useMemo(() => {
    return projects.map((project) => {
      const threadIds = threadIdsByProjectId[project.id] ?? [];
      const threads = threadIds
        .map((id: ThreadId) => sidebarThreadsById[id])
        .filter((t): t is NonNullable<typeof t> => t != null)
        .filter((t) => !t.archivedAt)
        .toSorted((a, b) => {
          const aTime = a.updatedAt ?? a.createdAt;
          const bTime = b.updatedAt ?? b.createdAt;
          return bTime.localeCompare(aTime);
        });
      return { project, threads };
    });
  }, [projects, sidebarThreadsById, threadIdsByProjectId]);

  return (
    <SidebarInset className="overflow-hidden bg-transparent flex flex-col h-full relative">
      <div className="drag-region absolute top-0 left-0 right-0 z-[999999] h-[52px]" />
      <Suspense fallback={null}>
        <OfficeMode projectThreads={projectThreads} />
      </Suspense>
    </SidebarInset>
  );
}

export const Route = createLazyFileRoute("/virtual-office")({
  component: VirtualOfficePage,
});
