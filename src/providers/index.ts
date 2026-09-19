import type { AppConfig } from "../config";
import type { DestinationProvider, ProviderId } from "../provider-contract";
import { createTidalDestinationAdapter } from "./tidal-adapter";

/** Resolves only built-in, explicitly supported providers. No dynamic loading. */
export function destinationProviderFor(
  providerId: ProviderId,
  config: AppConfig,
): DestinationProvider {
  if (providerId === "tidal") return createTidalDestinationAdapter(config);
  throw new Error(
    `Provider "${providerId}" is not configured in this installation. No provider write was made.`,
  );
}
