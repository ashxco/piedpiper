import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach } from "vitest";

import { RotatingFileSink, makeAsyncRotatingFileSink, parseBackupIndex } from "./logging";

const tempRoots: Array<string> = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-shared-logging-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseBackupIndex", () => {
  it("accepts only canonical integer suffixes", () => {
    assert.strictEqual(parseBackupIndex("app.log.12", "app.log"), 12);
    assert.isUndefined(parseBackupIndex("app.log.0x20", "app.log"));
    assert.isUndefined(parseBackupIndex("app.log.1e3", "app.log"));
    assert.isUndefined(parseBackupIndex("app.log.012", "app.log"));
    assert.isUndefined(parseBackupIndex("app.log. 5", "app.log"));
    assert.isUndefined(parseBackupIndex("other.log.5", "app.log"));
  });
});

describe("RotatingFileSink prune", () => {
  it("keeps sibling files whose suffix only coerces to a number", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "desktop-main.log");
    for (const suffix of ["0x20", "1e3", "5"]) {
      fs.writeFileSync(`${logPath}.${suffix}`, "x");
    }

    const sink = new RotatingFileSink({ filePath: logPath, maxBytes: 100, maxFiles: 2 });
    assert.isDefined(sink);

    assert.isTrue(fs.existsSync(`${logPath}.0x20`));
    assert.isTrue(fs.existsSync(`${logPath}.1e3`));
    assert.isFalse(fs.existsSync(`${logPath}.5`));
  });
});

describe("makeAsyncRotatingFileSink", () => {
  it.effect("serializes concurrent appends across rotation and resumes an existing file", () =>
    Effect.gen(function* () {
      const dir = makeTempDir();
      const filePath = path.join(dir, "async.log");
      fs.writeFileSync(`${filePath}.50`, "obsolete");
      fs.writeFileSync(`${filePath}.0x20`, "unrelated");
      const lines = Array.from(
        { length: 100 },
        (_, index) => `${index.toString().padStart(3, "0")}\n`,
      );
      const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 32, maxFiles: 30 });
      yield* Effect.forEach(lines, (line) => sink.write(line), {
        concurrency: "unbounded",
        discard: true,
      });
      const resumed = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 32, maxFiles: 30 });
      yield* resumed.write("100\n");

      assert.isFalse(fs.existsSync(`${filePath}.50`));
      assert.isTrue(fs.existsSync(`${filePath}.0x20`));
      const backups = fs
        .readdirSync(dir)
        .map((name) => ({ name, index: parseBackupIndex(name, "async.log") }))
        .filter((entry): entry is { name: string; index: number } => entry.index !== undefined)
        .toSorted((left, right) => right.index - left.index)
        .map((entry) => entry.name);
      const contents = [...backups, "async.log"].map((name) =>
        fs.readFileSync(path.join(dir, name), "utf8"),
      );
      assert.isTrue(contents.every((chunk) => Buffer.byteLength(chunk) <= 32));
      assert.strictEqual(contents.join(""), lines.join("") + "100\n");
    }),
  );

  it.effect("keeps at most maxFiles backups", () =>
    Effect.gen(function* () {
      const dir = makeTempDir();
      const filePath = path.join(dir, "cap.log");
      const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 4, maxFiles: 2 });
      for (let index = 0; index < 6; index += 1) {
        yield* sink.write(`${index}${index}${index}\n`);
      }
      assert.deepStrictEqual(fs.readdirSync(dir).toSorted(), ["cap.log", "cap.log.1", "cap.log.2"]);
      assert.strictEqual(fs.readFileSync(filePath, "utf8"), "555\n");
      assert.strictEqual(fs.readFileSync(`${filePath}.2`, "utf8"), "333\n");
    }),
  );

  it.effect("reports a failed append and recovers on the next write", () =>
    Effect.gen(function* () {
      const dir = makeTempDir();
      const filePath = path.join(dir, "blocked.log");
      const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 64, maxFiles: 2 });
      // A directory where the file should be makes appends fail.
      fs.mkdirSync(filePath);
      const failed = yield* Effect.result(sink.write("lost\n"));
      assert.strictEqual(failed._tag, "Failure");
      fs.rmdirSync(filePath);
      yield* sink.write("kept\n");
      assert.strictEqual(fs.readFileSync(filePath, "utf8"), "kept\n");
    }),
  );

  it.effect("fails on invalid configuration", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        makeAsyncRotatingFileSink({
          filePath: path.join(makeTempDir(), "x.log"),
          maxBytes: 0,
          maxFiles: 1,
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
