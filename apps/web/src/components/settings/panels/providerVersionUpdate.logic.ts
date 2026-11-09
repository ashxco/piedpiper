import type { ProviderKind, ServerProvider } from "@piedpiper/contracts";

export interface ProviderVersionUpdate {
  readonly latestVersion: string;
  /** Null when only the installer the user chose can update it. */
  readonly updateCommand: string | null;
}

/** The update to mention on a provider card; a current or unknown version mentions nothing. */
export function getProviderVersionUpdate(
  provider: ServerProvider | undefined,
): ProviderVersionUpdate | null {
  const advisory = provider?.versionAdvisory;
  if (advisory?.status !== "behind_latest" || !advisory.latestVersion) return null;
  return { latestVersion: advisory.latestVersion, updateCommand: advisory.updateCommand };
}

/** Updates for providers with no settings card, which would otherwise never be shown. */
export function getUpdatesWithoutCard(
  providers: ReadonlyArray<ServerProvider>,
  providersWithCard: ReadonlyArray<ProviderKind>,
): ReadonlyArray<{ readonly provider: ProviderKind; readonly update: ProviderVersionUpdate }> {
  return providers.flatMap((candidate) => {
    if (providersWithCard.includes(candidate.provider)) return [];
    const update = getProviderVersionUpdate(candidate);
    return update ? [{ provider: candidate.provider, update }] : [];
  });
}
