export const RECENT_BODY_DAYS = 90;

export function recentBodyCutoff(now = Date.now()) {
  return new Date(now - RECENT_BODY_DAYS * 86400000).toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
}

export function recentBody(receivedAt: string, now = Date.now()) {
  return Date.parse(receivedAt) >= now - RECENT_BODY_DAYS * 86400000;
}
