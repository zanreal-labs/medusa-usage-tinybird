import { MedusaError } from "@medusajs/framework/utils";

/**
 * What the Tinybird sink needs to know, and where it is allowed to come from.
 *
 * Two rules, and both of them are about the token.
 *
 * **Nothing is hardcoded.** A host name and a data project belong to a
 * deployment, not to a package. Every value here comes from the provider's
 * `options` in `medusa-config.ts`, or from the environment, and the code has no
 * fallback of its own beyond the names of the resources the data project
 * declares.
 *
 * **Nothing is logged.** A Tinybird token is a credential: `APPEND` on the usage
 * log and `READ` on its endpoints. It is read once, here, and from here it goes
 * into an `Authorization` header and nowhere else. It is never put in a URL,
 * because a URL is the one part of an HTTP call that ends up in access logs,
 * proxy logs and error reports by default. Nothing in this package interpolates
 * it into a message, and `redactToken` exists so that a response body echoing it
 * back cannot turn into a leak either.
 *
 * Everything is asserted at the edge. Medusa's provider loader calls
 * `validateOptions` before it constructs the service, so a missing token is a
 * failed boot with a sentence explaining what to set, not a 401 six hours into a
 * billing period.
 */

/** What a host may put in the provider's `options`. */
export interface TinybirdUsageSinkOptions {
  /**
   * The Tinybird API host, e.g. `https://api.tinybird.co` or
   * `http://localhost:7181` for Tinybird Local. Falls back to `TINYBIRD_HOST`.
   */
  host?: string;
  /**
   * A token carrying `APPEND` on the usage data source and `READ` on the three
   * endpoints. The `medusa_usage` token the data project declares is exactly
   * that. Falls back to `TINYBIRD_TOKEN`.
   */
  token?: string;
  /** The usage log data source. Defaults to the name the data project uses. */
  datasource?: string;
  /** The aggregate endpoint. Defaults to the name the data project uses. */
  aggregatePipe?: string;
  /** The listing endpoint. Defaults to the name the data project uses. */
  listPipe?: string;
  /** The key-lookup endpoint. Defaults to the name the data project uses. */
  presentPipe?: string;
  /**
   * Whether `write` asks which keys are already stored before it appends.
   *
   * On by default, and worth the round trip for most deployments: it is what
   * lets `write` report `duplicates` truthfully, and it means a retried batch
   * appends nothing at all rather than a second copy of every row.
   *
   * Turning it off halves the round trips per batch and cannot cause a double
   * count, because deduplication is enforced when the log is read and not when
   * it is written. What it costs is honesty in the counters - `duplicates` will
   * always be zero - and a log that accumulates physical copies until the engine
   * merges them away.
   */
  checkForDuplicates?: boolean;
  /** How long one HTTP call may take before it is abandoned and retried. */
  timeoutMs?: number;
}

/** Options after defaults, validation and environment. Every field is present. */
export interface ResolvedTinybirdOptions {
  host: string;
  token: string;
  datasource: string;
  aggregatePipe: string;
  listPipe: string;
  presentPipe: string;
  checkForDuplicates: boolean;
  timeoutMs: number;
}

/** The resources this package's `tinybird/` schema deploys. */
export const DEFAULT_DATASOURCE = "usage_events";
export const DEFAULT_AGGREGATE_PIPE = "usage_aggregate";
export const DEFAULT_LIST_PIPE = "usage_events_list";
export const DEFAULT_PRESENT_PIPE = "usage_events_present";

/**
 * Ten seconds.
 *
 * Long enough for a five hundred row append across the internet, short enough
 * that a hung connection becomes a retry rather than a stuck flush. The module
 * retries whole batches and the keys are derived, so abandoning a call that may
 * have half-landed is safe.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Read when the corresponding option is absent. The same names the data project's CI uses. */
export const HOST_ENV_VAR = "TINYBIRD_HOST";
export const TOKEN_ENV_VAR = "TINYBIRD_TOKEN";

/**
 * Data source and pipe names are interpolated into a URL path, so they are held
 * to the shape Tinybird gives its own resources rather than escaped. A name that
 * needs escaping is a typo, and refusing it is more useful than encoding it.
 */
const RESOURCE_NAME = /^[a-z_][a-z0-9_]*$/u;

const fail = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-usage-tinybird: ${message}`);
};

const text = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * The host, as an origin with no trailing slash.
 *
 * Parsed rather than pattern-matched, so `api.tinybird.co` without a scheme is
 * refused with a sentence instead of producing a request to a relative URL. Only
 * http and https: anything else is a mistake that would otherwise surface as an
 * unhelpful fetch failure.
 */
const hostOf = (value: unknown): string => {
  const candidate = text(value) ?? text(process.env[HOST_ENV_VAR]);
  if (candidate === null) {
    return fail(
      `no Tinybird host. Set the \`host\` option on the provider or the ${HOST_ENV_VAR} environment variable, e.g. "https://api.tinybird.co".`,
    );
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail(
      `the Tinybird host "${candidate}" is not an absolute URL. It needs a scheme, e.g. "https://api.tinybird.co".`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(`the Tinybird host "${candidate}" is not an http or https URL.`);
  }
  return url.origin;
};

/**
 * The token.
 *
 * Note what this function does not do: it does not put the value it rejected
 * into the message. Every other validator here echoes the bad input back,
 * because seeing it is how you fix it. A credential is the one input where
 * echoing it turns a boot failure into a leaked secret in whatever collects the
 * logs.
 */
const tokenOf = (value: unknown): string => {
  const candidate = text(value) ?? text(process.env[TOKEN_ENV_VAR]);
  if (candidate === null) {
    return fail(
      `no Tinybird token. Set the \`token\` option on the provider or the ${TOKEN_ENV_VAR} environment variable. It needs APPEND on the usage data source and READ on its endpoints; the \`medusa_usage\` token the data project declares is exactly that.`,
    );
  }
  return candidate;
};

const resourceOf = (value: unknown, field: string, fallback: string): string => {
  const candidate = text(value) ?? fallback;
  if (!RESOURCE_NAME.test(candidate)) {
    return fail(
      `\`${field}\` is "${candidate}", which is not a Tinybird resource name. Names are lower case letters, digits and underscores, and cannot start with a digit.`,
    );
  }
  return candidate;
};

/** Apply defaults and the environment, and reject anything that cannot mean what it says. */
export function resolveTinybirdOptions(
  options?: Partial<TinybirdUsageSinkOptions>,
): ResolvedTinybirdOptions {
  const checkForDuplicates = options?.checkForDuplicates ?? true;
  if (typeof checkForDuplicates !== "boolean") {
    fail(`\`checkForDuplicates\` must be true or false (received ${String(checkForDuplicates)}).`);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail(`\`timeoutMs\` must be a whole number of milliseconds (received ${String(timeoutMs)}).`);
  }

  return {
    aggregatePipe: resourceOf(options?.aggregatePipe, "aggregatePipe", DEFAULT_AGGREGATE_PIPE),
    checkForDuplicates,
    datasource: resourceOf(options?.datasource, "datasource", DEFAULT_DATASOURCE),
    host: hostOf(options?.host),
    listPipe: resourceOf(options?.listPipe, "listPipe", DEFAULT_LIST_PIPE),
    presentPipe: resourceOf(options?.presentPipe, "presentPipe", DEFAULT_PRESENT_PIPE),
    timeoutMs,
    token: tokenOf(options?.token),
  };
}

/**
 * Replace the token wherever it appears in a string.
 *
 * The sink never writes the token into a message itself. This is for the text it
 * does not control: a Tinybird error body, a proxy's HTML error page, a stack
 * trace from a fetch implementation. Any of those can quote what was sent, and
 * every one of them is on its way to a log.
 */
export function redactToken(message: string, token: string): string {
  return token === "" ? message : message.split(token).join("[redacted]");
}
