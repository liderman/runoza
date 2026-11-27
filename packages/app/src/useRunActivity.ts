import { useQuery } from "@tanstack/react-query";
import type { IdentityClient } from "@runoza/api-client";
import type { ChatRun, CodeActivity } from "@runoza/contracts";

/** All surfaces share one query, including individual transcript tool renderers. */
export function useRunActivity(
  api: IdentityClient,
  run: ChatRun,
  enabled = true,
) {
  const active = run.status === "queued" || run.status === "running";
  return useQuery({
    queryKey: ["run-activity", run.id, run.status],
    queryFn: ({ signal }) =>
      api.request<CodeActivity>(
        "/runs/" + run.id + "/activity",
        "GET",
        undefined,
        {
          signal,
        },
      ),
    enabled,
    refetchInterval: enabled && active ? 1000 : false,
    staleTime: 500,
  });
}
