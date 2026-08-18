import { ModuleProvider } from "@medusajs/framework/utils";
import { USAGE_MODULE } from "@zanreal/medusa-usage/modules/usage/module-name";
import TinybirdUsageSinkService, { TINYBIRD_USAGE_SINK } from "./service";

/**
 * The Tinybird usage sink, registered against the usage module.
 *
 * Name it in the plugin's `providers` option, the same way any Medusa module
 * provider is named:
 *
 *   plugins: [
 *     {
 *       resolve: "@zanreal/medusa-usage",
 *       options: {
 *         providers: [
 *           {
 *             resolve: "@zanreal/medusa-usage-tinybird",
 *             id: "tinybird",
 *             options: {
 *               host: process.env.TINYBIRD_HOST,
 *               token: process.env.TINYBIRD_TOKEN,
 *             },
 *           },
 *         ],
 *       },
 *     },
 *   ]
 *
 * The `id` is the host's, not this package's: it is what the plugin's `sink`
 * option selects on and what appears in every snapshot. Leave `providers` unset
 * and the plugin registers its built-in Postgres sink instead, which is why
 * installing this package is a decision rather than a side effect.
 *
 * `USAGE_MODULE` is imported from the plugin rather than written out as
 * "usage". The plugin keeps it in a file of its own precisely so a provider can
 * register against the same key the module registers under, and a second copy of
 * a string is a second thing that can drift.
 */
export default ModuleProvider(USAGE_MODULE, {
  services: [TinybirdUsageSinkService],
});

export { TINYBIRD_USAGE_SINK, TinybirdUsageSinkService };
export type {
  ResolvedTinybirdOptions,
  TinybirdUsageSinkOptions,
} from "./lib/options";
