/* Standalone outbox worker (the API also runs one in-process unless RUN_WORKER=0). */
import 'reflect-metadata';
import { createApp } from '../main';
import { OutboxWorker } from '../outbox/outbox.worker';

async function main() {
  const app = await createApp();
  await app.init();
  app.get(OutboxWorker).start(1000);
  console.log('outbox worker running');
}
void main();
