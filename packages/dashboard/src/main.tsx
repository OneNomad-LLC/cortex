import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import "./index.css";

/**
 * Single QueryClient for the whole SPA. Later phases will register
 * route-level loaders that read from `/api/dashboard/*` through this
 * client so we get caching + suspense + invalidation across pages.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cortex runs locally — failures are usually deterministic
      // (auth expired, network blip) and a single retry tends to mask
      // them. Surface the error to the UI instead.
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("dashboard root element missing");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
