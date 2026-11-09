import { describe, expect, it } from "vitest";

import { parseRemoteUrl, remoteUrlIdentityKey } from "./remoteUrl.ts";

describe("remoteUrlIdentityKey", () => {
  it.each([
    "https://github.com/acme/app.git",
    "https://github.com/Acme/App",
    "https://github.com/acme/app.git/",
    "http://github.com/acme/app",
    "https://user:token@github.com/acme/app.git",
    "https://www.github.com/acme/app",
    "git@github.com:acme/app.git",
    "github.com:acme/app.git",
    "ssh://git@github.com/acme/app",
    "ssh://git@github.com:22/acme/app.git",
    "git+ssh://git@github.com/acme/app.git",
    "ssh://git@ssh.github.com:443/acme/app.git",
    "git://github.com:9418/acme/app.git",
  ])("treats %s as the same repository", (url) => {
    expect(remoteUrlIdentityKey(url)).toBe(remoteUrlIdentityKey("https://github.com/acme/app.git"));
  });

  it("tells other owners, repositories and hosts apart", () => {
    const key = remoteUrlIdentityKey("git@github.com:acme/app.git");
    expect(remoteUrlIdentityKey("git@github.com:octocat/app.git")).not.toBe(key);
    expect(remoteUrlIdentityKey("git@github.com:acme/other.git")).not.toBe(key);
    expect(remoteUrlIdentityKey("git@gitlab.example.com:acme/app.git")).not.toBe(key);
  });

  it("keeps non-default ports", () => {
    expect(remoteUrlIdentityKey("ssh://git@git.example.com:2222/acme/app.git")).not.toBe(
      remoteUrlIdentityKey("git@git.example.com:acme/app.git"),
    );
    expect(remoteUrlIdentityKey("https://git.example.com:8443/acme/app.git")).not.toBe(
      remoteUrlIdentityKey("https://git.example.com/acme/app.git"),
    );
    expect(remoteUrlIdentityKey("ssh://git@git.example.com:2222/acme/app.git")).toBe(
      remoteUrlIdentityKey("ssh://git@git.example.com:2222/acme/app"),
    );
    expect(remoteUrlIdentityKey("ssh://git@ssh.example.com:443/acme/app.git")).not.toBe(
      remoteUrlIdentityKey("git@ssh.example.com:acme/app.git"),
    );
  });

  it("keeps local paths distinct and verbatim", () => {
    expect(remoteUrlIdentityKey("/tmp/one/repo.git")).not.toBe(
      remoteUrlIdentityKey("/tmp/two/repo.git"),
    );
    expect(remoteUrlIdentityKey("/tmp/Repo")).not.toBe(remoteUrlIdentityKey("/tmp/repo"));
    expect(remoteUrlIdentityKey("/tmp/repo.git/")).toBe(remoteUrlIdentityKey("/tmp/repo"));
    expect(remoteUrlIdentityKey("C:\\work\\repo")).not.toBe(remoteUrlIdentityKey("D:\\work\\repo"));
    expect(remoteUrlIdentityKey("file:///tmp/repo.git")).not.toBe(
      remoteUrlIdentityKey("file:///tmp/other.git"),
    );
    expect(remoteUrlIdentityKey("github.com/acme/app")).not.toBe(
      remoteUrlIdentityKey("https://github.com/acme/app"),
    );
  });
});

describe("parseRemoteUrl", () => {
  it("reports only a non-default port", () => {
    expect(parseRemoteUrl("ssh://git@host.example:22/a/b")?.port).toBeNull();
    expect(parseRemoteUrl("https://host.example:443/a/b")?.port).toBeNull();
    expect(parseRemoteUrl("git@host.example:a/b")?.port).toBeNull();
    expect(parseRemoteUrl("ssh://git@host.example:2222/a/b")?.port).toBe("2222");
    expect(parseRemoteUrl("https://host.example:8443/a/b")?.port).toBe("8443");
  });

  it("rejects local paths", () => {
    expect(parseRemoteUrl("/tmp/repo.git")).toBeNull();
    expect(parseRemoteUrl("./repo")).toBeNull();
    expect(parseRemoteUrl("C:\\repo")).toBeNull();
    expect(parseRemoteUrl("file:///tmp/repo.git")).toBeNull();
    expect(parseRemoteUrl(null)).toBeNull();
  });
});
