export type Priority = "visible" | "background";

export interface PendingRequest {
  promise: Promise<() => void>;
  promote(): void;
  cancel(): void;
}

export interface Scheduler {
  acquire(priority: Priority): PendingRequest;
}

export function createImagePreloadScheduler(maxConcurrent: number, backgroundMaxConcurrent = maxConcurrent - 1): Scheduler {
  let activeVisible = 0;
  let activeBackground = 0;
  const waiting: Array<{ priority: Priority; grant: () => void }> = [];

  function tryGrantNext(): void {
    for (let i = 0; i < waiting.length; i++) {
      if (waiting[i]!.priority !== "visible") continue;
      if (activeVisible + activeBackground >= maxConcurrent) continue;
      const [w] = waiting.splice(i, 1);
      w!.grant();
      return tryGrantNext();
    }
    for (let i = 0; i < waiting.length; i++) {
      if (waiting[i]!.priority !== "background") continue;
      if (activeVisible + activeBackground >= maxConcurrent) continue;
      if (activeBackground >= backgroundMaxConcurrent) continue;
      const [w] = waiting.splice(i, 1);
      w!.grant();
      return tryGrantNext();
    }
  }

  function acquire(priority: Priority): PendingRequest {
    let entry: { priority: Priority; grant: () => void } | null = null;
    let grantedAs: Priority = priority;
    const promise = new Promise<() => void>((resolve) => {
      const grant = () => {
        grantedAs = entry ? entry.priority : priority;
        if (grantedAs === "visible") activeVisible += 1; else activeBackground += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          if (grantedAs === "visible") activeVisible -= 1; else activeBackground -= 1;
          tryGrantNext();
        });
      };
      const total = activeVisible + activeBackground;
      const fits = priority === "visible" ? total < maxConcurrent : (total < maxConcurrent && activeBackground < backgroundMaxConcurrent);
      if (fits) grant(); else { entry = { priority, grant }; waiting.push(entry); }
    });
    return {
      promise,
      // Promoting a queued entry must attempt an immediate drain — otherwise a slot that's
      // already free leaves the newly-visible request stuck until another scheduler event.
      promote() { if (entry) { entry.priority = "visible"; tryGrantNext(); } },
      cancel() {
        if (!entry) return;
        const i = waiting.indexOf(entry);
        if (i !== -1) waiting.splice(i, 1);
      },
    };
  }

  return { acquire };
}

export const gridImageScheduler = createImagePreloadScheduler(4);
