import { ProjectId, ThreadId } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  RenderedProjectCache,
  arrayElementsEqual,
  type RenderedProjectInputs,
} from "./sidebarRenderCache";

interface FakeProject {
  id: ProjectId;
}
interface FakeThread {
  id: ThreadId;
  updatedAt: string;
}

const projectId = ProjectId.makeUnsafe("project-1");
const threadA: FakeThread = { id: ThreadId.makeUnsafe("thread-a"), updatedAt: "1" };
const threadB: FakeThread = { id: ThreadId.makeUnsafe("thread-b"), updatedAt: "1" };

function makeInputs(
  overrides: Partial<RenderedProjectInputs<FakeProject, FakeThread>> = {},
): RenderedProjectInputs<FakeProject, FakeThread> {
  return {
    project: { id: projectId },
    threads: [threadA, threadB],
    lastVisitedAts: [undefined, "2026-01-01T00:00:00.000Z"],
    sortOrder: "updated_at",
    routeThreadId: null,
    isThreadListExpanded: false,
    draftThreadId: null,
    ...overrides,
  };
}

describe("RenderedProjectCache", () => {
  it("returns the cached result while every input is reference-equal", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, { ids: ThreadId[] }>();
    const compute = vi.fn((inputs: RenderedProjectInputs<FakeProject, FakeThread>) => ({
      ids: inputs.threads.map((thread) => thread.id),
    }));
    const project = { id: projectId };

    const first = cache.resolve(projectId, makeInputs({ project }), compute);
    const second = cache.resolve(projectId, makeInputs({ project }), compute);

    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes when a thread enters or leaves the snoozed shelf, and not otherwise", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, { flags: boolean[] }>();
    const compute = vi.fn((inputs: RenderedProjectInputs<FakeProject, FakeThread>) => ({
      flags: [...(inputs.snoozedFlags ?? [])],
    }));
    const project = { id: projectId };

    cache.resolve(projectId, makeInputs({ project, snoozedFlags: [false, false] }), compute);
    cache.resolve(projectId, makeInputs({ project, snoozedFlags: [false, false] }), compute);
    expect(compute).toHaveBeenCalledTimes(1);

    const next = cache.resolve(
      projectId,
      makeInputs({ project, snoozedFlags: [false, true] }),
      compute,
    );
    expect(compute).toHaveBeenCalledTimes(2);
    expect(next.flags).toEqual([false, true]);
  });

  it("recomputes when a thread is pinned or unpinned", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, { pinned: boolean[] }>();
    const compute = vi.fn((inputs: RenderedProjectInputs<FakeProject, FakeThread>) => ({
      pinned: [...(inputs.pinnedFlags ?? [])],
    }));
    const project = { id: projectId };

    cache.resolve(projectId, makeInputs({ project, pinnedFlags: [false, false] }), compute);
    cache.resolve(projectId, makeInputs({ project, pinnedFlags: [false, false] }), compute);
    const pinned = cache.resolve(
      projectId,
      makeInputs({ project, pinnedFlags: [false, true] }),
      compute,
    );

    expect(compute).toHaveBeenCalledTimes(2);
    expect(pinned.pinned).toEqual([false, true]);
  });

  it("recomputes when one thread summary is replaced", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, { ids: ThreadId[] }>();
    const compute = vi.fn((inputs: RenderedProjectInputs<FakeProject, FakeThread>) => ({
      ids: inputs.threads.map((thread) => thread.id),
    }));
    const project = { id: projectId };

    const first = cache.resolve(projectId, makeInputs({ project }), compute);
    const second = cache.resolve(
      projectId,
      makeInputs({ project, threads: [threadA, { ...threadB, updatedAt: "2" }] }),
      compute,
    );

    // The recompute yields the same ids, so the previous result is handed back.
    expect(second).toBe(first);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("returns a new result but keeps unchanged arrays and records when one field changes", () => {
    const cache = new RenderedProjectCache<
      FakeProject,
      FakeThread,
      { ids: ThreadId[]; status: { label: string }; count: number }
    >();
    const compute = (inputs: RenderedProjectInputs<FakeProject, FakeThread>) => ({
      ids: inputs.threads.map((thread) => thread.id),
      status: { label: "Working" },
      count: inputs.isThreadListExpanded ? 2 : 1,
    });
    const project = { id: projectId };

    const first = cache.resolve(projectId, makeInputs({ project }), compute);
    const second = cache.resolve(
      projectId,
      makeInputs({ project, isThreadListExpanded: true }),
      compute,
    );

    expect(second).not.toBe(first);
    expect(second.count).toBe(2);
    expect(second.ids).toBe(first.ids);
    expect(second.status).toBe(first.status);
  });

  it("returns new arrays when their elements change", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, { ids: ThreadId[] }>();
    const compute = (inputs: RenderedProjectInputs<FakeProject, FakeThread>) => ({
      ids: inputs.threads.map((thread) => thread.id),
    });
    const project = { id: projectId };

    const first = cache.resolve(projectId, makeInputs({ project }), compute);
    const second = cache.resolve(
      projectId,
      makeInputs({ project, threads: [threadB, threadA], lastVisitedAts: [undefined, undefined] }),
      compute,
    );

    expect(second).not.toBe(first);
    expect(second.ids).toEqual([threadB.id, threadA.id]);
  });

  it("recomputes when a scalar input such as the route thread changes", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, number>();
    let calls = 0;
    const compute = () => (calls += 1);
    const project = { id: projectId };

    cache.resolve(projectId, makeInputs({ project }), compute);
    cache.resolve(projectId, makeInputs({ project, routeThreadId: threadA.id }), compute);
    cache.resolve(projectId, makeInputs({ project, routeThreadId: threadA.id }), compute);

    expect(calls).toBe(2);
  });

  it("recomputes when the thread preview limit changes", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, number | undefined>();
    const compute = vi.fn(
      (inputs: RenderedProjectInputs<FakeProject, FakeThread>) => inputs.previewLimit,
    );
    const project = { id: projectId };

    cache.resolve(projectId, makeInputs({ project, previewLimit: 6 }), compute);
    cache.resolve(projectId, makeInputs({ project, previewLimit: 6 }), compute);
    const result = cache.resolve(projectId, makeInputs({ project, previewLimit: 10 }), compute);

    expect(compute).toHaveBeenCalledTimes(2);
    expect(result).toBe(10);
  });

  it("recomputes when a shelved thread's wake time changes", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, number>();
    const compute = vi.fn(() => 1);
    const project = { id: projectId };
    const wakes = (first: string) => ({ project, snoozedUntils: [first, undefined] });

    cache.resolve(projectId, makeInputs(wakes("2026-01-01T00:00:00.000Z")), compute);
    cache.resolve(projectId, makeInputs(wakes("2026-01-01T00:00:00.000Z")), compute);
    expect(compute).toHaveBeenCalledTimes(1);
    cache.resolve(projectId, makeInputs(wakes("2026-01-02T00:00:00.000Z")), compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("drops entries for projects that stopped rendering", () => {
    const cache = new RenderedProjectCache<FakeProject, FakeThread, number>();
    let calls = 0;
    const compute = () => (calls += 1);
    const project = { id: projectId };

    cache.resolve(projectId, makeInputs({ project }), compute);
    cache.retainOnly(new Set());
    cache.resolve(projectId, makeInputs({ project }), compute);

    expect(calls).toBe(2);
  });
});

describe("identity helpers", () => {
  it("compares arrays element-wise by reference", () => {
    expect(arrayElementsEqual([threadA, threadB], [threadA, threadB])).toBe(true);
    expect(arrayElementsEqual([threadA, threadB], [threadA, { ...threadB }])).toBe(false);
    expect(arrayElementsEqual([threadA], [threadA, threadB])).toBe(false);
  });
});
