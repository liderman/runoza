import { ConversationDraftProvider } from "./conversation-drafts.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
export function createDataClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 10000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
// Mount with an authentication-scope key. No cache persistence across accounts.
export function AppDataProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createDataClient);
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <ConversationDraftProvider>{children}</ConversationDraftProvider>
    </QueryClientProvider>
  );
}

// Root navigation observers survive login, so their keys must include scope.
// Page observers instead live inside a keyed AppDataProvider and get a new client.
export function useScopedDataClient(scope: string) {
  const [client] = useState(createDataClient);
  useEffect(
    () => () => {
      const predicate = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] === scope;
      void client.cancelQueries({ predicate });
      client.removeQueries({ predicate });
    },
    [client, scope],
  );
  return client;
}
