/** A reply from the SAM worker: progress for, or the result of, call `id`. */
export interface WorkerReply {
  id: number;
  type: string;
  /** Present on `type: 'progress'` replies. */
  fraction?: number;
  /** Present on `type: 'error'` replies. */
  error?: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (reply: WorkerReply) => void;
  reject: (err: Error) => void;
  onProgress?: (fraction: number) => void;
}

/**
 * Request/response bookkeeping for a worker RPC: each call gets an id and a
 * promise that its reply settles. Every exit path (dispose, a worker crash)
 * must {@link rejectAll}, or awaiting callers never reach their `finally` and a
 * tool's busy flag sticks forever (RT-8).
 */
export class PendingCalls {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  /** Calls still awaiting a reply. */
  get size(): number {
    return this.pending.size;
  }

  /** Register a new call; post the message with the returned id. */
  open(onProgress?: (fraction: number) => void): { id: number; promise: Promise<WorkerReply> } {
    const id = ++this.seq;
    const promise = new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    });
    return { id, promise };
  }

  /** Route a worker reply to its call: progress, error or result. */
  handle(reply: WorkerReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    if (reply.type === 'progress') {
      p.onProgress?.(reply.fraction ?? 0);
      return;
    }
    this.pending.delete(reply.id);
    if (reply.type === 'error') p.reject(new Error(reply.error ?? 'SAM worker error.'));
    else p.resolve(reply);
  }

  /** Reject every pending call with `err` and forget them. */
  rejectAll(err: Error): void {
    const calls = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of calls) p.reject(err);
  }
}
