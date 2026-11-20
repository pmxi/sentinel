import { REPLICA_SESSION_KEY } from "./replica-types";

export const REPLICA_RESET_EVENT = "sent:replica:reset";
export const REPLICA_CHANNEL = "sent:replica:sessions";
export async function wipeReplicaDirectory(id: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`.sent-mailbox-${id}`, { recursive: true });
      return;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name === "NotFoundError") return;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
export function endReplicaSession() {
  let id: string | null = null;
  try {
    id = localStorage.getItem(REPLICA_SESSION_KEY);
    localStorage.removeItem(REPLICA_SESSION_KEY);
  } catch {}
  window.dispatchEvent(new CustomEvent(REPLICA_RESET_EVENT, { detail: { id } }));
  if (id) void wipeReplicaDirectory(id);
  if (id)
    try {
      const channel = new BroadcastChannel(REPLICA_CHANNEL);
      channel.postMessage({ id });
      channel.close();
    } catch {}
}
