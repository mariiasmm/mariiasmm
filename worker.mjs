import { httpServerHandler } from 'cloudflare:node';

// Load Express only after the first Worker request supplies its runtime bindings.
// Wrangler prints configured bindings during deployment, but Cloudflare exposes
// their runtime values to the fetch handler. Deferring server.js also ensures its
// D1/R2/Assets setup sees those values before the CommonJS module is evaluated.
const port = 3000;
let serverReady;

async function initializeServer(env) {
  globalThis.__FP_CF_ENV = env;

  const serverModule = await import('./server.js');
  const app = serverModule.app || serverModule.default?.app;
  if (!app) throw new Error('Could not load the Express application.');

  app.listen(port);
  return httpServerHandler({ port });
}

export default {
  async fetch(request, env, ctx) {
    if (!serverReady) {
      serverReady = initializeServer(env).catch((error) => {
        // Let a later request retry initialization if the first attempt failed.
        serverReady = undefined;
        throw error;
      });
    }

    const handler = await serverReady;
    if (typeof handler?.fetch !== 'function') {
      throw new Error('Cloudflare HTTP handler does not expose a fetch method.');
    }
    return handler.fetch(request, env, ctx);
  },
};