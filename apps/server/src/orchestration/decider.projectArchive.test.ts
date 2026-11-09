import { CommandId, EventId, ProjectId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import type { ServerReadModel } from "./ServerReadModel.ts";

const now = "2026-03-01T00:00:00.000Z";
const later = "2026-03-02T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("project-archive");
const workspaceRoot = "/tmp/project-archive";

const eventBase = (sequence: number) => ({
  sequence,
  eventId: EventId.makeUnsafe(`evt-${sequence}`),
  aggregateKind: "project" as const,
  aggregateId: projectId,
  occurredAt: now,
  commandId: CommandId.makeUnsafe(`cmd-${sequence}`),
  causationEventId: null,
  correlationId: CommandId.makeUnsafe(`cmd-${sequence}`),
  metadata: {},
});

const readModelWithProject = (
  archivedAt?: string,
  root: string = workspaceRoot,
): Promise<ServerReadModel> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const created = yield* projectEvent(createEmptyReadModel(now), {
        ...eventBase(1),
        type: "project.created",
        payload: {
          projectId,
          title: "Archive",
          workspaceRoot: root,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      if (archivedAt === undefined) return created;
      return yield* projectEvent(created, {
        ...eventBase(2),
        type: "project.meta-updated",
        payload: { projectId, archivedAt, updatedAt: archivedAt },
      });
    }),
  );

const metaUpdate = (fields: {
  readonly archivedAt?: string | null;
  readonly faviconPath?: string | null;
  readonly title?: string;
}) => ({
  type: "project.meta.update" as const,
  commandId: CommandId.makeUnsafe("cmd-meta"),
  projectId,
  ...fields,
});

const reAdd = {
  type: "project.create" as const,
  commandId: CommandId.makeUnsafe("cmd-re-add"),
  projectId: ProjectId.makeUnsafe("project-re-add"),
  title: "Re-add",
  workspaceRoot,
  createdAt: later,
};

const decideSingle = async (
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
  readModel: ServerReadModel,
) => {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  if ("type" in result) return result;
  throw new Error("expected a single event");
};

describe("decider project archive", () => {
  it("carries archivedAt through project.meta.update and the projector", async () => {
    const readModel = await readModelWithProject();
    const event = await decideSingle(metaUpdate({ archivedAt: later }), readModel);
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { archivedAt?: string | null }).archivedAt).toBe(later);

    const archived = await readModelWithProject(later);
    expect(archived.projects.get(projectId)?.archivedAt).toBe(later);
    expect(archived.projects.get(projectId)?.deletedAt).toBeNull();
  });

  it("keeps the first archive time when an archived project is archived again", async () => {
    const readModel = await readModelWithProject(now);
    const event = await decideSingle(metaUpdate({ archivedAt: later }), readModel);
    expect((event.payload as { archivedAt?: string | null }).archivedAt).toBe(now);
  });

  it("leaves archivedAt out when the command does not set it", async () => {
    const readModel = await readModelWithProject(later);
    const event = await decideSingle(metaUpdate({ title: "Renamed" }), readModel);
    expect(event.payload).not.toHaveProperty("archivedAt");
    const next = await Effect.runPromise(
      projectEvent(readModel, { ...eventBase(3), ...event, sequence: 3 } as never),
    );
    expect(next.projects.get(projectId)?.archivedAt).toBe(later);
  });

  it("unarchives on an explicit null", async () => {
    const readModel = await readModelWithProject(later);
    const event = await decideSingle(metaUpdate({ archivedAt: null }), readModel);
    expect((event.payload as { archivedAt?: string | null }).archivedAt).toBeNull();
  });

  it("re-adding an archived folder unarchives the existing project", async () => {
    const readModel = await readModelWithProject(later);
    const event = await decideSingle(reAdd, readModel);
    expect(event.type).toBe("project.meta-updated");
    expect(event.aggregateId).toBe(projectId);
    expect(event.payload).toMatchObject({ projectId, archivedAt: null });
  });

  it("re-adding an active folder fails with a readable error naming the root", async () => {
    const readModel = await readModelWithProject();
    const error = await Effect.runPromise(
      decideOrchestrationCommand({ command: reAdd, readModel }).pipe(Effect.flip),
    );
    expect(error._tag).toBe("OrchestrationCommandInvariantError");
    expect(error.detail).toBe(`A project already exists at '${workspaceRoot}'.`);
  });

  it("treats a Windows root that differs only in casing as the same folder", async () => {
    const readModel = await readModelWithProject(undefined, "C:\\Code\\App");
    const error = await Effect.runPromise(
      decideOrchestrationCommand({
        command: { ...reAdd, workspaceRoot: "c:\\code\\app" },
        readModel,
      }).pipe(Effect.flip),
    );
    expect(error.detail).toBe("A project already exists at 'C:\\Code\\App'.");
  });

  it("keeps POSIX roots that differ in casing as separate folders", async () => {
    const readModel = await readModelWithProject();
    const event = await decideSingle(
      { ...reAdd, workspaceRoot: workspaceRoot.toUpperCase() },
      readModel,
    );
    expect(event.type).toBe("project.created");
  });
});

describe("project favicon path", () => {
  const icon = "/Users/me/icons/logo.png";

  it("copies faviconPath into the event only when the command sets it", async () => {
    const readModel = await readModelWithProject();
    const set = await decideSingle(metaUpdate({ faviconPath: icon }), readModel);
    expect(set.payload).toMatchObject({ projectId, faviconPath: icon });
    const cleared = await decideSingle(metaUpdate({ faviconPath: null }), readModel);
    expect(cleared.payload).toMatchObject({ projectId, faviconPath: null });
    const absent = await decideSingle(metaUpdate({ title: "Renamed" }), readModel);
    expect(absent.payload).not.toHaveProperty("faviconPath");
  });

  it("projects set, keep across an unrelated update, and clear", async () => {
    const created = await readModelWithProject();
    expect(created.projects.get(projectId)?.faviconPath).toBeNull();
    const project = (model: ServerReadModel, sequence: number, payload: object) =>
      Effect.runPromise(
        projectEvent(model, {
          ...eventBase(sequence),
          type: "project.meta-updated",
          payload: { projectId, updatedAt: later, ...payload },
        }),
      );
    const set = await project(created, 2, { faviconPath: icon });
    expect(set.projects.get(projectId)?.faviconPath).toBe(icon);
    const renamed = await project(set, 3, { title: "Renamed" });
    expect(renamed.projects.get(projectId)?.faviconPath).toBe(icon);
    const cleared = await project(renamed, 4, { faviconPath: null });
    expect(cleared.projects.get(projectId)?.faviconPath).toBeNull();
  });
});
