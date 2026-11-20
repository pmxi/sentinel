import { A, useNavigate as solidNavigate, useLocation } from "@solidjs/router";
import type { Accessor, JSX } from "solid-js";

export { Navigate, useLocation, useParams } from "@solidjs/router";
export const Link = A;
export function NavLink(props: { href: string; children: JSX.Element }) {
  return (
    <A href={props.href} activeClass="active" inactiveClass="">
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
type SearchUpdate = URLSearchParams | ((current: URLSearchParams) => URLSearchParams);
export function useSearchParams(): [
  Accessor<URLSearchParams>,
  (
    value: SearchUpdate,
    options?: {
      replace?: boolean;
    },
  ) => void,
] {
  const location = useLocation();
  const navigate = solidNavigate();
  const read = () => new URLSearchParams(location.search);
  return [
    read,
    (value, options) => {
      const next = typeof value === "function" ? value(read()) : value;
      navigate(`${location.pathname}?${next}`, options);
    },
  ];
}
