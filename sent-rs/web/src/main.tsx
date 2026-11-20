import { Navigate, Route, Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";
import App, { DraftsPage, InboxRoute, SearchRoute, SettingsRoute } from "./App";
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
        <Route path="/" component={() => <Navigate href="/inbox/l1" />} />
        <Route path="/inbox/:view" component={InboxRoute} />
        <Route path="/search" component={SearchRoute} />
        <Route path="/drafts" component={DraftsPage} />
        <Route path="/settings" component={SettingsRoute} />
        <Route path="*" component={() => <Navigate href="/inbox/l1" />} />
      </Router>
    </QueryClientProvider>
  ),
  root,
);
if (import.meta.env.PROD) {
  if (document.readyState === "complete") void registerShellWorker();
  else window.addEventListener("load", () => void registerShellWorker(), { once: true });
}
