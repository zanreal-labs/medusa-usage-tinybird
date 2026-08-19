import { randomUUID } from "node:crypto";
import type { StoredUsageEvent } from "@zanreal/medusa-usage/lib/sink/types";
import { normalizeUsageEvent } from "@zanreal/medusa-usage/lib/usage/event";
import { beforeAll, describe, expect, it } from "vitest";
import TinybirdUsageSinkService from "./service";

/**
 * The sink against a real Tinybird.
 *
 * Unit tests against a fake prove the wiring. They cannot prove the only thing
 * this sink is difficult to get right, because that property belongs to the
 * engine on the other side: writing the same event twice must not change a
 * total, and it must not change it *now* rather than after some background merge
 * has run. So this suite writes to a live instance and reads the answer back.
 *
 * It is skipped unless TINYBIRD_HOST and TINYBIRD_TOKEN are set, so `pnpm test`
 * on a laptop with no Tinybird still passes. Point it at Tinybird Local:
 *
 *     tb local start
 *     tb --local build
 *     TINYBIRD_HOST=http://localhost:7181 TINYBIRD_TOKEN=... pnpm test
 *
 * Every case meters a freshly generated meter name, so a run appends to the log
 * rather than needing it empty, and two runs cannot see each other's events.
 */

const live = Boolean(process.env.TINYBIRD_HOST && process.env.TINYBIRD_TOKEN);

/** The window every case in a run is asked about. Real instants, not round ones. */
const T0 = new Date("2026-08-01T00:00:00.000Z");
const T1 = new Date("2026-08-15T12:00:00.000Z");
const T2 = new Date("2026-08-15T12:00:01.000Z");
const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-09-01T00:00:00.000Z");

describe.skipIf(!live)("against a live Tinybird", () => {
  // Constructed in `beforeAll` rather than here: a skipped suite still
  // evaluates its own body, and building the sink asserts the configuration.
  let sink: TinybirdUsageSinkService;
  const meter = `test_${randomUUID().replaceAll("-", "")}`;

  const events = [
    normalizeUsageEvent({
      meter,
      occurredAt: T0.toISOString(),
      properties: { region: "eu", tier: 2 },
      quantity: 25,
      source: "gateway",
      subject: "cus_1",
    }),
    normalizeUsageEvent({
      meter,
      occurredAt: T1.toISOString(),
      properties: { region: "us", tier: 2 },
      quantity: 5,
      subject: "cus_1",
    }),
    // A correction: the log is append only, so a mistake is reversed by an
    // event, never by an edit.
    normalizeUsageEvent({
      meter,
      occurredAt: T2.toISOString(),
      quantity: -5,
      subject: "cus_1",
    }),
    normalizeUsageEvent({
      meter,
      occurredAt: new Date("2026-08-20T00:00:00.000Z").toISOString(),
      quantity: 100,
      subject: "cus_2",
    }),
    // Outside the window on the exclusive side, to prove it stays outside.
    normalizeUsageEvent({
      meter,
      occurredAt: TO.toISOString(),
      quantity: 7,
      subject: "cus_1",
    }),
  ];

  const august = (subject?: string) =>
    sink.aggregate({ from: FROM, meter, subject: subject ?? null, to: TO });

  beforeAll(async () => {
    sink = new TinybirdUsageSinkService({}, {});
    const result = await sink.write(events);
    expect(result).toEqual({ appended: events.length, duplicates: 0, received: events.length });
  });

  it("aggregates what was written", async () => {
    // 25 for the first event, 5 for the second, minus 5 for the correction.
    expect(await august("cus_1")).toEqual({
      eventCount: 3,
      firstOccurredAt: T0,
      lastOccurredAt: T2,
      total: 25,
    });
  });

  it("aggregates every subject on the meter when none is named", async () => {
    expect(await august()).toMatchObject({ eventCount: 4, total: 125 });
  });

  it("does not count a replayed batch twice", async () => {
    const before = await august("cus_1");

    const replay = await sink.write(events);
    expect(replay).toEqual({ appended: 0, duplicates: events.length, received: events.length });

    // The point of the whole exercise, and it is asserted immediately: no sleep,
    // no waiting for a merge.
    expect(await august("cus_1")).toEqual(before);
  });

  it("does not count a duplicate that reached the log as a physical row", async () => {
    // The pre-append key lookup is an optimisation and an honest counter, not
    // the guarantee. Turning it off puts a second physical copy of every event
    // into the data source, which is exactly the state a naive port leaves the
    // log in permanently. The total must not move.
    const before = await august("cus_1");

    const blind = new TinybirdUsageSinkService({}, { checkForDuplicates: false });
    const written = await blind.write(events);
    expect(written).toEqual({ appended: events.length, duplicates: 0, received: events.length });

    expect(await august("cus_1")).toEqual(before);
    expect(await august()).toMatchObject({ eventCount: 4, total: 125 });
  });

  it("counts the event on the boundary in the later period and not the earlier one", async () => {
    const inside = await sink.aggregate({
      from: T0,
      meter,
      subject: "cus_1",
      to: new Date(T0.getTime() + 1),
    });
    expect(inside).toMatchObject({ eventCount: 1, total: 25 });

    const before = await sink.aggregate({
      from: new Date(T0.getTime() - 1),
      meter,
      subject: "cus_1",
      to: T0,
    });
    expect(before).toMatchObject({ eventCount: 0, total: 0 });

    // September's `from` is August's `to`, and the event on it belongs to
    // September. Consecutive periods tile, and nothing is counted twice.
    const september = await sink.aggregate({
      from: TO,
      meter,
      subject: "cus_1",
      to: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(september).toMatchObject({ eventCount: 1, total: 7 });
  });

  it("filters a dimension by equality, and by type", async () => {
    expect(await sink.aggregate({ from: FROM, meter, properties: { region: "eu" }, to: TO })).toMatchObject({
      eventCount: 1,
      total: 25,
    });
    // The tier is the number 2. The string "2" is a different value, exactly as
    // it is under jsonb containment.
    expect(await sink.aggregate({ from: FROM, meter, properties: { tier: 2 }, to: TO })).toMatchObject({
      eventCount: 2,
    });
    expect(await sink.aggregate({ from: FROM, meter, properties: { tier: "2" }, to: TO })).toMatchObject({
      eventCount: 0,
    });
    // An event carrying no properties at all matches no dimension filter.
    expect(
      await sink.aggregate({ from: FROM, meter, properties: { region: "eu" }, subject: "cus_2", to: TO }),
    ).toMatchObject({ eventCount: 0 });
  });

  it("answers an untouched meter with zero rather than with nothing", async () => {
    expect(
      await sink.aggregate({ from: FROM, meter: `test_${randomUUID().replaceAll("-", "")}`, to: TO }),
    ).toEqual({ eventCount: 0, firstOccurredAt: null, lastOccurredAt: null, total: 0 });
  });

  it("lists the events behind the aggregate, once each, oldest first", async () => {
    const page = await sink.listEvents({ from: FROM, limit: 100, meter, subject: "cus_1", to: TO });
    expect(page.nextCursor).toBeNull();
    expect(page.events.map((entry) => entry.key)).toEqual([
      events[0].key,
      events[1].key,
      events[2].key,
    ]);
    expect(page.events.map((entry) => entry.quantity)).toEqual([25, 5, -5]);
  });

  it("round-trips an event through the log unchanged", async () => {
    const [stored] = (
      await sink.listEvents({ from: FROM, limit: 1, meter, subject: "cus_1", to: TO })
    ).events;
    expect(stored).toMatchObject({
      key: events[0].key,
      meter,
      occurredAt: T0,
      properties: { region: "eu", tier: 2 },
      quantity: 25,
      source: "gateway",
      subject: "cus_1",
    });
    // Ingestion time is recorded, and is the sink's own clock rather than the
    // caller's. It is never a filter.
    expect(stored.recordedAt.getTime()).toBeGreaterThan(0);
  });

  it("pages without skipping or repeating a row", async () => {
    const seen: StoredUsageEvent[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = await sink.listEvents({ cursor, from: FROM, limit: 1, meter, to: TO });
      seen.push(...page.events);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen.map((entry) => entry.key)).toEqual([
      events[0].key,
      events[1].key,
      events[2].key,
      events[3].key,
    ]);
    expect(new Set(seen.map((entry) => entry.key)).size).toBe(4);
  });
});
