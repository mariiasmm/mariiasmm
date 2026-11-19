import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';

// Express uses Cloudflare D1 and R2 for persistent storage.
globalThis.__FP_CF_ENV = env;
const serverModule = await import('./server.js');
const app = serverModule.app || serverModule.default?.app;

if (!app) throw new Error('Could not load the Express application.');

app.listen(3000);
export default httpServerHandler({ port: 3000 });

