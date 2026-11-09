import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createThemeSourceController,
  type GdbusProcess,
  type LinuxColorScheme,
  parseColorSchemeReply,
  parseColorSchemeSignal,
  resolveThemeSource,
  watchLinuxColorScheme,
} from "./linuxColorScheme";

const signalLine = (namespace: string, key: string, value: number) =>
  `/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('${namespace}', '${key}', <uint32 ${value}>)\n`;
const colorSchemeSignal = (value: number) =>
  signalLine("org.freedesktop.appearance", "color-scheme", value);

class FakeGdbus extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly kill = vi.fn();
  write(text: string) {
    this.stdout.emit("data", Buffer.from(text));
  }
  finish(code: number) {
    this.emit("close", code);
  }
}

function fakeBus() {
  const processes: Array<{ args: ReadonlyArray<string>; process: FakeGdbus }> = [];
  const spawnGdbus = (args: ReadonlyArray<string>) => {
    const process = new FakeGdbus();
    processes.push({ args, process });
    return process as unknown as GdbusProcess;
  };
  const named = (subcommand: string, method?: string) => {
    const match = processes.find(
      ({ args }) => args[0] === subcommand && (!method || args.some((arg) => arg.endsWith(method))),
    );
    if (!match) throw new Error(`gdbus ${subcommand} ${method ?? ""} was not spawned`);
    return match.process;
  };
  return { processes, spawnGdbus, named };
}

describe("parsing gdbus output", () => {
  it("treats 0 and 2 as light and 1 as dark", () => {
    expect(parseColorSchemeReply("(<uint32 0>,)\n")).toBe("light");
    expect(parseColorSchemeReply("(<uint32 1>,)\n")).toBe("dark");
    expect(parseColorSchemeReply("(<uint32 2>,)\n")).toBe("light");
  });

  it("reads the doubly nested value from the deprecated Read method", () => {
    expect(parseColorSchemeReply("(<<uint32 1>>,)\n")).toBe("dark");
  });

  it("reports an unknown value as no scheme and junk as nothing", () => {
    expect(parseColorSchemeReply("(<uint32 7>,)\n")).toBeNull();
    expect(parseColorSchemeReply("not a reply")).toBeUndefined();
  });

  it("only accepts the appearance color scheme signal", () => {
    expect(parseColorSchemeSignal(colorSchemeSignal(1))).toBe("dark");
    expect(parseColorSchemeSignal(signalLine("org.gnome.desktop.a11y", "x", 1))).toBeUndefined();
    expect(
      parseColorSchemeSignal(signalLine("org.freedesktop.appearance", "accent-color", 1)),
    ).toBeUndefined();
    expect(
      parseColorSchemeSignal(
        "Monitoring signals on object /org/freedesktop/portal/desktop owned by org.freedesktop.portal.Desktop",
      ),
    ).toBeUndefined();
  });
});

describe("watchLinuxColorScheme", () => {
  it("reports the initial scheme and later changes", () => {
    const bus = fakeBus();
    const schemes: LinuxColorScheme[] = [];
    watchLinuxColorScheme((scheme) => schemes.push(scheme), bus.spawnGdbus);

    const read = bus.named("call", "ReadOne");
    read.write("(<uint32 1>,)\n");
    read.finish(0);
    bus.named("monitor").write(colorSchemeSignal(0));

    expect(schemes).toEqual(["dark", "light"]);
  });

  it("joins a signal split across stdout chunks", () => {
    const bus = fakeBus();
    const schemes: LinuxColorScheme[] = [];
    watchLinuxColorScheme((scheme) => schemes.push(scheme), bus.spawnGdbus);

    const line = colorSchemeSignal(1);
    bus.named("monitor").write(line.slice(0, 20));
    expect(schemes).toEqual([]);
    bus.named("monitor").write(line.slice(20));
    expect(schemes).toEqual(["dark"]);
  });

  it("falls back to Read when the portal rejects ReadOne", () => {
    const bus = fakeBus();
    const schemes: LinuxColorScheme[] = [];
    watchLinuxColorScheme((scheme) => schemes.push(scheme), bus.spawnGdbus);

    bus.named("call", "ReadOne").finish(1);
    const fallback = bus.named("call", ".Read");
    fallback.write("(<<uint32 1>>,)\n");
    fallback.finish(0);

    expect(schemes).toEqual(["dark"]);
  });

  it("ignores a read reply that a change signal overtook", () => {
    const bus = fakeBus();
    const schemes: LinuxColorScheme[] = [];
    watchLinuxColorScheme((scheme) => schemes.push(scheme), bus.spawnGdbus);

    bus.named("monitor").write(colorSchemeSignal(1));
    const read = bus.named("call", "ReadOne");
    read.write("(<uint32 0>,)\n");
    read.finish(0);

    expect(schemes).toEqual(["dark"]);
  });

  it("stays silent and does not retry when gdbus is not installed", () => {
    const bus = fakeBus();
    const onChange = vi.fn();
    watchLinuxColorScheme(onChange, bus.spawnGdbus);

    const missing = Object.assign(new Error("spawn gdbus ENOENT"), { code: "ENOENT" });
    bus.named("monitor").emit("error", missing);
    const read = bus.named("call", "ReadOne");
    read.emit("error", missing);
    read.finish(-2);

    expect(onChange).not.toHaveBeenCalled();
    expect(bus.processes).toHaveLength(2);
  });

  it("stays silent when spawning gdbus throws instead of emitting an error", () => {
    const onChange = vi.fn();
    const spawnGdbus = vi.fn((): GdbusProcess => {
      throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
    });

    const watcher = watchLinuxColorScheme(onChange, spawnGdbus);
    watcher.stop();

    expect(spawnGdbus).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("survives the Read fallback throwing from the close handler", () => {
    const bus = fakeBus();
    let spawned = 0;
    const watcher = watchLinuxColorScheme(vi.fn(), (args) => {
      spawned += 1;
      if (spawned > 2) throw new Error("spawn ENOMEM");
      return bus.spawnGdbus(args);
    });

    expect(() => bus.named("call", "ReadOne").finish(1)).not.toThrow();
    watcher.stop();
    expect(spawned).toBe(3);
  });

  it("kills a pending read on stop and does not fall back after it", () => {
    const bus = fakeBus();
    const watcher = watchLinuxColorScheme(vi.fn(), bus.spawnGdbus);
    const read = bus.named("call", "ReadOne");

    watcher.stop();
    expect(read.kill).toHaveBeenCalledTimes(1);
    read.finish(1);

    expect(bus.processes).toHaveLength(2);
  });

  it("does not kill a read that already finished", () => {
    const bus = fakeBus();
    const watcher = watchLinuxColorScheme(vi.fn(), bus.spawnGdbus);
    const read = bus.named("call", "ReadOne");
    read.write("(<uint32 1>,)\n");
    read.finish(0);

    watcher.stop();
    expect(read.kill).not.toHaveBeenCalled();
  });

  it("stops the monitor once and ignores anything after stopping", () => {
    const bus = fakeBus();
    const onChange = vi.fn();
    const watcher = watchLinuxColorScheme(onChange, bus.spawnGdbus);

    watcher.stop();
    watcher.stop();
    bus.named("monitor").write(colorSchemeSignal(1));
    const read = bus.named("call", "ReadOne");
    read.write("(<uint32 1>,)\n");
    read.finish(0);

    expect(bus.named("monitor").kill).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});

let emit: (scheme: LinuxColorScheme) => void = () => undefined;

describe("theme source precedence", () => {
  it("lets explicit choices win over the portal", () => {
    expect(resolveThemeSource("light", "dark")).toBe("light");
    expect(resolveThemeSource("dark", "light")).toBe("dark");
    expect(resolveThemeSource("system", "dark")).toBe("dark");
    expect(resolveThemeSource("system", null)).toBe("system");
  });

  it("follows the portal only while the source is system", () => {
    const applied: string[] = [];

    const stop = vi.fn();
    const controller = createThemeSourceController(
      (theme) => applied.push(theme),
      (onChange) => {
        emit = onChange;
        return { stop };
      },
    );

    controller.startFollowingLinuxPortal();
    emit("dark");
    controller.setSource("light");
    emit("light");
    emit("dark");
    controller.setSource("system");
    controller.stop();

    expect(applied).toEqual(["dark", "light", "light", "light", "dark"]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("passes choices straight through when the portal is not followed", () => {
    const applied: string[] = [];
    const watch = vi.fn();
    const controller = createThemeSourceController((theme) => applied.push(theme), watch);

    controller.setSource("dark");
    controller.setSource("system");
    controller.stop();

    expect(applied).toEqual(["dark", "system"]);
    expect(watch).not.toHaveBeenCalled();
  });
});
