import { createMemoryHistory, MemoryRouter, Router, useLocation, useParams } from "@solidjs/router";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";
import { inboxRoutes } from "./mail-routes";
import { useReaderSelection } from "./router";

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

function readerHistory(previous: string, current: string) {
  window.history.replaceState(null, "", previous);
  window.history.pushState(null, "", current);
  let selection!: ReturnType<typeof useReaderSelection>;
  let route!: ReturnType<typeof useLocation>;
  function Harness() {
    selection = useReaderSelection();
    route = useLocation();
    return null;
  }
  const dispose = render(
    () => createComponent(Router, { children: { path: "*", component: Harness } }),
    document.createElement("div"),
  );
  const at = (href: string) =>
    vi.waitFor(() => expect(route.pathname + route.search + route.hash).toBe(href));
  return { at, selection, dispose };
}

describe("reader history", () => {
  it.each([
    ["/inbox/all?account=account", "&"],
    ["/search?q=two+words", "&"],
    ["/inbox", "?"],
  ])("goes back to %s without leaving a dismissed reader behind", async (list, delimiter) => {
    const prior = "/inbox/sent";
    const { at, selection, dispose } = readerHistory(prior, list);
    try {
      const before = window.history.length;
      selection.select("first");
      await at(`${list}${delimiter}message=first`);
      await vi.waitFor(() => expect(window.history.length).toBe(before + 1));
      selection.select("second");
      await at(`${list}${delimiter}message=second`);
      expect(window.history.length).toBe(before + 1);
      selection.close();
      await at(list);
      window.history.back();
      await at(prior);
    } finally {
      dispose();
    }
  });

  it("replaces a direct reader link rather than going back to an unrelated view", async () => {
    const prior = "/inbox/sent";
    const list = "/search?q=two+words";
    const { at, selection, dispose } = readerHistory(prior, `${list}&message=first#mail`);
    try {
      const before = window.history.length;
      selection.close();
      await at(`${list}#mail`);
      expect(window.history.length).toBe(before);
      window.history.back();
      await at(prior);
    } finally {
      dispose();
    }
  });
});
