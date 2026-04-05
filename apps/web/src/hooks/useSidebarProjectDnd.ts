import {
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { type ProjectId } from "@piedpiper/contracts";
import { type MutableRefObject, useCallback } from "react";

import { type Project } from "../types";

interface UseSidebarProjectDndInput {
  manualSortEnabled: boolean;
  sidebarProjects: ReadonlyArray<Project>;
  reorderProjects: (activeProjectId: ProjectId, overProjectId: ProjectId) => void;
  dragInProgressRef: MutableRefObject<boolean>;
  suppressProjectClickAfterDragRef: MutableRefObject<boolean>;
}

/**
 * Project list drag-and-drop wiring for the sidebar.
 *
 * Encapsulates the dnd-kit sensor setup, the collision detection strategy
 * (pointer-within first, fall back to closest corners), and the three
 * drag lifecycle handlers. The handlers honor the user's preferred
 * sidebar sort order — manual sorting is required for reorders to take
 * effect, otherwise drag is treated as a no-op pass-through.
 */
export function useSidebarProjectDnd(input: UseSidebarProjectDndInput) {
  const {
    manualSortEnabled,
    sidebarProjects,
    reorderProjects,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
  } = input;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }
    return closestCorners(args);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!manualSortEnabled) {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.id === active.id);
      const overProject = sidebarProjects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [dragInProgressRef, manualSortEnabled, reorderProjects, sidebarProjects],
  );

  const handleDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (!manualSortEnabled) {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [dragInProgressRef, manualSortEnabled, suppressProjectClickAfterDragRef],
  );

  const handleDragCancel = useCallback(
    (_event: DragCancelEvent) => {
      dragInProgressRef.current = false;
    },
    [dragInProgressRef],
  );

  return {
    sensors,
    collisionDetection,
    handleDragEnd,
    handleDragStart,
    handleDragCancel,
  };
}
