import { describe, expect, it } from "vitest";

import { dropSupersededProviderRetryActivities } from "./providerRetryActivities";

const retry = (id: string, retryId: string) => ({
  id,
  kind: "runtime.warning",
  payload: { message: id, detail: { kind: "provider_retry", retryId, state: "retrying" } },
});
const other = (id: string, kind = "tool.completed") => ({ id, kind, payload: { detail: id } });

describe("dropSupersededProviderRetryActivities", () => {
  it("keeps only the latest activity of each retry streak", () => {
    const kept = dropSupersededProviderRetryActivities([
      other("before"),
      retry("attempt-1", "a"),
      retry("attempt-2", "a"),
      other("subagent", "task.progress"),
      retry("recovered", "a"),
      other("after"),
      retry("next-1", "b"),
    ]);
    expect(kept.map((activity) => activity.id)).toEqual([
      "before",
      "subagent",
      "recovered",
      "after",
      "next-1",
    ]);
  });

  it("returns the same array when nothing is superseded, keeping derivation caches valid", () => {
    const activities = [other("a"), retry("attempt-1", "a"), other("b")];
    expect(dropSupersededProviderRetryActivities(activities)).toBe(activities);
  });

  it("leaves other warnings alone", () => {
    const warning = { id: "w", kind: "runtime.warning", payload: { detail: { kind: "note" } } };
    const stringDetail = { id: "s", kind: "runtime.warning", payload: { detail: "text" } };
    const activities = [warning, stringDetail, { ...warning, id: "w2" }];
    expect(dropSupersededProviderRetryActivities(activities)).toBe(activities);
  });
});
