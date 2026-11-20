import { REPLICA_SESSION_KEY } from "./replica-types";

export const REPLICA_RESET_EVENT = "sent:replica:reset";
export const REPLICA_CHANNEL = "sent:replica:sessions";
export const REPLICA_REVOKED_KEY = "sent:replica:revoked:v1";
const pendingWipes = new Set<Promise<unknown>>();
let startupCleanup = Promise.resolve();
function forgetIdentity(id: string) {
  try {
    if (localStorage.getItem(REPLICA_SESSION_KEY) === id)
      localStorage.removeItem(REPLICA_SESSION_KEY);
    if (localStorage.getItem(REPLICA_REVOKED_KEY) === id)
      localStorage.removeItem(REPLICA_REVOKED_KEY);
  } catch {}
}
export async function wipeReplicaDirectory(id: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`.sent-mailbox-${id}`, { recursive: true });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      if (!(error instanceof DOMException)) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error("Private replica cleanup is still pending");
}
export function prepareReplicaStorage(hasLiveSession: boolean) {
  let id: string | null = null,
    revoked: string | null = null;
  try {
    id = localStorage.getItem(REPLICA_SESSION_KEY);
    revoked = localStorage.getItem(REPLICA_REVOKED_KEY);
    if (id && !hasLiveSession) localStorage.setItem(REPLICA_REVOKED_KEY, id);
  } catch {}
  const live = hasLiveSession && id !== revoked ? id : null;
  startupCleanup = (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = root as FileSystemDirectoryHandle & {
        keys(): AsyncIterableIterator<string>;
      };
      for await (const name of directory.keys()) {
        if (!name.startsWith(".sent-mailbox-") || name === `.sent-mailbox-${live}`) continue;
        const stale = name.slice(".sent-mailbox-".length);
        await wipeReplicaDirectory(stale);
        forgetIdentity(stale);
      }
      if (id && id !== live) {
        await wipeReplicaDirectory(id);
        forgetIdentity(id);
      }
    } catch {}
  })();
  return startupCleanup;
}
export const replicaStorageReady = () => startupCleanup;
export async function waitForReplicaWipe(wipe: Promise<unknown>, timeout = 2000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      wipe,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function endReplicaSession() {
  const pending: Promise<unknown>[] = [];
  let id: string | null = null;
  try {
    id = localStorage.getItem(REPLICA_SESSION_KEY);
    if (id) localStorage.setItem(REPLICA_REVOKED_KEY, id);
  } catch {}
  window.dispatchEvent(new CustomEvent(REPLICA_RESET_EVENT, { detail: { id, pending } }));
  const wipe = Promise.allSettled(pending).then(async () => {
    if (id) {
      await wipeReplicaDirectory(id);
      forgetIdentity(id);
    }
  });
  pendingWipes.add(wipe);
  const done = () => pendingWipes.delete(wipe);
  void wipe.then(done, done);
  if (id)
    try {
      const channel = new BroadcastChannel(REPLICA_CHANNEL);
      channel.postMessage({ id });
      channel.close();
    } catch {}
  return Promise.allSettled([...pendingWipes]).then(() => {});
}
