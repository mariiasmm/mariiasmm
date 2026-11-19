import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';

// Express uses Cloudflare D1 and R2 for persistent storage.
globalThis.__FP_CF_ENV = env;
const serverModule = await import('./server.js');
const app = serverModule.app || serverModule.default?.app;

if (!app) throw new Error('Could not load the Express application.');

const port = Number(env.EXPRESS_PORT) || 3000;
app.listen(port);
export default httpServerHandler({ port });

