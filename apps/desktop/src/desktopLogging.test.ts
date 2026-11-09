import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopLogging } from "./desktopLogging";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) dispose();
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "desktop-logging-"));
  const onBackendOutput = vi.fn();
  const logging = createDesktopLogging({ directory, onBackendOutput });
  disposals.push(() => rmSync(directory, { recursive: true, force: true }), logging.dispose);
  return { directory, logging, onBackendOutput };
}
function child() {
  const process = new ChildProcess();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  return process;
}

describe("desktop log ownership", () => {
  it("restores the exact stdio methods after repeated start and disposal", () => {
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    const { logging } = setup();
    logging.start();
    const capture = process.stdout.write;
    logging.start();
    expect(process.stdout.write).toBe(capture);
    expect(capture).not.toBe(stdout);
    logging.dispose();
    logging.dispose();
    expect(process.stdout.write).toBe(stdout);
    expect(process.stderr.write).toBe(stderr);
    expect(logging.isCapturing()).toBe(false);
  });

  it("captures backend output and releases listeners after the child closes", () => {
    const { directory, logging, onBackendOutput } = setup();
    logging.start();
    const backend = child();
    logging.captureBackendOutput(backend);
    backend.stdout!.emit("data", Buffer.from("hello"));
    expect(onBackendOutput).toHaveBeenCalledWith(Buffer.from("hello"));
    expect(readFileSync(join(directory, "server-child.log"), "utf8")).toBe("hello");
    backend.emit("close", 0);
    expect(backend.stdout!.listenerCount("data")).toBe(0);
    expect(backend.stderr!.listenerCount("data")).toBe(0);
    expect(backend.listenerCount("close")).toBe(0);
  });

  it("detaches running children on disposal without affecting other listeners", () => {
    const { logging, onBackendOutput } = setup();
    logging.start();
    const backend = child();
    const otherListener = vi.fn();
    backend.stdout!.on("data", otherListener);
    logging.captureBackendOutput(backend);
    logging.dispose();
    backend.stdout!.emit("data", Buffer.from("later"));
    expect(otherListener).toHaveBeenCalledOnce();
    expect(onBackendOutput).not.toHaveBeenCalled();
    expect(backend.listenerCount("close")).toBe(0);
  });
});
