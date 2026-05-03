import { trpc } from "@/lib/trpc";
import { bootstrapInternalAuth, authHeaders } from "@/lib/internalAuth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Query Error]", event.query.state.error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Mutation Error]", event.mutation.state.error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({
        url: "/api/trpc",
        transformer: superjson,
      }),
      false: httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        // B1-followup — every /api/trpc/* call carries X-Internal-Token
        // alongside the existing credentials cookie. The token comes
        // from the bootstrap fetch in main() below.
        fetch(input, init) {
          const initHeaders = (init?.headers ?? {}) as Record<string, string>;
          return globalThis.fetch(input, {
            ...(init ?? {}),
            credentials: "include",
            headers: { ...initHeaders, ...authHeaders() },
          });
        },
      }),
    }),
  ],
});

const analyticsEndpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT;
const analyticsWebsiteId = import.meta.env.VITE_ANALYTICS_WEBSITE_ID;
if (analyticsEndpoint && analyticsWebsiteId) {
  const s = document.createElement("script");
  s.defer = true;
  s.src = `${analyticsEndpoint}/umami`;
  s.dataset.websiteId = analyticsWebsiteId;
  document.body.appendChild(s);
}

// B1-followup — fetch the X-Internal-Token from the loopback-only
// bootstrap endpoint BEFORE React renders. We swallow failures to a
// warning + empty token (warn-only fallback); enforcement-on without a
// reachable bootstrap would just produce 401s that surface immediately
// in the UI.
async function main() {
  await bootstrapInternalAuth();
  createRoot(document.getElementById("root")!).render(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

void main();
