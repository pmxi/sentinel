import { createMemoryHistory, MemoryRouter, useLocation, useParams } from "@solidjs/router";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";
import { inboxRoutes } from "./mail-routes";

vi.mock("./App", () => ({
  InboxRoute: () => {
    const location = useLocation();
    const params = useParams();
    return `${location.pathname}${location.search}${location.hash}|${params.view ?? "inbox"}`;
  },
}));

describe("mail routes", () => {
  it.each([
    "/",
    "/missing",
    "/inbox/unknown",
    "/inbox/l1",
    "/inbox/l2",
    "/inbox/l3",
    "/inbox/unclassified",
  ])("redirects %s to Inbox", async (path) => {
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
  });

  it.each([
    "/",
    "/missing",
    "/inbox/unknown",
    "/inbox/l1",
    "/inbox/l2",
    "/inbox/l3",
    "/inbox/unclassified",
  ])("preserves search parameters and hash when redirecting %s", async (path) => {
    const suffix = "?message=thread%2F123&account=account%2B1#conversation";
    const history = createMemoryHistory();
    history.set({ value: path + suffix, replace: true, scroll: false });
    const container = document.createElement("div");
    const dispose = render(
      () => createComponent(MemoryRouter, { history, children: inboxRoutes }),
      container,
    );
    try {
      await vi.waitFor(() => expect(container.textContent).toBe(`/inbox${suffix}|inbox`));
    } finally {
      dispose();
    }
  });

  it.each(["/inbox", "/inbox/all", "/inbox/sent", "/inbox/trash"])(
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
