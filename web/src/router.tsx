import { A, useNavigate as solidNavigate, useLocation } from "@solidjs/router";
import type { Accessor, JSX } from "solid-js";

export { Navigate, useLocation, useParams } from "@solidjs/router";
export const Link = A;
export function NavLink(props: { href: string; children: JSX.Element }) {
  return (
    <A href={props.href} end activeClass="active" inactiveClass="">
      {props.children}
    </A>
  );
}
export function useNavigate() {
  const navigate = solidNavigate();
  return (
    to:
      | string
      | {
          pathname: string;
          search: string;
        },
    options?: {
      replace?: boolean;
    },
  ) => navigate(typeof to === "string" ? to : `${to.pathname}?${to.search}`, options);
}
type SearchOptions = { replace?: boolean; state?: unknown };
function searchHref(location: { pathname: string; hash: string }, params: URLSearchParams) {
  return `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`;
}
export function useSearchParams(): [
  Accessor<URLSearchParams>,
  (value: URLSearchParams, options?: SearchOptions) => void,
] {
  const location = useLocation();
  const navigate = solidNavigate();
  const read = () => new URLSearchParams(location.search);
  return [
    read,
    (params, options) => {
      // Query-only transitions retain the current surface. In particular,
      // don't overwrite the mailbox's mobile reader/back scroll restoration.
      navigate(searchHref(location, params), { ...options, scroll: false });
    },
  ];
}

export function useReaderSelection() {
  const location = useLocation<{ sentReaderList?: string }>();
  const navigate = solidNavigate();
  const [read, write] = useSearchParams();
  return {
    select(id: string) {
      const params = read();
      const current = params.get("message");
      if (current === id) return;
      params.delete("message");
      const state = current ? location.state : { sentReaderList: searchHref(location, params) };
      params.set("message", id);
      write(params, { replace: Boolean(current), state });
    },
    close() {
      const params = read();
      if (!params.has("message")) return;
      params.delete("message");
      if (location.state?.sentReaderList === searchHref(location, params)) navigate(-1);
      else write(params, { replace: true });
    },
  };
}
