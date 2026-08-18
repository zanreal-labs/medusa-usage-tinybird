import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGGREGATE_PIPE,
  DEFAULT_DATASOURCE,
  DEFAULT_LIST_PIPE,
  DEFAULT_PRESENT_PIPE,
  DEFAULT_TIMEOUT_MS,
  redactToken,
  resolveTinybirdOptions,
} from "./options";

const TOKEN = "p.a-token-that-must-never-be-logged";

const withEnv = (values: Record<string, string | undefined>): void => {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
};

afterEach(() => {
  withEnv({ TINYBIRD_HOST: undefined, TINYBIRD_TOKEN: undefined });
});

describe("resolveTinybirdOptions", () => {
  it("takes the host and token from options", () => {
    const resolved = resolveTinybirdOptions({ host: "https://data.zanreal.com", token: TOKEN });
    expect(resolved.host).toBe("https://data.zanreal.com");
    expect(resolved.token).toBe(TOKEN);
  });

  it("falls back to the environment", () => {
    withEnv({ TINYBIRD_HOST: "https://data.zanreal.com", TINYBIRD_TOKEN: TOKEN });
    const resolved = resolveTinybirdOptions();
    expect(resolved.host).toBe("https://data.zanreal.com");
    expect(resolved.token).toBe(TOKEN);
  });

  it("prefers an explicit option over the environment", () => {
    withEnv({ TINYBIRD_HOST: "https://from-the-environment.example", TINYBIRD_TOKEN: TOKEN });
    expect(resolveTinybirdOptions({ host: "https://from-the-options.example" }).host).toBe(
      "https://from-the-options.example",
    );
  });

  it("defaults every resource to the one the data project deploys", () => {
    const resolved = resolveTinybirdOptions({ host: "http://localhost:7181", token: TOKEN });
    expect(resolved.datasource).toBe(DEFAULT_DATASOURCE);
    expect(resolved.aggregatePipe).toBe(DEFAULT_AGGREGATE_PIPE);
    expect(resolved.listPipe).toBe(DEFAULT_LIST_PIPE);
    expect(resolved.presentPipe).toBe(DEFAULT_PRESENT_PIPE);
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolved.checkForDuplicates).toBe(true);
  });

  it("reduces the host to an origin, so a path cannot end up doubled", () => {
    expect(
      resolveTinybirdOptions({ host: "https://data.zanreal.com/v0/", token: TOKEN }).host,
    ).toBe("https://data.zanreal.com");
  });

  it("refuses a host with no scheme", () => {
    expect(() => resolveTinybirdOptions({ host: "data.zanreal.com", token: TOKEN })).toThrow(
      /not an absolute URL/u,
    );
  });

  it("refuses a host that is not http", () => {
    expect(() => resolveTinybirdOptions({ host: "ftp://data.zanreal.com", token: TOKEN })).toThrow(
      /not an http or https URL/u,
    );
  });

  it("refuses a missing host, and says what to set", () => {
    expect(() => resolveTinybirdOptions({ token: TOKEN })).toThrow(/TINYBIRD_HOST/u);
  });

  it("refuses a missing token, and says what the token needs to carry", () => {
    expect(() => resolveTinybirdOptions({ host: "http://localhost:7181" })).toThrow(
      /TINYBIRD_TOKEN[\s\S]*APPEND/u,
    );
  });

  it("never puts the token it rejected into the message", () => {
    // A blank token is still a token someone typed. Whatever the message says,
    // it must not be the credential.
    withEnv({ TINYBIRD_TOKEN: "   " });
    try {
      resolveTinybirdOptions({ host: "http://localhost:7181", token: `${TOKEN}\n` });
      expect.unreachable("a blank token should be refused");
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("refuses a resource name that would have to be escaped into a URL", () => {
    expect(() =>
      resolveTinybirdOptions({
        datasource: "usage events; drop",
        host: "http://localhost:7181",
        token: TOKEN,
      }),
    ).toThrow(/not a Tinybird resource name/u);
  });

  it("refuses a timeout that is not a whole number of milliseconds", () => {
    expect(() =>
      resolveTinybirdOptions({ host: "http://localhost:7181", timeoutMs: 0, token: TOKEN }),
    ).toThrow(/timeoutMs/u);
  });

  it("takes checkForDuplicates off when asked", () => {
    expect(
      resolveTinybirdOptions({
        checkForDuplicates: false,
        host: "http://localhost:7181",
        token: TOKEN,
      }).checkForDuplicates,
    ).toBe(false);
  });
});

describe("redactToken", () => {
  it("replaces the token wherever a response echoed it back", () => {
    expect(redactToken(`auth failed for ${TOKEN} on /v0/events`, TOKEN)).toBe(
      "auth failed for [redacted] on /v0/events",
    );
  });

  it("replaces every occurrence, not just the first", () => {
    expect(redactToken(`${TOKEN} ${TOKEN}`, TOKEN)).toBe("[redacted] [redacted]");
  });

  it("leaves a message alone when there is nothing to redact", () => {
    expect(redactToken("connection refused", TOKEN)).toBe("connection refused");
  });
});
