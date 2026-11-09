interface RevertMessage {
  readonly id: string;
  readonly role: string;
  readonly turnId?: string | null;
  readonly createdAt: string;
}

/** Preserve systems and retained turns, filling legacy unlinked messages chronologically. */
export function retainThreadMessagesAfterRevert<T extends RevertMessage>(
  messages: ReadonlyArray<T>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): T[] {
  const retainedIds = new Set(
    messages
      .filter(
        (message) =>
          message.role === "system" ||
          (message.turnId != null && retainedTurnIds.has(message.turnId)),
      )
      .map((message) => message.id),
  );

  for (const role of ["user", "assistant"]) {
    const retainedCount = messages.filter(
      (message) => message.role === role && retainedIds.has(message.id),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    if (missingCount === 0) continue;

    const fallback = messages
      .filter(
        (message) =>
          message.role === role && !retainedIds.has(message.id) && message.turnId == null,
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingCount);
    for (const message of fallback) retainedIds.add(message.id);
  }

  return messages.filter((message) => retainedIds.has(message.id));
}

/** Activities and plans without a turn belong to the thread, so they survive a revert. */
export function retainThreadItemsAfterRevert<T extends { readonly turnId: string | null }>(
  items: ReadonlyArray<T>,
  retainedTurnIds: ReadonlySet<string>,
): T[] {
  return items.filter((item) => item.turnId === null || retainedTurnIds.has(item.turnId));
}
