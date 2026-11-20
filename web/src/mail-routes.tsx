import { Navigate, type RouteDefinition, useLocation } from "@solidjs/router";
import { InboxRoute } from "./App";

function InboxRedirect() {
  const location = useLocation();
  return <Navigate href={`/inbox${location.search}${location.hash}`} />;
}

export const inboxRoutes: RouteDefinition[] = [
  { path: "/", component: InboxRedirect },
  { path: "/inbox", component: InboxRoute },
  ...["l1", "l2", "l3", "unclassified"].map((view) => ({
    path: `/inbox/${view}`,
    component: InboxRedirect,
  })),
  {
    path: "/inbox/:view",
    matchFilters: { view: ["all", "sent", "trash"] },
    component: InboxRoute,
  },
  { path: "*", component: InboxRedirect },
];
