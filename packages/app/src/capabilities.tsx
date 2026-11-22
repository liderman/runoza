import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IdentityClient } from "@runoza/api-client";
export interface CapabilityResponse {
  flags: Record<string, boolean>;
  runtime?: {
    serverConfigured: boolean;
    serverReady: boolean;
    workerReady: boolean;
    desktopAvailable: boolean;
  };
}
export type CapabilityState = {
  runtime?: CapabilityResponse["runtime"];
  flags: Record<string, boolean>;
  loading: boolean;
  error: boolean;
};
export const CapabilitiesContext = createContext<CapabilityState | null>(null);
export function useCapabilities(api: IdentityClient) {
  const shared = useContext(CapabilitiesContext);
  const query = useQuery({
    queryKey: ["capabilities"],
    queryFn: ({ signal }) =>
      api.request<CapabilityResponse>("/features", "GET", undefined, {
        signal,
      }),
    enabled: !shared,
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  return (
    shared ?? {
      flags: query.data?.flags ?? {},
      runtime: query.data?.runtime,
      loading: query.isPending,
      error: query.isError,
    }
  );
}
