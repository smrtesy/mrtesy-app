"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * App-wide TanStack Query client. Screens adopt it incrementally — the pilot
 * is the tasks desk (TaskList), which uses the cache to paint instantly on
 * re-mount and lets its existing fetch/realtime logic revalidate in the
 * background. gcTime keeps data for 30 minutes after the last unmount so
 * navigating away and back within a pane stays instant.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            gcTime: 30 * 60 * 1000,
            retry: 1,
            refetchOnWindowFocus: false, // screens keep their own focus/realtime refetch logic
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
