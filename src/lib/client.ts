import { MedusaError } from "@medusajs/framework/utils";
import type { ResolvedTinybirdOptions } from "./options";
import { redactToken } from "./options";

/**
 * The two HTTP calls this sink makes, and the rules they follow.
 *
 * There is no Tinybird SDK here, and that is deliberate rather than austere:
 * appending NDJSON and reading an endpoint are two POSTs, `fetch` has been in
 * Node since 18, and a dependency that wraps them would be a dependency this
 * package has to keep current for the rest of its life. The sink's contract is
 * three methods; the client under it should not be larger than the sink.
 *
 * ## The token goes in a header, never in a URL
 *
 * Tinybird accepts `?token=` as well as `Authorization: Bearer`. This client
 * only ever uses the header. A URL is the part of a request that ends up in
 * access logs, proxy logs, error trackers and browser histories without anyone
 * choosing to put it there, and a token in a log line is a leaked credential.
 *
 * ## Parameters go in a body, never in a query string
 *
 * The same reason, plus a practical one: a batch of five hundred keys is thirty
 * five kilobytes of query string, which is past what several proxies will carry.
 * Tinybird endpoints read their parameters from a JSON body on POST, so that is
 * what this sends.
 *
 * ## Ingestion waits
 *
 * The append uses `wait=true`, so the call does not return until Tinybird has
 * committed the rows and they are queryable. Without it, a `write` that had
 * returned would not yet be visible to an `aggregate`, and the module aggregates
 * immediately after flushing its buffer - the number would be quietly short by
 * whatever was still in flight.
 */

/** What Tinybird's events endpoint answers with. */
export interface AppendResult {
  successful_rows: number;
  quarantined_rows: number;
}

interface QueryResponse<TRow> {
  data?: TRow[];
}

export class TinybirdClient {
  private readonly options: ResolvedTinybirdOptions;

  constructor(options: ResolvedTinybirdOptions) {
    this.options = options;
  }

  /**
   * Append rows to the usage data source.
   *
   * `body` is NDJSON, one row per line, already in the shape the data source's
   * schema declares.
   */
  async append(body: string): Promise<AppendResult> {
    const { datasource, host } = this.options;
    const url = `${host}/v0/events?name=${encodeURIComponent(datasource)}&wait=true`;
    return this.send<AppendResult>(url, body, "application/x-ndjson", `appending to "${datasource}"`);
  }

  /** Read an endpoint, with its parameters in the request body. */
  async query<TRow>(pipe: string, parameters: Record<string, unknown>): Promise<TRow[]> {
    const url = `${this.options.host}/v0/pipes/${encodeURIComponent(pipe)}.json`;
    const response = await this.send<QueryResponse<TRow>>(
      url,
      JSON.stringify(parameters),
      "application/json",
      `reading "${pipe}"`,
    );
    return response.data ?? [];
  }

  private async send<TBody>(
    url: string,
    body: string,
    contentType: string,
    what: string,
  ): Promise<TBody> {
    const { timeoutMs, token } = this.options;

    let response: Response;
    try {
      response = await fetch(url, {
        body,
        headers: {
          // The only place the token appears in this package.
          authorization: `Bearer ${token}`,
          "content-type": contentType,
        },
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A timeout and a refused connection are both retryable, and the module
      // retries the whole batch, so this only has to say what was being done.
      throw this.failure(
        `${what} failed: ${redactToken(errorMessage(error), token)}. The batch is retried whole; keys are derived, so whatever landed before the failure is not counted twice.`,
        MedusaError.Types.UNEXPECTED_STATE,
      );
    }

    const payload = await response.text().catch(() => "");
    if (!response.ok) {
      throw this.failure(
        `${what} was refused with HTTP ${response.status}: ${redactToken(payload.slice(0, 500), token)}`,
        response.status === 401 || response.status === 403
          ? MedusaError.Types.NOT_ALLOWED
          : MedusaError.Types.UNEXPECTED_STATE,
      );
    }

    try {
      return JSON.parse(payload) as TBody;
    } catch {
      throw this.failure(
        `${what} returned something that is not JSON. This usually means the host is not a Tinybird API, or a proxy answered instead of it.`,
        MedusaError.Types.UNEXPECTED_STATE,
      );
    }
  }

  private failure(message: string, type: string): MedusaError {
    return new MedusaError(type, `medusa-usage-tinybird: ${message}`);
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
