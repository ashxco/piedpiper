import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  readUpdateInstallRecord,
  removeUpdateInstallRecord,
  writeUpdateInstallRecord,
} from "./updateInstallRecord";

describe("update install record", () => {
  let directory: string;
  let filePath: string;
  const record = { fromVersion: "1.0.0", targetVersion: "1.1.0" };

  beforeEach(() => {
    directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "update-install-record-"));
    filePath = Path.join(directory, "nested", DESKTOP_UPDATE_INSTALL_RECORD_FILE);
  });

  afterEach(() => {
    FS.rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips through the file, creating its directory", () => {
    writeUpdateInstallRecord(filePath, record);
    expect(readUpdateInstallRecord(filePath)).toEqual(record);
  });

  it("reads nothing when the record is missing", () => {
    expect(readUpdateInstallRecord(filePath)).toBeNull();
  });

  it.each(["not json", "null", '{"fromVersion":"1.0.0"}', '{"fromVersion":1,"targetVersion":2}'])(
    "ignores the malformed record %s",
    (contents) => {
      FS.mkdirSync(Path.dirname(filePath), { recursive: true });
      FS.writeFileSync(filePath, contents);
      expect(readUpdateInstallRecord(filePath)).toBeNull();
    },
  );

  it("removes the record and tolerates it being gone already", () => {
    writeUpdateInstallRecord(filePath, record);
    removeUpdateInstallRecord(filePath);
    removeUpdateInstallRecord(filePath);
    expect(readUpdateInstallRecord(filePath)).toBeNull();
  });

  it("never throws when the record cannot be written", () => {
    const blocker = Path.join(directory, "blocker");
    FS.writeFileSync(blocker, "");
    expect(() => writeUpdateInstallRecord(Path.join(blocker, "record.json"), record)).not.toThrow();
  });
});
