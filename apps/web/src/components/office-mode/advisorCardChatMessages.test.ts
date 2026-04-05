import { MessageId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import {
  filterAckedAdvisorCardMessages,
  mergeAdvisorCardMessages,
} from "./advisorCardChatMessages";

function makeMessage(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "text">) {
  return {
    attachments: [],
    turnId: null,
    createdAt: "2026-04-12T20:00:00.000Z",
    streaming: false,
    ...partial,
  } satisfies ChatMessage;
}

describe("advisorCardChatMessages", () => {
  it("keeps a pending optimistic user message visible until the server echoes it", () => {
    const optimistic = makeMessage({
      id: MessageId.makeUnsafe("message-user"),
      role: "user",
      text: "hi",
      createdAt: "2026-04-12T20:00:00.000Z",
    });

    expect(mergeAdvisorCardMessages([], [optimistic])).toEqual([optimistic]);
    expect(filterAckedAdvisorCardMessages([optimistic], [])).toEqual([optimistic]);
  });

  it("drops the optimistic copy once the server copy arrives", () => {
    const echoed = makeMessage({
      id: MessageId.makeUnsafe("message-user"),
      role: "user",
      text: "hi",
      createdAt: "2026-04-12T20:00:00.000Z",
    });

    expect(mergeAdvisorCardMessages([echoed], [echoed])).toEqual([echoed]);
    expect(filterAckedAdvisorCardMessages([echoed], [echoed])).toEqual([]);
  });

  it("keeps chronological order when assistant output arrives before user reconciliation", () => {
    const optimisticUser = makeMessage({
      id: MessageId.makeUnsafe("message-user"),
      role: "user",
      text: "hi",
      createdAt: "2026-04-12T20:00:00.000Z",
    });
    const assistant = makeMessage({
      id: MessageId.makeUnsafe("message-assistant"),
      role: "assistant",
      text: "Hello.",
      createdAt: "2026-04-12T20:00:01.000Z",
    });

    expect(mergeAdvisorCardMessages([assistant], [optimisticUser])).toEqual([
      optimisticUser,
      assistant,
    ]);
  });
});
