import type {
  KeybindingCommand,
  KeybindingWhenNode,
  ProjectId,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import { isCommandPaletteOpen, useCommandPaletteStore } from "../commandPaletteStore";
import type { SidebarThreadSummary, ThreadSession } from "../types";
import {
  buildProjectItems,
  buildRootGroups,
  buildThreadItems,
  canRestartThreadSession,
  filterProjectPickerGroups,
  filterRootGroups,
  RECENT_THREAD_LIMIT,
  rankCommandPaletteItem,
  resolveCommandPaletteToggle,
  SEARCH_RESULT_LIMIT,
  selectCommandPaletteSources,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";

const PROJECT_ID = "project-1" as ProjectId;
const NOW_MS = Date.parse("2026-03-04T12:00:00.000Z");

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: id as ThreadId,
    projectId: PROJECT_ID,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function threadItems(threads: SidebarThreadSummary[]) {
  return buildThreadItems({
    threads,
    activeThreadId: null,
    projectTitleById: new Map([[PROJECT_ID, "Pied Piper"]]),
    sortOrder: "updated_at",
    nowMs: NOW_MS,
    icon: null,
    runThread: async () => undefined,
  });
}

function action(value: string, searchTerms: string[]): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    searchTerms,
    title: searchTerms[0] ?? value,
    icon: null,
    run: async () => undefined,
  };
}

function session(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "claudeAgent",
    status: "ready",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    orchestrationStatus: "ready",
    ...overrides,
  };
}

function input(threadSession: ThreadSession | null, pending = {}) {
  return {
    session: threadSession,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...pending,
  };
}

function keyEvent(overrides = {}) {
  return { key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

const groupValues = (groups: ReadonlyArray<{ value: string }>) => groups.map((g) => g.value);

describe("buildThreadItems", () => {
  it("drops archived threads and sorts the rest newest first", () => {
    const items = threadItems([
      thread("old", { updatedAt: "2026-03-01T00:00:00.000Z" }),
      thread("archived", { archivedAt: "2026-03-03T00:00:00.000Z" }),
      thread("new", { updatedAt: "2026-03-02T00:00:00.000Z" }),
    ]);
    expect(items.map((item) => item.title)).toEqual(["new", "old"]);
  });

  it("searches title, project and branch, and marks the current thread", () => {
    const [item] = buildThreadItems({
      threads: [thread("t1", { title: "Fix login", branch: "fix/login" })],
      activeThreadId: "t1" as ThreadId,
      projectTitleById: new Map([[PROJECT_ID, "Pied Piper"]]),
      sortOrder: "updated_at",
      nowMs: NOW_MS,
      icon: null,
      runThread: async () => undefined,
    });
    expect(item?.searchTerms).toEqual(["Fix login", "Pied Piper", "fix/login"]);
    expect(item?.description).toBe("Pied Piper · #fix/login · Current thread");
  });

  it("runs with the thread's id", async () => {
    const runThread = vi.fn(async () => undefined);
    const [item] = buildThreadItems({
      threads: [thread("t1")],
      activeThreadId: null,
      projectTitleById: new Map(),
      sortOrder: "updated_at",
      nowMs: NOW_MS,
      icon: null,
      runThread,
    });
    await item?.run();
    expect(runThread).toHaveBeenCalledWith("t1");
  });
});

const threadIds = (threads: SidebarThreadSummary[]) => threads.map((entry) => entry.id);

describe("selectCommandPaletteSources", () => {
  const active = { id: PROJECT_ID, archivedAt: null };
  const legacy = { id: "legacy" as ProjectId };
  const archived = { id: "archived" as ProjectId, archivedAt: "2026-03-01T00:00:00.000Z" };

  function sources(archivedThread: SidebarThreadSummary) {
    return selectCommandPaletteSources({
      projects: [active, legacy, archived],
      threadIdsByProjectId: { archived: [archivedThread.id] },
      sidebarThreadsById: {
        kept: thread("kept"),
        [archivedThread.id]: archivedThread,
      },
    });
  }

  it("never offers an archived project and hides its idle threads", () => {
    const result = sources(thread("idle", { projectId: archived.id }));
    expect(result.selectableProjects).toEqual([active, legacy]);
    expect(threadIds(result.threads)).toEqual(["kept"]);
  });

  it("keeps working threads of an archived project, as the sidebar does, but not the project", () => {
    const result = sources(
      thread("waiting", { projectId: archived.id, hasPendingUserInput: true }),
    );
    expect(result.selectableProjects).toEqual([active, legacy]);
    expect(threadIds(result.threads)).toEqual(["kept", "waiting"]);
  });
});

describe("rankCommandPaletteItem", () => {
  it("prefers an earlier term, then exact over prefix over contains", () => {
    const exact = rankCommandPaletteItem(["login"], "login")!;
    const prefix = rankCommandPaletteItem(["login page"], "login")!;
    const contains = rankCommandPaletteItem(["fix login"], "login")!;
    const inProject = rankCommandPaletteItem(["other", "login"], "login")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(contains);
    expect(contains).toBeGreaterThan(inProject);
  });

  it("matches words spread across terms, below any whole-query match", () => {
    const spread = rankCommandPaletteItem(["Fix login", "Pied Piper"], "piper login");
    expect(spread).toBe(0);
    expect(rankCommandPaletteItem(["Fix login"], "piper login")).toBeNull();
  });
});

describe("filterRootGroups", () => {
  const actions = [action("action:settings", ["Open settings"])];
  const projects = buildProjectItems({
    projects: [{ id: PROJECT_ID, name: "Pied Piper", cwd: "/repo/pied-piper" }],
    valuePrefix: "project",
    icon: () => null,
    runProject: async () => undefined,
  });

  it("shows actions plus capped recent threads for an empty query", () => {
    const threads = threadItems(
      Array.from({ length: RECENT_THREAD_LIMIT + 3 }, (_, index) => thread(`t${index}`)),
    );
    const groups = filterRootGroups({
      query: "  ",
      actionItems: actions,
      threadItems: threads,
      projectItems: projects,
    });
    expect(groupValues(groups)).toEqual(["actions", "recent-threads"]);
    expect(groups[1]?.items).toHaveLength(RECENT_THREAD_LIMIT);
  });

  it("omits empty groups", () => {
    expect(groupValues(buildRootGroups({ actionItems: actions, threadItems: [] }))).toEqual([
      "actions",
    ]);
  });

  it("searches threads, then projects, beyond the recent cap", () => {
    const threads = threadItems([
      ...Array.from({ length: RECENT_THREAD_LIMIT }, (_, index) =>
        thread(`t${index}`, { updatedAt: "2026-03-03T00:00:00.000Z" }),
      ),
      thread("older", { title: "Rarely opened", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const groups = filterRootGroups({
      query: "rarely",
      actionItems: actions,
      threadItems: threads,
      projectItems: projects,
    });
    expect(groupValues(groups)).toEqual(["threads"]);
    expect(groups[0]?.items[0]?.title).toBe("Rarely opened");

    const byProject = filterRootGroups({
      query: "pied",
      actionItems: actions,
      threadItems: threads,
      projectItems: projects,
    });
    expect(groupValues(byProject)).toEqual(["threads", "projects"]);
  });

  it("ranks title matches above project and branch matches, keeping recency on ties", () => {
    const threads = threadItems([
      thread("branch-hit", { branch: "login", updatedAt: "2026-03-03T00:00:00.000Z" }),
      thread("recent-title", { title: "Fix login", updatedAt: "2026-03-02T00:00:00.000Z" }),
      thread("older-title", { title: "Add login", updatedAt: "2026-03-01T00:00:00.000Z" }),
    ]);
    const [group] = filterRootGroups({
      query: "login",
      actionItems: [],
      threadItems: threads,
      projectItems: [],
    });
    expect(group?.items.map((item) => item.title)).toEqual([
      "Fix login",
      "Add login",
      "branch-hit",
    ]);
  });

  it("caps search results after ranking", () => {
    const threads = threadItems(
      Array.from({ length: SEARCH_RESULT_LIMIT + 5 }, (_, index) =>
        thread(`t${index}`, { title: index === 0 ? "needle" : `a needle ${index}` }),
      ),
    );
    const [group] = filterRootGroups({
      query: "needle",
      actionItems: [],
      threadItems: threads,
      projectItems: [],
    });
    expect(group?.items).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(group?.items[0]?.title).toBe("needle");
  });

  it("limits a > query to actions", () => {
    const threads = threadItems([thread("settings thread")]);
    const input = { actionItems: actions, threadItems: threads, projectItems: projects };
    expect(groupValues(filterRootGroups({ ...input, query: ">" }))).toEqual(["actions"]);
    expect(groupValues(filterRootGroups({ ...input, query: "> settings" }))).toEqual(["actions"]);
    expect(filterRootGroups({ ...input, query: ">nothing" })).toEqual([]);
    expect(groupValues(filterRootGroups({ ...input, query: "settings" }))).toEqual([
      "actions",
      "threads",
    ]);
  });
});

describe("filterProjectPickerGroups", () => {
  it("lists every project until a query narrows them", () => {
    const projectItems = [action("a", ["Alpha", "/repo/alpha"]), action("b", ["Beta", "/repo/b"])];
    expect(filterProjectPickerGroups({ query: "", projectItems })[0]?.items).toHaveLength(2);
    expect(
      filterProjectPickerGroups({ query: "bet", projectItems })[0]?.items.map((i) => i.value),
    ).toEqual(["b"]);
    expect(filterProjectPickerGroups({ query: "zzz", projectItems })).toEqual([]);
  });
});

describe("canRestartThreadSession", () => {
  it("allows an idle live session", () => {
    expect(canRestartThreadSession(input(session()))).toBe(true);
  });

  it.each([
    ["no session", input(null)],
    ["closed", input(session({ status: "closed", orchestrationStatus: "stopped" }))],
    ["running", input(session({ status: "running", orchestrationStatus: "running" }))],
    ["connecting", input(session({ status: "connecting", orchestrationStatus: "starting" }))],
    ["active turn", input(session({ activeTurnId: "turn-1" as never }))],
    ["pending approval", input(session(), { hasPendingApprovals: true })],
    ["pending question", input(session(), { hasPendingUserInput: true })],
  ])("refuses when %s", (_label, value) => {
    expect(canRestartThreadSession(value)).toBe(false);
  });
});

describe("resolveCommandPaletteToggle", () => {
  const notTerminalFocus: KeybindingWhenNode = {
    type: "not",
    node: { type: "identifier", name: "terminalFocus" },
  };
  const bindings: ResolvedKeybindingsConfig = [
    {
      command: "commandPalette.toggle" satisfies KeybindingCommand,
      shortcut: {
        key: "k",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: notTerminalFocus,
    },
  ];
  const context = { terminalFocus: false, terminalOpen: false, platform: "MacIntel" };

  it("toggles on the bound chord", () => {
    expect(resolveCommandPaletteToggle(keyEvent(), bindings, context)).toBe("toggle");
  });

  it("leaves mod+k to the terminal while it has focus", () => {
    expect(
      resolveCommandPaletteToggle(keyEvent(), bindings, { ...context, terminalFocus: true }),
    ).toBeNull();
  });

  it("swallows held auto-repeats", () => {
    expect(resolveCommandPaletteToggle(keyEvent({ repeat: true }), bindings, context)).toBe(
      "swallow",
    );
  });

  it("ignores handled events, other chords and keybinding capture fields", () => {
    expect(
      resolveCommandPaletteToggle(keyEvent({ defaultPrevented: true }), bindings, context),
    ).toBeNull();
    expect(resolveCommandPaletteToggle(keyEvent({ key: "j" }), bindings, context)).toBeNull();
    expect(
      resolveCommandPaletteToggle(
        keyEvent({ target: { closest: () => ({}) } as unknown as EventTarget }),
        bindings,
        context,
      ),
    ).toBeNull();
  });
});

describe("commandPaletteStore", () => {
  it("reports whether the palette is open", () => {
    useCommandPaletteStore.getState().setOpen(false);
    expect(isCommandPaletteOpen()).toBe(false);
    useCommandPaletteStore.getState().toggleOpen();
    expect(isCommandPaletteOpen()).toBe(true);
    useCommandPaletteStore.getState().setOpen(false);
  });
});
