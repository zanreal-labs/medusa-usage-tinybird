import { MedusaError } from "@medusajs/framework/utils";
import { AbstractUsageSinkProviderService } from "@zanreal/medusa-usage/lib/sink/abstract-sink";
import type {
  UsageAggregateQuery,
  UsageAggregateResult,
  UsageEventPage,
  UsageListQuery,
  UsageSinkWriteResult,
} from "@zanreal/medusa-usage/lib/sink/types";
import type { UsageEvent } from "@zanreal/medusa-usage/lib/usage/event";
import { TinybirdClient } from "./lib/client";
import type { AggregateRow, PresentKeyRow, StoredEventRow } from "./lib/encoding";
import {
  dateOrNull,
  decodeCursor,
  encodeCursor,
  exactInteger,
  toNdjson,
  toPropertyFilter,
  toStoredEvent,
} from "./lib/encoding";
import type { ResolvedTinybirdOptions, TinybirdUsageSinkOptions } from "./lib/options";
import { resolveTinybirdOptions } from "./lib/options";

/**
 * The Tinybird usage sink.
 *
 * The same three methods the built-in Postgres sink implements, against a column
 * store instead of the application's own database. Everything below is about the
 * one guarantee that does not port across for free.
 *
 * ## What Tinybird actually guarantees, and what it does not
 *
 * The sink contract says: at most one row per key, and a `write` may be called
 * any number of times with the same event. Postgres gets that from a primary
 * key. The key IS the primary key, `INSERT ... ON CONFLICT DO NOTHING` makes a
 * retry a no-op inside the statement, and it is true the instant the statement
 * returns.
 *
 * ClickHouse, which is what Tinybird is, has no primary key constraint. Its
 * `ORDER BY` is a sorting key, not a unique one, and nothing refuses a second
 * copy of a row. The nearest mechanism is `ReplacingMergeTree`, which collapses
 * rows sharing a sorting key - **during background merges**. Merges run when the
 * engine decides to, which may be seconds or hours after the write, and may
 * never happen for parts it does not choose to combine.
 *
 * So the honest statement about the engine alone is: **eventual**, and a sink
 * built on `ReplacingMergeTree` and nothing else double counts every retry until
 * a merge happens to run. For something that ends up on an invoice that is not a
 * subtle degradation, it is the failure the plugin exists to prevent.
 *
 * ## How this sink gets the guarantee back, synchronously
 *
 * Deduplication is enforced where the log is read, not where it is written.
 * Every endpoint the sink calls collapses to one row per key before it sums
 * anything:
 *
 *     SELECT key, argMax(quantity, version) ... GROUP BY key
 *
 * That is not eventual. It is computed over whatever rows exist at the moment of
 * the query, so a duplicate written a millisecond ago is already collapsed. An
 * `aggregate` taken immediately after a retried `write` returns the same number
 * as one taken before it, and this is verified against a live Tinybird rather
 * than argued: see the package's tests.
 *
 * The engine's merge is then a storage optimisation and nothing more. It is
 * configured to keep the same row the read path keeps - `ENGINE_VER` is a
 * negated ingestion timestamp, so both keep the earliest-ingested copy - which
 * gives the property that actually matters: **a merge can only ever remove a row
 * the read path was already discarding**. An answer therefore cannot change
 * because a merge ran, which is the whole requirement for a number that has to
 * be re-derivable in a year.
 *
 * ## What is left eventual, stated plainly
 *
 * - **The physical log.** Between a duplicate write and a merge, two rows exist
 *   on disk. `SELECT count()` on the data source will say so. That is why the
 *   endpoints are the only supported read path, and why a dashboard querying the
 *   data source directly will disagree with an invoice.
 * - **`write` reporting.** `duplicates` is counted by asking which keys are
 *   already stored, immediately before appending. That is a check-then-act, so
 *   two processes writing the same key at the same instant can both find it
 *   missing and both append. The counters are then optimistic by one. Nothing
 *   else is affected: the copies are identical, and the read path keeps one.
 * - **Nothing about `aggregate` or `listEvents`.** Neither depends on a merge
 *   having run or on the pre-append check having been right.
 *
 * The rule for a caller, in one sentence: bill from `aggregate`, never from a
 * direct query against the data source.
 */

/** Hard ceiling on one page, whatever a caller asks for. Matches the Postgres sink. */
const MAX_PAGE_SIZE = 1000;

export const TINYBIRD_USAGE_SINK = "tinybird";

export default class TinybirdUsageSinkService extends AbstractUsageSinkProviderService {
  static identifier = TINYBIRD_USAGE_SINK;

  /**
   * Medusa's provider loader awaits this before it constructs the service, so a
   * missing host or token is a failed boot rather than a 401 on the first flush,
   * six hours into a billing period, with the events already buffered.
   */
  static validateOptions(options: Record<string, unknown>): void {
    resolveTinybirdOptions(options as Partial<TinybirdUsageSinkOptions>);
  }

  private readonly options: ResolvedTinybirdOptions;
  private readonly client: TinybirdClient;

  constructor(_cradle: Record<string, unknown>, options: Record<string, unknown>) {
    super();
    this.options = resolveTinybirdOptions(options as Partial<TinybirdUsageSinkOptions>);
    this.client = new TinybirdClient(this.options);
  }

  /**
   * Append a batch.
   *
   * Two steps, and the first one is optional. The key lookup is what makes
   * `duplicates` a real number and what stops a retried batch from appending a
   * second copy of every row; the append is what the guarantee never depended
   * on, because the guarantee lives in the read path.
   *
   * A partial append is safe to retry for the same reason it is under Postgres:
   * the keys are derived, so the rows that landed are the rows the retry would
   * write, and the read path keeps one of each either way.
   */
  async write(events: readonly UsageEvent[]): Promise<UsageSinkWriteResult> {
    if (events.length === 0) {
      return { appended: 0, duplicates: 0, received: 0 };
    }

    const stored = this.options.checkForDuplicates ? await this.presentKeys(events) : new Set<string>();
    const fresh = events.filter((event) => !stored.has(event.key));

    if (fresh.length === 0) {
      return { appended: 0, duplicates: events.length, received: events.length };
    }

    const result = await this.client.append(toNdjson(fresh));

    // A quarantined row is a row Tinybird could not fit to the schema. It is not
    // stored and it is not an error the ingestion call reports as one, so
    // saying nothing here would be silent, permanent loss of metered usage.
    // Throwing makes the module retry the batch and keep it, which will not
    // clear a genuine schema mismatch - and a flush that stays stuck is a great
    // deal louder, and more recoverable, than usage that quietly vanished.
    if (result.quarantined_rows > 0) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-usage-tinybird: Tinybird quarantined ${result.quarantined_rows} of ${fresh.length} rows appended to "${this.options.datasource}". A quarantined row is not stored. Check the data source's quarantine table against the schema the data project deploys.`,
      );
    }
    if (result.successful_rows !== fresh.length) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-usage-tinybird: appended ${fresh.length} rows to "${this.options.datasource}" but Tinybird acknowledged ${result.successful_rows}. The batch is retried whole.`,
      );
    }

    return {
      appended: fresh.length,
      duplicates: events.length - fresh.length,
      received: events.length,
    };
  }

  async aggregate(query: UsageAggregateQuery): Promise<UsageAggregateResult> {
    const [row] = await this.client.query<AggregateRow>(
      this.options.aggregatePipe,
      this.parametersFor(query),
    );
    if (!row) {
      return { eventCount: 0, firstOccurredAt: null, lastOccurredAt: null, total: 0 };
    }
    return {
      eventCount: exactInteger(row.event_count, "the event count"),
      firstOccurredAt: dateOrNull(row.first_occurred_at),
      lastOccurredAt: dateOrNull(row.last_occurred_at),
      total: exactInteger(row.total, "the total"),
    };
  }

  /**
   * A page of the log, oldest first.
   *
   * One more row than the caller asked for is fetched and then dropped, which is
   * how the page learns whether another one exists. Asking for exactly `limit`
   * and issuing a cursor whenever the page came back full would hand out a
   * cursor that leads to an empty page every time a window divides evenly.
   */
  async listEvents(query: UsageListQuery): Promise<UsageEventPage> {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit)), MAX_PAGE_SIZE);
    const after = decodeCursor(query.cursor);

    const rows = await this.client.query<StoredEventRow>(this.options.listPipe, {
      ...this.parametersFor(query),
      ...(after === null
        ? {}
        : { cursor_key: after.key, cursor_occurred_at: after.occurredAt.toISOString() }),
      page_size: limit + 1,
    });

    const page = rows.slice(0, limit);
    const events = page.map(toStoredEvent);
    const last = events.at(-1);

    return {
      events,
      nextCursor: rows.length > limit && last ? encodeCursor(last.occurredAt, last.key) : null,
    };
  }

  /**
   * Which of a batch's keys the log already has.
   *
   * Bounded by the batch's own event times so the lookup prunes to the months it
   * could be in rather than scanning the log. A key stored under an
   * `occurred_at` outside those bounds is reported missing and appended again,
   * which needs a caller to have reused an explicit idempotency key across
   * events with different facts, and which the read-time collapse absorbs.
   */
  private async presentKeys(events: readonly UsageEvent[]): Promise<Set<string>> {
    const instants = events.map((event) => event.occurredAt.getTime());
    const rows = await this.client.query<PresentKeyRow>(this.options.presentPipe, {
      date_from: new Date(Math.min(...instants)).toISOString(),
      date_to: new Date(Math.max(...instants)).toISOString(),
      keys: events.map((event) => event.key),
    });
    return new Set(rows.map((row) => row.key));
  }

  /** The filters every endpoint shares, in the shape the endpoints declare them. */
  private parametersFor(query: UsageAggregateQuery): Record<string, unknown> {
    const filter = toPropertyFilter(query.properties);
    return {
      date_from: query.from.toISOString(),
      date_to: query.to.toISOString(),
      meter: query.meter,
      ...(query.subject ? { subject: query.subject } : {}),
      ...(filter ?? {}),
    };
  }
}
