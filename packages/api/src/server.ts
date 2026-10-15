import { buildApp } from './app.js';
import { startWorkers } from './workers.js';

const app = await buildApp();
const { PORT, HOST, WORKERS } = app.config;
const workers = WORKERS ? startWorkers(app) : null;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await workers?.stop();
    await app.close();
    process.exit(0);
  } catch (e) {
    app.log.error({ err: e }, 'shutdown failed');
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ url: `http://${HOST}:${PORT}`, workers: !!workers, authMode: app.config.AUTH_MODE }, 'pm-tool api listening');
} catch (e) {
  app.log.error({ err: e }, 'failed to start');
  process.exit(1);
}
