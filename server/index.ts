import { buildServer } from './app.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? '4322');

async function start() {
  const app = buildServer({ serveStatic: process.env.NODE_ENV === 'production' });

  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
