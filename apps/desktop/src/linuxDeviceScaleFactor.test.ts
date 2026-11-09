import { describe, expect, it } from "vitest";

import {
  LINUX_DEVICE_SCALE_FACTOR_SWITCH,
  isValidDeviceScaleFactor,
  restoreLinuxDeviceScaleFactor,
} from "./linuxDeviceScaleFactor";

const STATE_PATH = "/state/linux-device-scale-factor";

function createHarness(options: {
  switchValue?: string;
  files?: Record<string, string>;
  readFails?: boolean;
  writeFails?: boolean;
}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const applied: Array<[string, string]> = [];
  const reads: string[] = [];
  restoreLinuxDeviceScaleFactor({
    statePath: STATE_PATH,
    commandLine: {
      hasSwitch: (name) =>
        name === LINUX_DEVICE_SCALE_FACTOR_SWITCH && options.switchValue !== undefined,
      getSwitchValue: () => options.switchValue ?? "",
      appendSwitch: (name, value) => applied.push([name, value]),
    },
    readFile: (path) => {
      reads.push(path);
      if (options.readFails) throw new Error("EACCES");
      const contents = files.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    },
    writeFile: (path, value) => {
      if (options.writeFails) throw new Error("EROFS");
      files.set(path, value);
    },
  });
  return { files, applied, reads };
}

describe("isValidDeviceScaleFactor", () => {
  it.each(["1", "1.5", " 2 "])("accepts %j", (value) => {
    expect(isValidDeviceScaleFactor(value)).toBe(true);
  });

  it.each(["", "0", "-1", "Infinity", "NaN", "garbage"])("rejects %j", (value) => {
    expect(isValidDeviceScaleFactor(value)).toBe(false);
  });
});

describe("restoreLinuxDeviceScaleFactor", () => {
  it("saves an explicit scale without re-applying it", () => {
    const { files, applied, reads } = createHarness({ switchValue: "1.5" });
    expect(files.get(STATE_PATH)).toBe("1.5");
    expect(applied).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("re-applies the saved scale when the switch is absent", () => {
    const { applied } = createHarness({ files: { [STATE_PATH]: "1.75\n" } });
    expect(applied).toEqual([[LINUX_DEVICE_SCALE_FACTOR_SWITCH, "1.75"]]);
  });

  it("ignores an invalid explicit scale and keeps the saved one", () => {
    const { files, applied } = createHarness({
      switchValue: "0",
      files: { [STATE_PATH]: "2" },
    });
    expect(files.get(STATE_PATH)).toBe("2");
    expect(applied).toEqual([]);
  });

  it.each(["0", "Infinity", "garbage"])("ignores invalid saved scale %j", (value) => {
    const { applied } = createHarness({ files: { [STATE_PATH]: value } });
    expect(applied).toEqual([]);
  });

  it("keeps default scaling when there is no saved state", () => {
    const { applied } = createHarness({});
    expect(applied).toEqual([]);
  });

  it("swallows read and write failures", () => {
    expect(createHarness({ readFails: true }).applied).toEqual([]);
    expect(createHarness({ switchValue: "1.25", writeFails: true }).applied).toEqual([]);
  });
});
