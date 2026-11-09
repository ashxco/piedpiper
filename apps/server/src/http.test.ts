import { describe, expect, it } from "vitest";

import {
  formatWebAccessUrl,
  imageResponseHeaders,
  isAllowedHostHeader,
  isAllowedOrigin,
  isLoopbackHostname,
  isUntracedRequest,
  isWildcardHost,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("isLoopbackHostname", () => {
  it("accepts localhost, 127.x and ::1 in their common spellings", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "app.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const host of [
      "",
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "evil.example",
      "localhost.evil.example",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});

describe("isAllowedOrigin", () => {
  it("allows loopback web origins and the desktop scheme", () => {
    expect(isAllowedOrigin("http://localhost:5733")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3773")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:3773")).toBe(true);
    expect(isAllowedOrigin("piedpiper://app")).toBe(true);
  });

  it("rejects foreign, null and non-http origins", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("file://")).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
    expect(isAllowedOrigin("http://localhost.evil.example")).toBe(false);
  });

  it("allows the explicit bind host so --host <ip> works from a browser", () => {
    expect(isAllowedOrigin("http://100.64.0.5:3773", "100.64.0.5")).toBe(true);
    expect(isAllowedOrigin("https://MY-BOX.example:3773", "my-box.example")).toBe(true);
    expect(isAllowedOrigin("http://[fd7a::1]:3773", "fd7a::1")).toBe(true);
    expect(isAllowedOrigin("http://100.64.0.6:3773", "100.64.0.5")).toBe(false);
    expect(isAllowedOrigin("https://evil.example", "100.64.0.5")).toBe(false);
    expect(isAllowedOrigin("null", "100.64.0.5")).toBe(false);
  });

  it("keeps a wildcard bind loopback-only", () => {
    expect(isAllowedOrigin("http://192.168.1.5:3773", "0.0.0.0")).toBe(false);
    expect(isAllowedOrigin("http://192.168.1.5:3773", "::")).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:3773", "0.0.0.0")).toBe(true);
  });
});

describe("isAllowedHostHeader", () => {
  it("always allows loopback hosts", () => {
    expect(isAllowedHostHeader("localhost:3773", "127.0.0.1")).toBe(true);
    expect(isAllowedHostHeader("127.0.0.1:3773", "127.0.0.1")).toBe(true);
    expect(isAllowedHostHeader("[::1]:3773", "127.0.0.1")).toBe(true);
  });

  it("allows the configured bind host and rejects anything else", () => {
    expect(isAllowedHostHeader("100.64.0.5:3773", "100.64.0.5")).toBe(true);
    expect(isAllowedHostHeader("[fd7a::1]:3773", "fd7a::1")).toBe(true);
    expect(isAllowedHostHeader("attacker.example:3773", "127.0.0.1")).toBe(false);
    expect(isAllowedHostHeader("100.64.0.6:3773", "100.64.0.5")).toBe(false);
    expect(isAllowedHostHeader("", "127.0.0.1")).toBe(false);
  });

  it("cannot enumerate a wildcard bind, so it skips the check", () => {
    expect(isAllowedHostHeader("my-box.tailnet.ts.net:3773", "0.0.0.0")).toBe(true);
    expect(isAllowedHostHeader("my-box.tailnet.ts.net:3773", undefined)).toBe(true);
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });
});

describe("imageResponseHeaders", () => {
  it("sandboxes SVG documents", () => {
    expect(imageResponseHeaders("/tmp/icon.SVG", "public, max-age=1")).toEqual({
      "Cache-Control": "public, max-age=1",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    });
  });

  it("sandboxes anything served as SVG or as a non-image type, whatever the suffix", () => {
    for (const filePath of ["/p/icon.svgz", "/p/index.html", "/p/icon.unknownext", "/p/icon"]) {
      expect(imageResponseHeaders(filePath, "no-store")["Content-Security-Policy"]).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
    }
  });

  it("does not apply a document policy to raster images", () => {
    expect(imageResponseHeaders("/tmp/icon.png", "public, max-age=1")).toEqual({
      "Cache-Control": "public, max-age=1",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });
  });
});

describe("isUntracedRequest", () => {
  it("skips tracing for routes and queries that may carry the auth token", () => {
    expect(isUntracedRequest({ url: "/ws?token=abc" })).toBe(true);
    expect(isUntracedRequest({ url: "/ws" })).toBe(true);
    expect(isUntracedRequest({ url: "/attachments/some-id" })).toBe(true);
    expect(isUntracedRequest({ url: "/api/project-favicon?cwd=%2Ftmp" })).toBe(true);
    expect(isUntracedRequest({ url: "/api/workspace-image?threadId=t&path=%2Fa.png" })).toBe(true);
    expect(isUntracedRequest({ url: "/?token=abc" })).toBe(true);
    expect(isUntracedRequest({ url: "/index.html?access_token=abc" })).toBe(true);
    expect(isUntracedRequest({ url: "/index.html?api_key=abc" })).toBe(true);
    expect(isUntracedRequest({ url: "/api/observability/v1/traces" })).toBe(true);
  });

  it("keeps tracing for ordinary requests", () => {
    expect(isUntracedRequest({ url: "/" })).toBe(false);
    expect(isUntracedRequest({ url: "/assets/app.js?v=3" })).toBe(false);
    expect(isUntracedRequest({ url: "/attachments-other" })).toBe(false);
  });
});

describe("formatWebAccessUrl", () => {
  it("builds the tokenized loopback URL for web mode only", () => {
    expect(
      formatWebAccessUrl({ mode: "web", host: "127.0.0.1", port: 3773, authToken: "a b" }),
    ).toBe("http://127.0.0.1:3773/?token=a%20b");
    expect(formatWebAccessUrl({ mode: "web", host: "0.0.0.0", port: 3773, authToken: "t" })).toBe(
      "http://127.0.0.1:3773/?token=t",
    );
    expect(formatWebAccessUrl({ mode: "web", host: "::1", port: 3773, authToken: "t" })).toBe(
      "http://[::1]:3773/?token=t",
    );
    expect(
      formatWebAccessUrl({ mode: "desktop", host: "127.0.0.1", port: 3773, authToken: "t" }),
    ).toBeUndefined();
    expect(
      formatWebAccessUrl({ mode: "web", host: "127.0.0.1", port: 3773, authToken: undefined }),
    ).toBeUndefined();
  });
});

describe("resolveDevRedirectUrl", () => {
  it("keeps the requested path and query (including the token)", () => {
    expect(
      resolveDevRedirectUrl(
        new URL("http://127.0.0.1:5173"),
        new URL("http://127.0.0.1:3774/pair?token=test-token"),
      ),
    ).toBe("http://127.0.0.1:5173/pair?token=test-token");
    expect(
      resolveDevRedirectUrl(
        new URL("http://127.0.0.1:5173/"),
        new URL("http://127.0.0.1:3774/thread/abc#token=t"),
      ),
    ).toBe("http://127.0.0.1:5173/thread/abc#token=t");
  });
});
