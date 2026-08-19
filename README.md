# @zanreal/medusa-usage-tinybird

The Tinybird sink for [`@zanreal/medusa-usage`](https://github.com/zanreal-labs/medusa-usage):
the same append-only usage log, in a column store built to scan it.

The plugin ships a Postgres sink and works on a plain Medusa install with no
account to open. This is for the other case: a meter counting billions of events,
where the log stops fitting comfortably in the application's own database.
Installing this package is the whole decision, and a deployment that does not
install it is unaffected in every way.

```sh
pnpm add @zanreal/medusa-usage-tinybird
```

```ts
// medusa-config.ts
plugins: [
  {
    resolve: "@zanreal/medusa-usage",
    options: {
      providers: [
        {
          resolve: "@zanreal/medusa-usage-tinybird",
          id: "tinybird",
          options: {
            host: process.env.TINYBIRD_HOST,
            token: process.env.TINYBIRD_TOKEN,
          },
        },
      ],
    },
  },
]
```

## The schema this sink talks to

The sink is one half of the design; the other half is the Tinybird schema it
reads and writes, and the two only work together. That schema ships in this
repository under [`tinybird/`](./tinybird) - one data source and three endpoints,
and nothing else:

| Resource | File | What it is |
| --- | --- | --- |
| `usage_events` | [`tinybird/datasources/usage_events.datasource`](./tinybird/datasources/usage_events.datasource) | The append-only log. `ReplacingMergeTree`, sorted `meter, subject, occurred_at, key`, partitioned by month of `occurred_at`. |
| `usage_aggregate` | [`tinybird/endpoints/usage_aggregate.pipe`](./tinybird/endpoints/usage_aggregate.pipe) | The total behind an invoice. |
| `usage_events_list` | [`tinybird/endpoints/usage_events_list.pipe`](./tinybird/endpoints/usage_events_list.pipe) | The events behind that total, keyset paged. |
| `usage_events_present` | [`tinybird/endpoints/usage_events_present.pipe`](./tinybird/endpoints/usage_events_present.pipe) | Which keys the log already has. |

Deploy it before pointing a sink at it, with Tinybird's own CLI:

```sh
tb login                 # or --host for a self-hosted instance
tb --cloud deploy
```

The read-time collapse described below lives in those `.pipe` files, so pointing
this sink at a data source that was created some other way - a hand-written
`MergeTree`, or an endpoint that does not `GROUP BY key` - gives back a sink that
double counts every retry. Deploy the schema in this repository rather than
reimplementing it.

The names are options, so a workspace that already uses them for something else
can deploy under different ones and set `datasource`, `aggregatePipe`, `listPipe`
and `presentPipe` to match. The `medusa_usage` token the four files declare carries
exactly the grants the sink needs: `APPEND` on the data source, `READ` on the
three endpoints.

## At most one row per key

This is the guarantee the plugin rests on, and it is the one thing that does not
port from Postgres for free. It is worth reading before trusting a number this
sink produces.

Postgres gets it from a primary key. The deduplication key IS the primary key,
`INSERT ... ON CONFLICT DO NOTHING` makes a retry a no-op inside the statement,
and it is true the instant the statement returns.

ClickHouse, which is what Tinybird is, has no primary key constraint. Its
`ORDER BY` is a sorting key, not a unique one, and nothing refuses a second copy
of a row. The nearest mechanism is `ReplacingMergeTree`, which collapses rows
sharing a sorting key **during background merges** - which run when the engine
decides to, possibly hours later, possibly not at all for parts it does not
choose to combine.

So the honest statement about the engine on its own is **eventual**. A sink built
on `ReplacingMergeTree` and nothing else double counts every retry until a merge
happens to run, and for a number that becomes an invoice that is not a rough edge,
it is the failure the plugin exists to prevent.

### What this sink does instead

Deduplication is enforced where the log is **read**. Every endpoint collapses to
one row per key before it sums anything:

```sql
SELECT key, argMax(quantity, version) AS event_quantity ... GROUP BY key
```

That is not eventual. It is computed over whatever rows exist at the moment of
the query, so a duplicate written a millisecond ago is already collapsed:
`aggregate()` taken immediately after a retried `write()` returns the number it
returned before it. That is asserted against a live Tinybird, not argued (see
[Testing](#testing)).

The engine's merge is then a storage optimisation and nothing more. `ENGINE_VER`
is a negated ingestion timestamp, so the merge keeps the same row the read path
keeps: the earliest-ingested copy, which is also the copy Postgres keeps. The
property that matters falls out of that - **a merge can only ever remove a row
the read path was already discarding** - so an answer cannot change because a
merge ran, and a number can still be re-derived in a year.

### What is left eventual, stated plainly

- **The physical log.** Between a duplicate write and a merge, two rows exist on
  disk, and `SELECT count()` on the data source will say so. **Do not bill from a
  direct query against the data source**; a bare `SELECT sum(quantity)` counts
  every copy. The endpoints are the collapse, and they are the supported read
  path. `aggregate()` and `listEvents()` are correct at any moment.
- **The counters `write` returns.** `duplicates` is counted by asking which keys
  are already stored, immediately before appending. That is a check-then-act, so
  two processes writing the same key at the same instant can both find it missing
  and both append, leaving the counters optimistic by one. Nothing else is
  affected: the copies are identical and the read path keeps one.
- **Whose copy wins under a key collision.** Both rules keep the earliest
  ingested, matching Postgres. It only becomes observable if a caller reuses an
  explicit `idempotencyKey` across events with different facts, which is a caller
  bug in either sink.

## Options

Everything comes from the provider's `options`, with an environment fallback for
the two values that belong to a deployment rather than to a repository. Nothing
is hardcoded, and the token is never logged: it goes into an `Authorization`
header and nowhere else, never into a URL, and a Tinybird error body that quotes
it back is redacted before it reaches a message.

| Option | Default | What it is |
| --- | --- | --- |
| `host` | `TINYBIRD_HOST` | The Tinybird API host, e.g. `https://api.tinybird.co`. |
| `token` | `TINYBIRD_TOKEN` | A token with `APPEND` on the data source and `READ` on the endpoints. The `medusa_usage` token the schema declares is exactly that. |
| `datasource` | `usage_events` | The usage log. |
| `aggregatePipe` | `usage_aggregate` | The aggregate endpoint. |
| `listPipe` | `usage_events_list` | The listing endpoint. |
| `presentPipe` | `usage_events_present` | The key-lookup endpoint. |
| `checkForDuplicates` | `true` | Ask which keys are already stored before appending. |
| `timeoutMs` | `10000` | How long one HTTP call may take before it is abandoned and retried. |

Every one of them is validated by Medusa's provider loader before the service is
constructed, so a missing token is a failed boot with a sentence explaining what
to set, not a 401 six hours into a billing period.

### `checkForDuplicates`

On by default. It costs one extra round trip per batch and buys two things: a
truthful `duplicates` count, and a retried batch that appends nothing at all
rather than a second copy of every row.

Turning it off halves the round trips and **cannot cause a double count** -
deduplication is in the read path either way. What it costs is honesty in the
counters, which will read zero duplicates forever, and a log that accumulates
physical copies until the engine merges them away.

## Testing

```sh
pnpm test
```

Unit tests run against a fake Tinybird and cover the wiring: what goes on the
wire, what comes back off it, that the token never reaches a URL, that a
quarantined row throws rather than vanishing.

They are not sufficient, and the suite says so. The property this sink is hard to
get right belongs to the engine on the other side, so `src/live.test.ts` writes
to a real Tinybird and reads the answer back. It is skipped unless the
environment names one:

```sh
tb local start
tb --local build
TINYBIRD_HOST=http://localhost:7181 TINYBIRD_TOKEN=... pnpm test
```

What it asserts there: that a write can be aggregated as soon as it returns; that
a replayed batch does not move the total; that a duplicate which *did* reach the
log as a second physical row still does not move the total; that the window is
half open at millisecond resolution and consecutive periods tile; that a
dimension filter is an equality and is typed; and that paging never skips or
repeats a row.

## License

MIT
