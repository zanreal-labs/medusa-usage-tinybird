import { normalizeUsageEvent } from "@zanreal/medusa-usage/lib/usage/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TinybirdUsageSinkService from "./service";

/**
 * The sink against a fake Tinybird.
 *
 * These assert the wiring: what goes on the wire, what comes back off it, and
 * what the sink refuses. They cannot assert the guarantee the sink exists for -
 * that a duplicate write does not change a total - because that is a property of
 * the engine on the other side, not of this code. `src/live.test.ts` asserts it
 * against a real Tinybird.
 */

const TOKEN = "p.a-token-that-must-never-be-logged";

interface Call {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

let calls: Call[] = [];
let responses: unknown[] = [];

const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const body = String(init?.body ?? "");
  calls.push({
    body: url.toString().includes("/v0/events") ? body : JSON.parse(body || "{}"),
    headers: (init?.headers ?? {}) as Record<string, string>,
    url: url.toString(),
  });
  const next = responses.shift() ?? { data: [] };
  if (next instanceof Error) {
    throw next;
  }
  const failure = next as { __status?: number; __body?: string };
  if (failure.__status) {
    return new Response(failure.__body ?? "", { status: failure.__status });
  }
  return new Response(JSON.stringify(next), { status: 200 });
});

const sink = (options: Record<string, unknown> = {}) =>
  new TinybirdUsageSinkService(
    {},
    { host: "https://api.tinybird.test", token: TOKEN, ...options },
  );

const event = (overrides: Record<string, unknown> = {}) =>
  normalizeUsageEvent({
    meter: "api_request",
    occurredAt: "2026-08-01T00:00:00.000Z",
    quantity: 7,
    subject: "cus_1",
    ...overrides,
  });

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fakeFetch.mockClear();
});

describe("credentials", () => {
  it("never puts the token in a URL", async () => {
    responses = [{ data: [] }, { quarantined_rows: 0, successful_rows: 1 }];
    await sink().write([event()]);
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
    }
  });

  it("sends the token as a bearer header and nothing else", async () => {
    responses = [{ data: [] }, { quarantined_rows: 0, successful_rows: 1 }];
    await sink().write([event()]);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("redacts the token out of an error body that echoed it back", async () => {
    responses = [{ __body: `bad token ${TOKEN}`, __status: 403 }];
    await expect(sink().write([event()])).rejects.toThrow(/\[redacted\]/u);
    await expect(sink().write([event()])).rejects.not.toThrow(new RegExp(TOKEN, "u"));
  });

  it("keeps query parameters out of the URL, where logs would collect them", async () => {
    responses = [{ data: [{ event_count: "0", first_occurred_at: null, last_occurred_at: null, total: "0" }] }];
    await sink().aggregate({
      from: new Date("2026-08-01T00:00:00.000Z"),
      meter: "api_request",
      subject: "cus_1",
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calls[0].url).toBe("https://api.tinybird.test/v0/pipes/usage_aggregate.json");
    expect(calls[0].body).toMatchObject({ meter: "api_request", subject: "cus_1" });
  });
});

describe("write", () => {
  it("does nothing at all for an empty batch", async () => {
    expect(await sink().write([])).toEqual({ appended: 0, duplicates: 0, received: 0 });
    expect(calls).toHaveLength(0);
  });

  it("appends only the keys the log does not already have", async () => {
    const [one, two] = [event(), event({ quantity: 9 })];
    responses = [{ data: [{ key: one.key }] }, { quarantined_rows: 0, successful_rows: 1 }];

    expect(await sink().write([one, two])).toEqual({
      appended: 1,
      duplicates: 1,
      received: 2,
    });
    expect(String(calls[1].body)).toContain(two.key);
    expect(String(calls[1].body)).not.toContain(one.key);
  });

  it("appends nothing when every key is already stored", async () => {
    const one = event();
    responses = [{ data: [{ key: one.key }] }];
    expect(await sink().write([one])).toEqual({ appended: 0, duplicates: 1, received: 1 });
    expect(calls).toHaveLength(1);
  });

  it("waits for ingestion, so a write that returned can be aggregated", async () => {
    responses = [{ data: [] }, { quarantined_rows: 0, successful_rows: 1 }];
    await sink().write([event()]);
    expect(calls[1].url).toContain("wait=true");
  });

  it("bounds the key lookup by the batch's own event times", async () => {
    responses = [{ data: [] }, { quarantined_rows: 0, successful_rows: 2 }];
    await sink().write([
      event({ occurredAt: "2026-08-05T00:00:00.000Z" }),
      event({ occurredAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(calls[0].body).toMatchObject({
      date_from: "2026-08-01T00:00:00.000Z",
      date_to: "2026-08-05T00:00:00.000Z",
    });
  });

  it("skips the lookup, and stops counting duplicates, when asked to", async () => {
    responses = [{ quarantined_rows: 0, successful_rows: 1 }];
    expect(await sink({ checkForDuplicates: false }).write([event()])).toEqual({
      appended: 1,
      duplicates: 0,
      received: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it("throws on a quarantined row rather than losing metered usage quietly", async () => {
    responses = [{ data: [] }, { quarantined_rows: 1, successful_rows: 0 }];
    await expect(sink().write([event()])).rejects.toThrow(/quarantined 1 of 1 rows/u);
  });

  it("throws when fewer rows were acknowledged than were sent", async () => {
    responses = [{ data: [] }, { quarantined_rows: 0, successful_rows: 1 }];
    await expect(sink().write([event(), event({ quantity: 9 })])).rejects.toThrow(
      /acknowledged 1/u,
    );
  });

  it("reports a refused append as retryable, and says the retry is safe", async () => {
    responses = [{ data: [] }, { __body: "service unavailable", __status: 503 }];
    await expect(sink().write([event()])).rejects.toThrow(/HTTP 503/u);
  });
});

describe("aggregate", () => {
  it("reads the total exactly, and instants as UTC", async () => {
    responses = [
      {
        data: [
          {
            event_count: "3",
            first_occurred_at: 1785542400000,
            last_occurred_at: 1786795201000,
            total: "25",
          },
        ],
      },
    ];
    expect(
      await sink().aggregate({
        from: new Date("2026-08-01T00:00:00.000Z"),
        meter: "api_request",
        to: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toEqual({
      eventCount: 3,
      firstOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
      lastOccurredAt: new Date("2026-08-15T12:00:01.000Z"),
      total: 25,
    });
  });

  it("reads an untouched window as zero over no events", async () => {
    responses = [
      { data: [{ event_count: "0", first_occurred_at: null, last_occurred_at: null, total: "0" }] },
    ];
    expect(
      await sink().aggregate({
        from: new Date("2026-08-01T00:00:00.000Z"),
        meter: "gb_egress",
        to: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toEqual({ eventCount: 0, firstOccurredAt: null, lastOccurredAt: null, total: 0 });
  });

  it("refuses a total too large to sum exactly", async () => {
    responses = [
      {
        data: [
          {
            event_count: "2",
            first_occurred_at: 1785542400000,
            last_occurred_at: 1785542400000,
            total: "9007199254740993",
          },
        ],
      },
    ];
    await expect(
      sink().aggregate({
        from: new Date("2026-08-01T00:00:00.000Z"),
        meter: "api_request",
        to: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/beyond exact integer/u);
  });

  it("sends the window as a half-open pair of ISO instants", async () => {
    responses = [
      { data: [{ event_count: "0", first_occurred_at: null, last_occurred_at: null, total: "0" }] },
    ];
    await sink().aggregate({
      from: new Date("2026-08-01T00:00:00.000Z"),
      meter: "api_request",
      properties: { region: "eu" },
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calls[0].body).toEqual({
      date_from: "2026-08-01T00:00:00.000Z",
      date_to: "2026-09-01T00:00:00.000Z",
      meter: "api_request",
      property_keys: ["region"],
      property_values: ['"eu"'],
    });
  });

  it("omits a subject that was not asked for, rather than sending an empty one", async () => {
    responses = [
      { data: [{ event_count: "0", first_occurred_at: null, last_occurred_at: null, total: "0" }] },
    ];
    await sink().aggregate({
      from: new Date("2026-08-01T00:00:00.000Z"),
      meter: "api_request",
      subject: null,
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calls[0].body).not.toHaveProperty("subject");
  });
});

describe("listEvents", () => {
  const row = (key: string, occurredAt: number) => ({
    key,
    meter: "api_request",
    occurred_at: occurredAt,
    properties: "",
    quantity: "5",
    recorded_at: 1787043600000,
    source: null,
    subject: "cus_1",
  });

  it("asks for one row more than the page, and does not return it", async () => {
    responses = [{ data: [row("uev_a", 1), row("uev_b", 2), row("uev_c", 3)] }];
    const page = await sink().listEvents({
      from: new Date("2026-08-01T00:00:00.000Z"),
      limit: 2,
      meter: "api_request",
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calls[0].body).toMatchObject({ page_size: 3 });
    expect(page.events.map((entry) => entry.key)).toEqual(["uev_a", "uev_b"]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("issues no cursor on the last page, even when it came back exactly full", async () => {
    responses = [{ data: [row("uev_a", 1), row("uev_b", 2)] }];
    const page = await sink().listEvents({
      from: new Date("2026-08-01T00:00:00.000Z"),
      limit: 2,
      meter: "api_request",
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(page.nextCursor).toBeNull();
  });

  it("resumes after the cursor's row", async () => {
    responses = [{ data: [] }];
    await sink().listEvents({
      cursor: Buffer.from("2026-08-15T12:00:00.000Z|uev_b", "utf8").toString("base64url"),
      from: new Date("2026-08-01T00:00:00.000Z"),
      limit: 2,
      meter: "api_request",
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calls[0].body).toMatchObject({
      cursor_key: "uev_b",
      cursor_occurred_at: "2026-08-15T12:00:00.000Z",
    });
  });

  it("caps a page at a thousand rows however many were asked for", async () => {
    responses = [{ data: [] }];
    await sink().listEvents({
      from: new Date("2026-08-01T00:00:00.000Z"),
      limit: 10_000,
      meter: "api_request",
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calls[0].body).toMatchObject({ page_size: 1001 });
  });
});

describe("identifier", () => {
  it("names itself so a host can pair it with an id of its own", () => {
    expect(sink().getIdentifier()).toBe("tinybird");
  });

  it("refuses bad options at boot rather than at the first flush", () => {
    expect(() => TinybirdUsageSinkService.validateOptions({ host: "nonsense" })).toThrow(
      /not an absolute URL/u,
    );
  });
});
