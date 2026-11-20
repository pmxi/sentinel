import { createMemoryHistory, MemoryRouter, useLocation, useParams } from "@solidjs/router";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";
import { inboxRoutes } from "./mail-routes";

vi.mock("./App", () => ({
  InboxRoute: () => {
    const location = useLocation();
    const params = useParams();
    return `${location.pathname}|${params.view ?? "inbox"}`;
  },
}));

describe("mail routes", () => {
  it.each(["/", "/missing", "/inbox/unknown", "/inbox/l1", "/inbox/l2", "/inbox/l3"])(
    "redirects %s to Inbox",
    async (path) => {
      const history = createMemoryHistory();
      history.set({ value: path, replace: true, scroll: false });
      const container = document.createElement("div");
      const dispose = render(
        () => createComponent(MemoryRouter, { history, children: inboxRoutes }),
        container,
      );
      try {
        await vi.waitFor(() => expect(container.textContent).toBe("/inbox|inbox"));
      } finally {
        dispose();
      }
    },
  );

  it.each(["/inbox", "/inbox/all", "/inbox/sent", "/inbox/trash", "/inbox/unclassified"])(
    "keeps %s directly accessible",
    async (path) => {
      const history = createMemoryHistory();
      history.set({ value: path, replace: true, scroll: false });
      const container = document.createElement("div");
      const dispose = render(
        () => createComponent(MemoryRouter, { history, children: inboxRoutes }),
        container,
      );
      try {
        await vi.waitFor(() =>
          expect(container.textContent).toBe(`${path}|${path.split("/")[2] ?? "inbox"}`),
        );
      } finally {
        dispose();
      }
    },
  );
});
