import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/panels/ArchivedThreadsPanel";

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedThreadsPanel,
});
