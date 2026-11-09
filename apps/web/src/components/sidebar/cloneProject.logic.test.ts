import { describe, expect, it, vi } from "vitest";

import {
  type CloneRepository,
  type CloneToast,
  describeCloneError,
  describeCloneProgress,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getCloneParentDirectory,
  isCloneUrl,
  runCloneProject,
} from "./cloneProject.logic";

describe("isCloneUrl", () => {
  it("accepts the remote forms git reads", () => {
    for (const url of [
      "https://github.com/acme/repo.git",
      "http://x.dev/r",
      "ssh://git@x.dev:22/a/b",
      "git://x.dev/a/b",
      "file:///srv/a.git",
      "git@github.com:acme/repo.git",
      "  https://x.dev/r  ",
    ]) {
      expect(isCloneUrl(url)).toBe(true);
    }
  });

  it("refuses paths, options and other text", () => {
    for (const url of [
      "",
      "/path/to/repo",
      "repo",
      "--upload-pack=x",
      "-x@host:path",
      "ext::sh -c x",
      "https://x.dev/a b",
      "ftp://x.dev/a",
    ]) {
      expect(isCloneUrl(url)).toBe(false);
    }
  });
});

describe("getCloneDirectoryName", () => {
  it("takes the last segment without .git", () => {
    expect(getCloneDirectoryName("https://github.com/acme/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/acme/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/acme/repo.git/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:acme/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@x.dev:22/acme/repo")).toBe("repo");
    expect(getCloneDirectoryName("file:///srv/repo.git")).toBe("repo");
  });

  it("ignores a query, a fragment and credentials", () => {
    expect(getCloneDirectoryName("https://x.dev/a/repo.git?token=abc")).toBe("repo");
    expect(getCloneDirectoryName("https://x.dev/a/repo#readme")).toBe("repo");
    expect(getCloneDirectoryName("https://me:tok@x.dev/a/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://me:tok@x.dev")).toBe("");
    expect(getCloneDirectoryName("https://tok@x.dev:8443")).toBe("");
  });

  it("keeps a numeric repository but not a host or a port", () => {
    expect(getCloneDirectoryName("https://x.dev/acme/123")).toBe("123");
    expect(getCloneDirectoryName("https://x.dev")).toBe("");
    expect(getCloneDirectoryName("https://x.dev:8443")).toBe("");
    expect(getCloneDirectoryName("https://x.dev:8443/")).toBe("");
  });

  it("refuses names that would escape the folder", () => {
    expect(getCloneDirectoryName("https://x.dev/a/..")).toBe("");
    expect(getCloneDirectoryName("https://x.dev/a/.")).toBe("");
    expect(getCloneDirectoryName("https://x.dev/a/...git")).toBe("");
  });
});

describe("getCloneDestinationPath", () => {
  it("joins with the folder's own separator", () => {
    expect(getCloneDestinationPath("/code", "repo")).toBe("/code/repo");
    expect(getCloneDestinationPath("/code/", "repo")).toBe("/code/repo");
    expect(getCloneDestinationPath("~", "repo")).toBe("~/repo");
    expect(getCloneDestinationPath("C:\\code", "repo")).toBe("C:\\code\\repo");
    expect(getCloneDestinationPath("C:\\", "repo")).toBe("C:\\repo");
  });

  it("is empty until there is both a folder and a name", () => {
    expect(getCloneDestinationPath("", "repo")).toBe("");
    expect(getCloneDestinationPath("/code", "")).toBe("");
  });
});

describe("getCloneParentDirectory", () => {
  it("is the parent of the project, or the home folder without one", () => {
    expect(getCloneParentDirectory("/code/app")).toBe("/code");
    expect(getCloneParentDirectory("/code/app/")).toBe("/code");
    expect(getCloneParentDirectory("C:\\code\\app")).toBe("C:\\code");
    expect(getCloneParentDirectory(null)).toBe("~");
    expect(getCloneParentDirectory(undefined)).toBe("~");
    expect(getCloneParentDirectory("")).toBe("~");
  });

  it("keeps the separator on a root", () => {
    expect(getCloneParentDirectory("/app")).toBe("/");
    expect(getCloneParentDirectory("C:\\app")).toBe("C:\\");
  });
});

describe("describeCloneProgress", () => {
  it("names the stage with whatever numbers it has", () => {
    expect(describeCloneProgress({ stage: "connecting", percent: null, detail: null })).toBe(
      "Connecting",
    );
    expect(describeCloneProgress({ stage: "receiving", percent: 42, detail: "1 MiB" })).toBe(
      "Receiving objects 42% (1 MiB)",
    );
  });
});

describe("describeCloneError", () => {
  it("prefers git's detail over the wrapped message", () => {
    expect(describeCloneError({ detail: "fatal: nope", message: "Git command failed" })).toBe(
      "fatal: nope",
    );
    expect(describeCloneError(new Error("socket closed"))).toBe("socket closed");
    expect(describeCloneError(null)).toBe("The repository could not be cloned.");
  });
});

const noop = () => {};

describe("runCloneProject", () => {
  const makeToast = () => {
    const calls: Array<string> = [];
    let cancel: () => void = noop;
    const toast: CloneToast = {
      loading: ({ title, onCancel }) => {
        cancel = onCancel;
        calls.push(`loading:${title}`);
      },
      progress: (description) => calls.push(`progress:${description}`),
      succeeded: (title) => calls.push(`succeeded:${title}`),
      failed: (title, description) => calls.push(`failed:${title}:${description}`),
      cancelled: (title) => calls.push(`cancelled:${title}`),
    };
    return { calls, toast, cancel: () => cancel() };
  };
  const base = { url: " https://me:tok@x.dev/a/repo.git ", destinationPath: " ~/code/repo " };

  it("adds the project only after the clone finished, at the server's path", async () => {
    const { calls, toast } = makeToast();
    const addProject = vi.fn(async (_path: string) => {
      calls.push("added");
    });
    const cloneRepository: CloneRepository = async (input, options) => {
      expect(input).toEqual({
        url: "https://me:tok@x.dev/a/repo.git",
        destinationPath: "~/code/repo",
      });
      options?.onProgress?.({ stage: "receiving", percent: 10, detail: null });
      expect(addProject).not.toHaveBeenCalled();
      return { destinationPath: "/home/me/code/repo" };
    };
    await expect(runCloneProject({ ...base, cloneRepository, addProject, toast })).resolves.toBe(
      "cloned",
    );
    expect(addProject).toHaveBeenCalledWith("/home/me/code/repo");
    expect(calls).toEqual([
      "loading:Cloning repo",
      "progress:Receiving objects 10%",
      "progress:Adding project",
      "added",
      "succeeded:Cloned repo",
    ]);
  });

  it("reports an add that failed after the clone and never claims success", async () => {
    const { calls, toast } = makeToast();
    const outcome = await runCloneProject({
      ...base,
      cloneRepository: async () => ({ destinationPath: "/home/me/code/repo" }),
      addProject: async () => {
        throw new Error("server down");
      },
      toast,
    });
    expect(outcome).toBe("add-failed");
    expect(calls.at(-1)).toBe(
      "failed:Cloned repo, but could not add it as a project:server down The repository is in /home/me/code/repo.",
    );
    expect(calls.join(" ")).not.toContain("succeeded");
  });

  it("adds nothing when the clone fails, and shows git's words", async () => {
    const { calls, toast } = makeToast();
    const addProject = vi.fn(async () => {});
    const outcome = await runCloneProject({
      ...base,
      cloneRepository: async () => {
        throw { detail: "fatal: not found", message: "wrapped" };
      },
      addProject,
      toast,
    });
    expect(outcome).toBe("failed");
    expect(addProject).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe("failed:Could not clone repo:fatal: not found");
  });

  it("aborts from the toast's cancel and reports it as cancelled, not failed", async () => {
    const { calls, toast, cancel } = makeToast();
    const addProject = vi.fn(async () => {});
    const outcome = await runCloneProject({
      ...base,
      cloneRepository: (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("interrupted")));
          cancel();
        }),
      addProject,
      toast,
    });
    expect(outcome).toBe("cancelled");
    expect(addProject).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe("cancelled:Cancelled cloning repo");
  });

  it("never shows the URL or its credentials in a toast", async () => {
    const { calls, toast } = makeToast();
    await runCloneProject({
      url: "https://me:tok@x.dev",
      destinationPath: "/code/folder",
      cloneRepository: async () => ({ destinationPath: "/code/folder" }),
      addProject: async () => {},
      toast,
    });
    expect(calls[0]).toBe("loading:Cloning folder");
    expect(calls.join(" ")).not.toContain("tok");
  });
});
