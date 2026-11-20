import { Navigate, type RouteDefinition } from "@solidjs/router";
import { InboxRoute } from "./App";

export const inboxRoutes: RouteDefinition[] = [
  { path: "/", component: () => <Navigate href="/inbox" /> },
  { path: "/inbox", component: InboxRoute },
  ...["l1", "l2", "l3"].map((view) => ({
    path: `/inbox/${view}`,
    component: () => <Navigate href="/inbox" />,
  })),
  {
    path: "/inbox/:view",
    matchFilters: { view: ["all", "sent", "trash", "unclassified"] },
    component: InboxRoute,
  },
  { path: "*", component: () => <Navigate href="/inbox" /> },
];
