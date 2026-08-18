import { normalizeUsageEvent } from "@zanreal/medusa-usage/lib/usage/event";
import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  exactInteger,
  fromPropertyText,
  toNdjson,
  toPropertyFilter,
  toPropertyText,
  toRow,
  toStoredEvent,
} from "./encoding";

const event = (overrides: Record<string, unknown> = {}) =>
  normalizeUsageEvent({
    meter: "api_request",
    occurredAt: "2026-08-01T00:00:00.000Z",
    quantity: 7,
    subject: "cus_1",
    ...overrides,
  });

describe("toRow", () => {
  it("sends event time as an ISO instant with an offset", () => {
    expect(toRow(event()).occurred_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("sends no recorded_at and no version", () => {
    // Both are Tinybird's to assign. One clock has to decide which write of a
    // key arrived first, or a fleet with skewed clocks would disagree about it.
    const row = toRow(event()) as Record<string, unknown>;
    expect(row).not.toHaveProperty("recorded_at");
    expect(row).not.toHaveProperty("version");
  });

  it("sends a null source as null rather than as an empty string", () => {
    expect(toRow(event()).source).toBeNull();
    expect(toRow(event({ source: "gateway" })).source).toBe("gateway");
  });

  it("writes one line per event, with no trailing newline", () => {
    const body = toNdjson([event(), event({ quantity: 9 })]);
    expect(body.split("\n")).toHaveLength(2);
    expect(body.endsWith("\n")).toBe(false);
  });
});

describe("property bags", () => {
  it("stores the bag as canonical JSON, keys sorted and no whitespace", () => {
    // The same text the plugin hashes into the deduplication key, from the same
    // function, so the bag that was keyed and the bag that was stored agree.
    expect(toPropertyText({ tier: 2, region: "eu", live: true, missing: null })).toBe(
      '{"live":true,"missing":null,"region":"eu","tier":2}',
    );
  });

  it("round-trips a bag through the stored text unchanged", () => {
    const properties = { deep: { b: [1, 2], a: "x" }, region: "eu", tier: 2 };
    expect(fromPropertyText(toPropertyText(properties))).toEqual(properties);
  });

  it("reads the empty string back as no properties", () => {
    // An empty bag and no bag describe the same event; the plugin collapses one
    // into the other before an event is keyed, so nothing is lost either way.
    expect(toPropertyText(null)).toBe("");
    expect(fromPropertyText("")).toBeNull();
  });

  it("refuses a stored bag that is not JSON", () => {
    expect(() => fromPropertyText("region=eu")).toThrow(/not JSON/u);
  });

  it("encodes a filter as two positional arrays", () => {
    expect(toPropertyFilter({ region: "eu", tier: 2 })).toEqual({
      property_keys: ["region", "tier"],
      property_values: ['"eu"', "2"],
    });
  });

  it("treats an absent or empty filter as no filter", () => {
    expect(toPropertyFilter(null)).toBeNull();
    expect(toPropertyFilter(undefined)).toBeNull();
    expect(toPropertyFilter({})).toBeNull();
  });

  it("distinguishes the number 2 from the string 2, as jsonb containment does", () => {
    expect(toPropertyFilter({ tier: 2 })?.property_values).toEqual(["2"]);
    expect(toPropertyFilter({ tier: "2" })?.property_values).toEqual(['"2"']);
  });
});

describe("exactInteger", () => {
  it("parses an Int64 that arrived as text", () => {
    expect(exactInteger("9007199254740991", "the total")).toBe(Number.MAX_SAFE_INTEGER);
    expect(exactInteger("-5", "the total")).toBe(-5);
  });

  it("refuses a value beyond exact integer arithmetic rather than rounding it", () => {
    expect(() => exactInteger("9007199254740993", "the total")).toThrow(/beyond exact integer/u);
    expect(() => exactInteger("-9007199254740993", "the total")).toThrow(/beyond exact integer/u);
  });

  it("refuses something that is not an integer at all", () => {
    expect(() => exactInteger("1.5", "the total")).toThrow(/not an integer/u);
  });
});

describe("cursors", () => {
  it("round-trips an instant and a key", () => {
    const occurredAt = new Date("2026-08-15T12:00:00.000Z");
    const decoded = decodeCursor(encodeCursor(occurredAt, "uev_abc"));
    expect(decoded?.occurredAt.toISOString()).toBe("2026-08-15T12:00:00.000Z");
    expect(decoded?.key).toBe("uev_abc");
  });

  it("uses the encoding the built-in Postgres sink issues", () => {
    // `<iso>|<key>` in base64url. Matching it means a page taken from one sink
    // can be resumed against the other rather than silently restarting.
    const cursor = encodeCursor(new Date("2026-08-15T12:00:00.000Z"), "uev_abc");
    expect(Buffer.from(cursor, "base64url").toString("utf8")).toBe(
      "2026-08-15T12:00:00.000Z|uev_abc",
    );
  });

  it("treats no cursor as the first page", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("refuses a cursor it did not issue", () => {
    expect(() => decodeCursor(Buffer.from("nonsense", "utf8").toString("base64url"))).toThrow(
      /not one this sink issued/u,
    );
  });
});

describe("toStoredEvent", () => {
  it("reads instants as UTC from epoch milliseconds", () => {
    const stored = toStoredEvent({
      key: "uev_abc",
      meter: "api_request",
      occurred_at: 1785542400000,
      properties: '{"region":"eu"}',
      quantity: "25",
      recorded_at: 1787043600000,
      source: null,
      subject: "cus_1",
    });
    expect(stored.occurredAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(stored.recordedAt.toISOString()).toBe("2026-08-18T09:00:00.000Z");
    expect(stored.quantity).toBe(25);
    expect(stored.properties).toEqual({ region: "eu" });
  });
});
