import { httpServerHandler } from 'cloudflare:node';

// Load Express only after the first Worker request supplies its runtime bindings.
// Wrangler prints configured bindings during deployment, but Cloudflare exposes
// their runtime values to the fetch handler. Deferring server.js also ensures its
// D1/R2/Assets setup sees those values before the CommonJS module is evaluated.
const port = 3000;
let serverReady;
const mediaFormats = {
  jpg: { type: 'image', contentType: 'image/jpeg' },
  png: { type: 'image', contentType: 'image/png' },
  webp: { type: 'image', contentType: 'image/webp' },
  mp4: { type: 'video', contentType: 'video/mp4' },
  mov: { type: 'video', contentType: 'video/quicktime' },
  webm: { type: 'video', contentType: 'video/webm' },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readMediaTicket(token, secret) {
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, decodeBase64Url(signature), new TextEncoder().encode(encoded))) return null;
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
  } catch { return null; }
}

function startsAt(header, offset, ...bytes) {
  return bytes.every((byte, index) => header[offset + index] === byte);
}

function validMediaHeader(ticket, header) {
  const starts = (...bytes) => bytes.every((byte, index) => header[index] === byte);
  if (ticket.ext === 'jpg') return starts(0xff, 0xd8, 0xff);
  if (ticket.ext === 'png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (ticket.ext === 'webp') return starts(0x52, 0x49, 0x46, 0x46) && startsAt(header, 8, 0x57, 0x45, 0x42, 0x50);
  if (ticket.ext === 'webm') return starts(0x1a, 0x45, 0xdf, 0xa3);
  if (ticket.ext === 'mp4' || ticket.ext === 'mov') {
    if (!startsAt(header, 4, 0x66, 0x74, 0x79, 0x70)) return false;
    const brand = String.fromCharCode(...header.slice(8, 12));
    if (['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B '].includes(brand)) return false;
    return ticket.ext === (brand === 'qt  ' ? 'mov' : 'mp4');
  }
  return false;
}

function validateMediaStream(stream, ticket) {
  let prefix = new Uint8Array(0);
  let checked = false;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (checked) {
        controller.enqueue(chunk);
        return;
      }
      const combined = new Uint8Array(prefix.length + chunk.length);
      combined.set(prefix);
      combined.set(chunk, prefix.length);
      if (combined.length < 12) {
        prefix = combined;
        return;
      }
      if (!validMediaHeader(ticket, combined.subarray(0, 12))) throw new Error('Формат медиафайла не совпадает с выбранным.');
      checked = true;
      controller.enqueue(combined);
      prefix = new Uint8Array(0);
    },
    flush(controller) {
      if (!checked) {
        if (prefix.length < 12 || !validMediaHeader(ticket, prefix)) throw new Error('Файл слишком мал или имеет неподдерживаемый формат.');
        controller.enqueue(prefix);
      }
    },
  }));
}

async function handleMediaUpload(request, env) {
  if (!env.MEDIA || !env.SESSION_SECRET) return jsonResponse({ error: 'Потоковая загрузка не настроена.' }, 503);
  if (request.method !== 'PUT' && request.method !== 'DELETE') return jsonResponse({ error: 'Метод не поддерживается.' }, 405);
  const ticket = await readMediaTicket(request.headers.get('X-Media-Ticket'), env.SESSION_SECRET);
  if (!ticket) return jsonResponse({ error: 'Ссылка на загрузку недействительна.' }, 401);
  const format = mediaFormats[ticket.ext];
  const sizeLimit = ticket.type === 'video' ? 70 * 1024 * 1024 : 12 * 1024 * 1024;
  const fileMatch = /^([a-zA-Z0-9_-]+)\/([a-f0-9]{24})\.(jpg|png|webp|mp4|mov|webm)$/.exec(String(ticket.key || ''));
  if (!format || ticket.type !== format.type || ticket.contentType !== format.contentType
      || !Number.isSafeInteger(ticket.size) || ticket.size < 1 || ticket.size > sizeLimit
      || !fileMatch || fileMatch[1] !== ticket.projectId
      || ticket.src !== '/uploads/' + ticket.key
      || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt < Date.now()) {
    return jsonResponse({ error: 'Параметры загрузки недействительны или срок ссылки истёк.' }, 400);
  }
  if (request.method === 'DELETE') {
    await env.MEDIA.delete(ticket.key);
    return jsonResponse({ ok: true });
  }
  if (!request.body) return jsonResponse({ error: 'Файл загрузился пустым.' }, 400);
  const contentType = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== ticket.contentType) return jsonResponse({ error: 'Тип файла не совпадает с выбранным.' }, 400);
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== ticket.size) {
    return jsonResponse({ error: 'Размер файла изменился во время загрузки.' }, 400);
  }
  const fixedLength = new FixedLengthStream(ticket.size);
  const pump = validateMediaStream(request.body, ticket).pipeTo(fixedLength.writable);
  try {
    const object = await env.MEDIA.put(ticket.key, fixedLength.readable, {
      httpMetadata: { contentType: ticket.contentType },
    });
    await pump;
    if (!object) throw new Error('R2 не сохранил файл.');
    return jsonResponse({ type: ticket.type, src: ticket.src, ...(ticket.type === 'video' ? { contentType: ticket.contentType } : {}) }, 201);
  } catch (error) {
    await env.MEDIA.delete(ticket.key).catch(() => {});
    console.error('[media-stream] upload failed:', error);
    return jsonResponse({ error: error.message.includes('формат') || error.message.includes('мал')
      ? error.message : 'Не удалось сохранить медиафайл.' }, 400);
  }
}



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
    if (new URL(request.url).pathname === '/api/media-upload') return handleMediaUpload(request, env);
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