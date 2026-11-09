// @effect-diagnostics nodeBuiltinImport:off -- the test runs a real TLS h2 server to see which protocol is negotiated.
import * as NodeHttp2 from "node:http2";
import type * as NodeNet from "node:net";

import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  builtinFetchUsesHttp2,
  installHttp1FetchDispatcher,
  keepOutboundFetchOnHttp1,
} from "./outboundHttp.ts";

// Test-only self-signed P-256 certificate for 127.0.0.1; not a secret. A local server only offers
// h2 over ALPN, which needs TLS.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

// An h2-capable origin, like api.github.com, answering with the negotiated HTTP version.
const server = NodeHttp2.createSecureServer(
  { allowHTTP1: true, key: TEST_KEY, cert: TEST_CERT },
  (request, response) => response.end(request.httpVersion),
);
let origin = "";
const defaultDispatcher = Undici.getGlobalDispatcher();

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`;
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
});

afterEach(() => {
  Undici.setGlobalDispatcher(defaultDispatcher);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const negotiatedVersion = async () => (await Undici.request(origin)).body.text();

describe("installHttp1FetchDispatcher", () => {
  it("moves the global dispatcher off HTTP/2", async () => {
    // undici 8's default agent, the one Node 26's fetch uses.
    Undici.setGlobalDispatcher(new Undici.Agent());
    expect(await negotiatedVersion()).toBe("2.0");

    installHttp1FetchDispatcher();
    expect(await negotiatedVersion()).toBe("1.1");
  });

  it("keeps the proxy agent Node installs for --use-env-proxy", () => {
    Undici.setGlobalDispatcher(new Undici.EnvHttpProxyAgent());
    installHttp1FetchDispatcher();
    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
  });

  it("recognizes Node's own proxy agent by constructor name, as it is a different class", () => {
    class EnvHttpProxyAgent extends Undici.Agent {}
    Undici.setGlobalDispatcher(new EnvHttpProxyAgent());
    installHttp1FetchDispatcher();
    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
  });
});

// Only a runtime bundling undici 8 (Node 26+) offers h2 through fetch, so only there can this run.
it.runIf(builtinFetchUsesHttp2(process.versions.undici))(
  "moves the built-in fetch off HTTP/2",
  async () => {
    expect(await (await fetch(origin)).text()).toBe("2.0");
    installHttp1FetchDispatcher();
    expect(await (await fetch(origin)).text()).toBe("1.1");
  },
);

describe("keepOutboundFetchOnHttp1", () => {
  it("treats only a runtime bundling undici 8 or newer as using HTTP/2", () => {
    expect(builtinFetchUsesHttp2("8.0.0")).toBe(true);
    expect(builtinFetchUsesHttp2("9.1.0")).toBe(true);
    expect(builtinFetchUsesHttp2("7.24.4")).toBe(false);
    expect(builtinFetchUsesHttp2("6.21.0")).toBe(false);
    expect(builtinFetchUsesHttp2(undefined)).toBe(false);
    expect(builtinFetchUsesHttp2("")).toBe(false);
  });

  it("switches the dispatcher on Node 26", async () => {
    Undici.setGlobalDispatcher(new Undici.Agent());
    keepOutboundFetchOnHttp1("8.0.0");
    expect(await negotiatedVersion()).toBe("1.1");
  });

  it("leaves older runtimes and Electron untouched", () => {
    const dispatcher = new Undici.Agent();
    Undici.setGlobalDispatcher(dispatcher);
    keepOutboundFetchOnHttp1("7.24.4");
    expect(Undici.getGlobalDispatcher()).toBe(dispatcher);
  });
});
