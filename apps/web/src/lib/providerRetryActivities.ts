/** Matches `detail.kind` on the Claude adapter's retry warnings. */
const PROVIDER_RETRY_DETAIL_KIND = "provider_retry";

function providerRetryId(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): string | undefined {
  if (activity.kind !== "runtime.warning") return undefined;
  const detail = (activity.payload as { readonly detail?: unknown } | null)?.detail;
  if (typeof detail !== "object" || detail === null) return undefined;
  const { kind, retryId } = detail as { readonly kind?: unknown; readonly retryId?: unknown };
  return kind === PROVIDER_RETRY_DETAIL_KIND && typeof retryId === "string" ? retryId : undefined;
}

/**
 * One API retry streak persists one activity per attempt and one when it settles; the work log
 * shows only the latest, so the streak reads as a single updating row. Expects activities in order.
 */
export function dropSupersededProviderRetryActivities<
  Activity extends { readonly kind: string; readonly payload: unknown },
>(activities: ReadonlyArray<Activity>): ReadonlyArray<Activity> {
  const seenRetryIds = new Set<string>();
  let kept: Activity[] | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    const retryId = providerRetryId(activity);
    if (retryId === undefined) {
      kept?.push(activity);
    } else if (seenRetryIds.has(retryId)) {
      kept ??= activities.slice(index + 1).toReversed();
    } else {
      seenRetryIds.add(retryId);
      kept?.push(activity);
    }
  }
  return kept === null ? activities : kept.toReversed();
}
