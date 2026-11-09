import { ThreadId } from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../Services/ProviderSessionRuntime.ts";

const runtimeRepositoryLayer = it.layer(
  ProviderSessionRuntimeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

runtimeRepositoryLayer("ProviderSessionRuntimeRepository", (it) => {
  it.effect("skips undecodable rows instead of failing the whole list", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const lastSeenAt = "2026-03-24T00:00:00.000Z";

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES
          ('thread-bad-status', 'codex', 'codex', 'full-access', 'hibernating', ${lastSeenAt}, NULL, NULL),
          ('thread-bad-json', 'codex', 'codex', 'full-access', 'running', ${lastSeenAt}, '{not json', NULL)
      `;

      const validThreadId = ThreadId.makeUnsafe("thread-valid");
      yield* runtimes.upsert({
        threadId: validThreadId,
        providerName: "codex",
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt,
        resumeCursor: { threadId: "provider-thread-1" },
        runtimePayload: null,
      });

      const listed = yield* runtimes.list();
      assert.deepStrictEqual(
        listed.map((runtime) => runtime.threadId),
        [validThreadId],
      );
      assert.deepStrictEqual(listed[0]?.resumeCursor, { threadId: "provider-thread-1" });
    }),
  );
});
