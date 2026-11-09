import { create } from "zustand";
import type { ToolInputStream } from "./types";

/** One selected snapshot keeps a streaming edit reviewable after its transient preview expires. */
export const useToolDiffSelection = create<{
  selection: { threadId: string; toolId: string; stream: ToolInputStream } | null;
}>(() => ({ selection: null }));
