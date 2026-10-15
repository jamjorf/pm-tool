import type { FastifyInstance } from 'fastify';
import { dispatchPendingWebhooks } from './webhooks/dispatcher.js';
import { processNotificationDeliveries } from './notifications/worker.js';
import { runDueSoon } from './notifications/due-soon.js';
import { pokeBus } from './sync/poke.js';

export interface Workers { stop(): Promise<void>; runOnce(): Promise<void> }

/** Background loops: webhooks every 5s, notification deliveries every 30s, due_soon hourly. */
export function startWorkers(app: FastifyInstance): Workers {
  let stopped = false;
  const running = new Set<Promise<unknown>>();
  const guard = (name: string, fn: () => Promise<unknown>) => async () => {
    if (stopped) return;
    const p = fn().catch((e) => app.log.error({ err: e }, `${name} worker failed`));
    running.add(p);
    await p;
    running.delete(p);
  };
  const webhooks = guard('webhooks', () => dispatchPendingWebhooks(app.db, app.log));
  const deliveries = guard('notification-deliveries', () => processNotificationDeliveries(app, app.integrations ?? null));
  const dueSoon = guard('due_soon', async () => {
    const n = await runDueSoon(app.db, app.log);
    if (n) pokeBus.poke(0);
  });
  const timers = [setInterval(webhooks, 5_000), setInterval(deliveries, 30_000), setInterval(dueSoon, 3_600_000)];
  for (const t of timers) t.unref();
  setTimeout(dueSoon, 5_000).unref();
  return {
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      await Promise.allSettled([...running]);
    },
    async runOnce() {
      await webhooks();
      await deliveries();
    },
  };
}
