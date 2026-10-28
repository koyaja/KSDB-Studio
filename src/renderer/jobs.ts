// Suivi des tâches longues (export, import, sauvegarde, restauration).
import type { JobEvent } from '../shared/types';

type Handler = (ev: JobEvent) => void;
const handlers = new Map<string, Handler>();
const early = new Map<string, JobEvent[]>();
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  window.ksdb.onJob((ev) => {
    const h = handlers.get(ev.jobId);
    if (h) h(ev);
    else early.set(ev.jobId, [...(early.get(ev.jobId) ?? []), ev]);
    if (ev.kind === 'done' || ev.kind === 'error') handlers.delete(ev.jobId);
  });
}

/** Démarre une tâche et suit ses événements jusqu'à la fin. */
export function trackJob(
  start: Promise<string>,
  onEvent: Handler,
): { jobId: Promise<string>; done: Promise<string> } {
  wire();
  let resolveDone!: (m: string) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<string>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const jobId = start.then((id) => {
    const h: Handler = (ev) => {
      onEvent(ev);
      if (ev.kind === 'done') resolveDone(ev.message ?? 'Terminé');
      if (ev.kind === 'error') rejectDone(new Error(ev.message));
    };
    handlers.set(id, h);
    for (const ev of early.get(id) ?? []) h(ev);
    early.delete(id);
    return id;
  });
  jobId.catch((e) => rejectDone(e));
  return { jobId, done };
}
