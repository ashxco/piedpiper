import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/advisors")({
  validateSearch: (search: Record<string, unknown>) => ({
    advisor: typeof search.advisor === "string" ? search.advisor : undefined,
  }),
});
