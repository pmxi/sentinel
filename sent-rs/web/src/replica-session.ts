import { REPLICA_SESSION_KEY } from "./replica-types";

export const REPLICA_RESET_EVENT = "sent:replica:reset";
export const REPLICA_CHANNEL = "sent:replica:sessions";
const pendingWipes = new Set<Promise<unknown>>();
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
  const pending: Promise<unknown>[] = [];
  let id: string | null = null;
  try {
    id = localStorage.getItem(REPLICA_SESSION_KEY);
    localStorage.removeItem(REPLICA_SESSION_KEY);
  } catch {}
  window.dispatchEvent(new CustomEvent(REPLICA_RESET_EVENT, { detail: { id, pending } }));
  if (id) pending.push(wipeReplicaDirectory(id));
  for (const wipe of pending) {
    pendingWipes.add(wipe);
    const done = () => pendingWipes.delete(wipe);
    void wipe.then(done, done);
  }
  if (id)
    try {
      const channel = new BroadcastChannel(REPLICA_CHANNEL);
      channel.postMessage({ id });
      channel.close();
    } catch {}
  return Promise.allSettled([...pendingWipes]).then(() => {});
}
