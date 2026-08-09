import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "sent_session";
const SESSION_ISSUER = "sent";

function secret(value: string): Uint8Array {
  if (value.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  return new TextEncoder().encode(value);
}

export async function createSessionToken(sessionSecret: string): Promise<string> {
  return new SignJWT({ role: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_ISSUER)
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret(sessionSecret));
}

export async function verifySessionToken(
  token: string | undefined,
  sessionSecret: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const verified = await jwtVerify(token, secret(sessionSecret), {
      issuer: SESSION_ISSUER,
      subject: "owner",
    });
    return verified.payload.role === "owner";
  } catch {
    return false;
  }
}

export async function createOAuthState(
  provider: "gmail" | "microsoft",
  sessionSecret: string,
): Promise<string> {
  return new SignJWT({ provider, purpose: "oauth-connect" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_ISSUER)
    .setAudience("oauth")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret(sessionSecret));
}

export async function verifyOAuthState(
  state: string,
  sessionSecret: string,
): Promise<"gmail" | "microsoft"> {
  const verified = await jwtVerify(state, secret(sessionSecret), {
    issuer: SESSION_ISSUER,
    audience: "oauth",
  });
  if (
    verified.payload.purpose !== "oauth-connect" ||
    !["gmail", "microsoft"].includes(String(verified.payload.provider))
  ) {
    throw new Error("Invalid OAuth state");
  }
  return verified.payload.provider as "gmail" | "microsoft";
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure });
}

export function bearerOrCookie(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.cookies[SESSION_COOKIE];
}
