import { Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";
import App, { DraftsPage, SearchRoute, SettingsRoute } from "./App";
import { inboxRoutes } from "./mail-routes";
import { prepareReplicaStorage } from "./replica-session";
import { registerShellWorker } from "./service-worker";
import { readShellMetadata } from "./shell-metadata";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 15000, retry: 1, reconcile: "id" },
  },
});
void prepareReplicaStorage(Boolean(readShellMetadata()));
const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
render(
  () => (
    <QueryClientProvider client={queryClient}>
      <Router root={App} preload={false} explicitLinks>
        {[
          ...inboxRoutes,
          { path: "/search", component: SearchRoute },
          { path: "/drafts", component: DraftsPage },
          { path: "/settings", component: SettingsRoute },
        ]}
      </Router>
    </QueryClientProvider>
  ),
  root,
);
if (import.meta.env.PROD) {
  if (document.readyState === "complete") void registerShellWorker();
  else window.addEventListener("load", () => void registerShellWorker(), { once: true });
}
