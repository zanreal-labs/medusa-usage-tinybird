import { MedusaError } from "@medusajs/framework/utils";
import type { JsonScalar, JsonValue } from "@zanreal/medusa-usage/lib/usage/canonical-json";
import { canonicalJson } from "@zanreal/medusa-usage/lib/usage/canonical-json";
import type { UsageEvent } from "@zanreal/medusa-usage/lib/usage/event";
import type { StoredUsageEvent } from "@zanreal/medusa-usage/lib/sink/types";

/**
 * Turning usage events into rows and back.
 *
 * Kept apart from the service so that what crosses the wire is one readable
 * thing, and so the round trip can be asserted without an HTTP call: an event
 * encoded and then decoded has to be the event that went in, or a listing does
 * not prove the aggregate it belongs to.
 *
 * ## Property bags cross as canonical JSON
 *
 * `properties` is stored as the canonical JSON text of the whole bag, and a
 * dimension filter as two positional arrays of names and canonical values. The
 * endpoint compares each one with `JSONExtractRaw`, which yields that value's
 * own canonical text, and that is what makes the filter typed: `tier = 2` and
 * `tier = "2"` are different filters matching different events, which is what
 * `jsonb` containment gives the Postgres sink.
 *
 * `canonicalJson` is imported from the plugin rather than reimplemented here on
 * purpose. It is the same function that decides the deduplication key, so the
 * bag that was hashed into a key, the bag that was stored, and the encoding of a
 * value in a filter cannot drift apart.
 *
 * ## Instants cross as epoch milliseconds
 *
 * Every timestamp leaves the endpoints as an integer count of milliseconds since
 * the epoch, never as a formatted string. ClickHouse renders a `DateTime64(3)`
 * as `2026-08-01 00:00:00.000` with no offset, and the difference between
 * reading that as UTC and reading it as local time is a whole billing period for
 * anyone east or west of Greenwich. An integer has no zone to get wrong.
 *
 * Instants going the other way are ISO 8601 with an offset, which is what
 * `Date.prototype.toISOString` produces and what the endpoints parse as UTC.
 */

/** One line of the NDJSON body appended to the data source. */
export interface UsageEventRow {
  key: string;
  meter: string;
  subject: string;
  quantity: number;
  occurred_at: string;
  source: string | null;
  properties: string;
}

/** A row of the aggregate endpoint. */
export interface AggregateRow {
  total: string;
  event_count: string;
  first_occurred_at: number | null;
  last_occurred_at: number | null;
}

/** A row of the listing endpoint. */
export interface StoredEventRow {
  key: string;
  meter: string;
  subject: string;
  quantity: string;
  occurred_at: number;
  source: string | null;
  properties: string;
  recorded_at: number;
}

/** A row of the key-lookup endpoint. */
export interface PresentKeyRow {
  key: string;
}

const fail = (message: string): never => {
  throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `medusa-usage-tinybird: ${message}`);
};

/**
 * Neither `recorded_at` nor the version that decides which copy of a key wins is
 * sent. Both are assigned by Tinybird, so one clock decides which write of a key
 * arrived first, the way `now()` does in the Postgres sink. A fleet of Medusa
 * instances with skewed clocks cannot disagree about it.
 */
export function toRow(event: UsageEvent): UsageEventRow {
  return {
    key: event.key,
    meter: event.meter,
    occurred_at: event.occurredAt.toISOString(),
    properties: toPropertyText(event.properties),
    quantity: event.quantity,
    source: event.source,
    subject: event.subject,
  };
}

/** The NDJSON body for a batch. */
export function toNdjson(events: readonly UsageEvent[]): string {
  return events.map((event) => JSON.stringify(toRow(event))).join("\n");
}

/** No properties is the empty string, which is what the data source stores. */
export function toPropertyText(properties: Record<string, JsonValue> | null): string {
  return properties === null ? "" : canonicalJson(properties);
}

/**
 * Stored text back into a property bag.
 *
 * The empty string reads back as no properties rather than as an empty object.
 * The two describe the same event, and the plugin collapses one into the other
 * before an event is ever keyed, so nothing is lost.
 */
export function fromPropertyText(text: string): Record<string, JsonValue> | null {
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as Record<string, JsonValue>;
  } catch {
    return fail(
      `a stored property bag is not JSON: ${text.slice(0, 120)}. Nothing this sink writes can produce that, so the row was written by something else.`,
    );
  }
}

/** The two positional arrays the endpoints take a dimension filter as. */
export function toPropertyFilter(
  properties: Record<string, JsonScalar> | null | undefined,
): { property_keys: string[]; property_values: string[] } | null {
  if (!properties) {
    return null;
  }
  const names = Object.keys(properties);
  if (names.length === 0) {
    return null;
  }
  return {
    property_keys: names,
    property_values: names.map((name) => canonicalJson(properties[name])),
  };
}

export function toStoredEvent(row: StoredEventRow): StoredUsageEvent {
  return {
    key: row.key,
    meter: row.meter,
    occurredAt: new Date(row.occurred_at),
    properties: fromPropertyText(row.properties),
    quantity: exactInteger(row.quantity, `the quantity of event ${row.key}`),
    recordedAt: new Date(row.recorded_at),
    source: row.source,
    subject: row.subject,
  };
}

/**
 * An Int64 that arrived as text, refused rather than rounded if it does not fit.
 *
 * The endpoints return `quantity` and `total` as strings because a 64-bit
 * integer is not always a JSON number, and `JSON.parse` would round one that is
 * too large without saying so. `BigInt` parses the full width, and a value past
 * the point where a JavaScript number stops representing every integer is a
 * loud failure here rather than a quietly wrong invoice later.
 */
export function exactInteger(value: string, what: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return fail(`${what} came back as "${value}", which is not an integer.`);
  }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    return fail(
      `${what} is ${parsed.toString()}, beyond exact integer arithmetic in JavaScript. Meter a coarser unit; a number this size can no longer be summed without rounding.`,
    );
  }
  return Number(parsed);
}

export const dateOrNull = (millis: number | null): Date | null =>
  millis === null ? null : new Date(millis);

/**
 * `<iso>|<key>`, base64url. Opaque to callers, and byte for byte the encoding
 * the built-in Postgres sink issues, so a page taken from one sink can be
 * resumed against the other rather than silently restarting.
 */
export const encodeCursor = (occurredAt: Date, key: string): string =>
  Buffer.from(`${occurredAt.toISOString()}|${key}`, "utf8").toString("base64url");

export const decodeCursor = (
  cursor: string | null | undefined,
): { occurredAt: Date; key: string } | null => {
  if (!cursor) {
    return null;
  }
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = value.indexOf("|");
  const occurredAt = new Date(value.slice(0, separator));
  const key = value.slice(separator + 1);
  if (separator < 0 || Number.isNaN(occurredAt.getTime()) || !key) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-usage-tinybird: the paging cursor is not one this sink issued.",
    );
  }
  return { key, occurredAt };
};
