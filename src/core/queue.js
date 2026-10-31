// The background worker. Games enqueue moves and keep playing; the queue runs
// them one at a time per chore (so two moves never race on the same files or
// mailbox) and reports progress on the event bus.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class JobQueue extends EventEmitter {
  constructor() {
    super();
    this.lanes = new Map(); // chore id -> Promise tail
    this.jobs = new Map();
  }

  enqueue(chore, label, run) {
    const job = { id: randomUUID(), chore, label, status: 'queued', queuedAt: Date.now() };
    this.jobs.set(job.id, job);
    this.emit('job', { ...job });

    const tail = this.lanes.get(chore) ?? Promise.resolve();
    const next = tail.then(async () => {
      job.status = 'running';
      job.startedAt = Date.now();
      this.emit('job', { ...job });
      try {
        job.result = await run();
        job.status = 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
      }
      job.finishedAt = Date.now();
      this.emit('job', { ...job });
      this.trim();
    });
    this.lanes.set(chore, next);
    return job;
  }

  pending() {
    return [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
  }

  async drain() {
    await Promise.all([...this.lanes.values()]);
  }

  trim() {
    if (this.jobs.size < 500) return;
    for (const [id, job] of this.jobs) {
      if (job.status === 'done' || job.status === 'failed') this.jobs.delete(id);
      if (this.jobs.size < 250) break;
    }
  }
}
