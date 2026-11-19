'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

/* ───────────── настройки ───────────── */

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const cloudEnv = globalThis.__FP_CF_ENV || null;
const remoteDb = cloudEnv?.DB || null;
const mediaBucket = cloudEnv?.MEDIA || null;
if (cloudEnv && (!remoteDb || !mediaBucket || !cloudEnv.ASSETS)) {
  throw new Error('Для запуска Cloudflare задайте bindings DB, MEDIA и ASSETS в wrangler.jsonc.');
}

// Если задан ADMIN_PASSWORD — редактировать и видеть список проектов можно только после входа.
// Страницы проектов (/p/...) по ссылке всегда открываются в режиме просмотра.
const configuredPassword = cloudEnv?.ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
const configuredSecret = cloudEnv?.SESSION_SECRET ?? process.env.SESSION_SECRET;
const PASSWORD = configuredPassword || '';
const SECRET = configuredSecret || (cloudEnv
  ? crypto.randomBytes(32).toString('hex')
  : crypto.createHash('sha256').update('feed-preview:' + PASSWORD).digest('hex'));
if (cloudEnv && (!configuredPassword || !configuredSecret)) {
  throw new Error('Cloudflare Worker requires ADMIN_PASSWORD and SESSION_SECRET secrets.');
}

const MAX_UPLOAD = 12 * 1024 * 1024; // 12 МБ (фото обрезаются в браузере и обычно весят < 1 МБ)
const MAX_VIDEO_UPLOAD = 100 * 1024 * 1024;
const MAX_BACKUP_SIZE = 256 * 1024 * 1024;
const LIMITS = { projectName: 60, highlightTitle: 20, topic: 80, text: 5000 };

if (!mediaBucket) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ───────────── локальная база или Cloudflare D1 ───────────── */

let db = { projects: [] };
if (!remoteDb && fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    // не затираем повреждённый файл молча
    console.error(`Не удалось прочитать ${DB_FILE}: ${e.message}`);
    process.exit(1);
  }
}
if (!Array.isArray(db.projects)) db.projects = [];

let queue = Promise.resolve();
let remoteDbInitialized = false;
let restoreInProgress = false;
let backupInProgress = false;
let activeMutations = 0;
let mutationWaiters = [];
function waitForMutations() {
  if (!activeMutations) return Promise.resolve();
  return new Promise((resolve) => mutationWaiters.push(resolve));
}
function finishMutation() {
  activeMutations = Math.max(0, activeMutations - 1);
  if (!activeMutations) mutationWaiters.splice(0).forEach((resolve) => resolve());
}
function save() {
  const run = () => {
    if (remoteDb) {
      const statements = [
        remoteDb.prepare('DELETE FROM app_stories'),
        remoteDb.prepare('DELETE FROM app_posts'),
        remoteDb.prepare('DELETE FROM app_highlights'),
        remoteDb.prepare('DELETE FROM app_projects'),
      ];
      for (const [projectPosition, project] of db.projects.entries()) {
        const projectDocument = { id: project.id, slug: project.slug, name: project.name, createdAt: project.createdAt };
        statements.push(remoteDb.prepare(
          'INSERT INTO app_projects (id, slug, name, created_at, position, document) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(project.id, project.slug, project.name, project.createdAt, projectPosition, JSON.stringify(projectDocument)));
        for (const [position, post] of (project.posts || []).entries()) {
          statements.push(remoteDb.prepare(
            'INSERT INTO app_posts (id, project_id, position, document) VALUES (?, ?, ?, ?)'
          ).bind(post.id, project.id, position, JSON.stringify(post)));
        }
        for (const [position, highlight] of (project.highlights || []).entries()) {
          const highlightDocument = { id: highlight.id, title: highlight.title, autoStoryBucket: !!highlight.autoStoryBucket };
          statements.push(remoteDb.prepare(
            'INSERT INTO app_highlights (id, project_id, position, document) VALUES (?, ?, ?, ?)'
          ).bind(highlight.id, project.id, position, JSON.stringify(highlightDocument)));
          for (const [storyPosition, story] of (highlight.stories || []).entries()) {
            statements.push(remoteDb.prepare(
              'INSERT INTO app_stories (id, project_id, highlight_id, position, document) VALUES (?, ?, ?, ?, ?)'
            ).bind(story.id, project.id, highlight.id, storyPosition, JSON.stringify(story)));
          }
        }
      }
      return remoteDb.batch(statements);
    }
    const tmp = DB_FILE + '.tmp';
    return fs.promises
      .writeFile(tmp, JSON.stringify(db, null, 2))
      .then(() => fs.promises.rename(tmp, DB_FILE));
  };
  const p = queue.then(run);
  queue = p.catch(() => {});
  return p;
}

async function loadRemoteDatabase() {
  if (!remoteDb) return;
  if (!remoteDbInitialized) {
    await remoteDb.prepare('INSERT OR IGNORE INTO app_state (id, lock_token, lock_until) VALUES (1, NULL, NULL)').run();
    remoteDbInitialized = true;
  }
  await reloadRemoteDatabase();
}

async function reloadRemoteDatabase() {
  if (!remoteDb) return;
  const [projectResult, postResult, highlightResult, storyResult] = await Promise.all([
    remoteDb.prepare('SELECT id, document FROM app_projects ORDER BY position, id').all(),
    remoteDb.prepare('SELECT project_id, document FROM app_posts ORDER BY project_id, position, id').all(),
    remoteDb.prepare('SELECT id, project_id, document FROM app_highlights ORDER BY project_id, position, id').all(),
    remoteDb.prepare('SELECT highlight_id, document FROM app_stories ORDER BY project_id, highlight_id, position, id').all(),
  ]);
  const projects = (projectResult.results || []).map((row) => ({ ...JSON.parse(row.document), posts: [], highlights: [] }));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const highlightById = new Map();
  for (const row of postResult.results || []) {
    const project = projectById.get(row.project_id);
    if (!project) throw new Error('В Cloudflare D1 найдена публикация без проекта.');
    project.posts.push(JSON.parse(row.document));
  }
  for (const row of highlightResult.results || []) {
    const project = projectById.get(row.project_id);
    if (!project) throw new Error('В Cloudflare D1 найдена подборка без проекта.');
    const highlight = { ...JSON.parse(row.document), stories: [] };
    project.highlights.push(highlight);
    highlightById.set(row.id, highlight);
  }
  for (const row of storyResult.results || []) {
    const highlight = highlightById.get(row.highlight_id);
    if (!highlight) throw new Error('В Cloudflare D1 найдена история без подборки.');
    highlight.stories.push(JSON.parse(row.document));
  }
  db = { projects };
}

async function acquireRemoteLock() {
  const token = rid(12);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await remoteDb.prepare(
      'UPDATE app_state SET lock_token = ?, lock_until = ? WHERE id = 1 AND (lock_token IS NULL OR lock_until < ?)'
    ).bind(token, Date.now() + 120_000, Date.now()).run();
    if (result.meta?.changes > 0) return token;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const error = new Error('База занята другой операцией. Повторите запрос через несколько секунд.');
  error.status = 503;
  error.expose = true;
  throw error;
}

function remoteMutation(req, res, next) {
  if (!remoteDb) return next();
  acquireRemoteLock().then(async (token) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      remoteDb.prepare('UPDATE app_state SET lock_token = NULL, lock_until = NULL WHERE id = 1 AND lock_token = ?')
        .bind(token).run().catch((error) => console.error('Could not release D1 write lock:', error));
    };
    try {
      await reloadRemoteDatabase();
      if (req.params?.slug) {
        req.project = db.projects.find((project) => project.slug === req.params.slug);
        if (!req.project) {
          release();
          return res.status(404).json({ error: 'Проект не найден' });
        }
      }
      res.once('finish', release);
      res.once('close', release);
      next();
    } catch (error) {
      release();
      next(error);
    }
  }).catch(next);
}

/* ───────────── помощники ───────────── */

const rid = (bytes = 5) => crypto.randomBytes(bytes).toString('hex');
const now = () => new Date().toISOString();
const cleanLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'e', ґ: 'g',
};
function slugify(name) {
  const base = [...name.toLowerCase()]
    .map((c) => CYR[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return base || 'project';
}
function uniqueSlug(name) {
  for (;;) {
    // короткий случайный хвост: ссылку нельзя угадать перебором, а вид остаётся читаемым
    const slug = `${slugify(name)}-${rid(2)}`;
    if (!db.projects.some((p) => p.slug === slug)) return slug;
  }
}

function detectImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function detectVideoType(buf) {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B '].includes(brand)) return null;
    return brand === 'qt  ' ? { ext: 'mov', contentType: 'video/quicktime' } : { ext: 'mp4', contentType: 'video/mp4' };
  }
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { ext: 'webm', contentType: 'video/webm' };
  }
  return null;
}

function detectMediaType(buf) {
  const imageExt = detectImageType(buf);
  if (imageExt) return { type: 'image', ext: imageExt, contentType: imageExt === 'jpg' ? 'image/jpeg' : `image/${imageExt}` };
  const video = detectVideoType(buf);
  return video ? { type: 'video', ...video } : null;
}

async function storeImage(project, buf, ext) {
  const name = `${rid(8)}.${ext}`;
  if (mediaBucket) {
    const contentType = ext === 'jpg' ? 'image/jpeg' : ext === 'mov' ? 'video/quicktime'
      : ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : `image/${ext}`;
    await mediaBucket.put(`${project.id}/${name}`, buf, { httpMetadata: { contentType } });
    return `/uploads/${project.id}/${name}`;
  }
  const dir = path.join(UPLOAD_DIR, project.id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, name), buf);
  return `/uploads/${project.id}/${name}`;
}

function removeImage(publicPath) {
  if (!publicPath) return;
  if (mediaBucket) {
    const match = /^\/uploads\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/.exec(publicPath);
    return match ? mediaBucket.delete(`${match[1]}/${match[2]}`).catch(() => {}) : Promise.resolve();
  }
  const abs = path.join(DATA_DIR, publicPath);
  if (abs.startsWith(UPLOAD_DIR + path.sep)) return fs.promises.unlink(abs).catch(() => {});
  return Promise.resolve();
}

function cleanDate(v, fallback) {
  const s = String(v ?? '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const from = String(fallback || now()).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : now().slice(0, 10);
}

function recordMedia(item) {
  if (Array.isArray(item.media) && item.media.length) return item.media;
  const images = Array.isArray(item.images) && item.images.length ? item.images : (item.image ? [item.image] : []);
  return images.map((src) => ({ type: 'image', src }));
}

function publicPost(post) {
  const media = recordMedia(post);
  const images = media.filter((item) => item.type === 'image').map((item) => item.src);
  return {
    id: post.id,
    text: post.text || '',
    topic: post.topic || '',
    publishAt: cleanDate(post.publishAt, post.createdAt),
    media,
    images,
    image: images[0] || '',
    createdAt: post.createdAt,
  };
}

function publicStory(story) {
  const media = recordMedia(story);
  const images = media.filter((item) => item.type === 'image').map((item) => item.src);
  return {
    id: story.id,
    media,
    images,
    image: images[0] || '',
    text: story.text || '',
    topic: story.topic || '',
    publishAt: cleanDate(story.publishAt, story.createdAt),
    createdAt: story.createdAt,
  };
}

function removeRecordMedia(record) {
  return Promise.all([...new Set(recordMedia(record).map((item) => item.src).filter(Boolean))].map(removeImage));
}

const publicProject = (p) => ({
  slug: p.slug,
  name: p.name,
  createdAt: p.createdAt,
  posts: (p.posts || []).map(publicPost),
  highlights: (p.highlights || []).map((hl) => ({
    id: hl.id,
    title: hl.title,
    autoStoryBucket: !!hl.autoStoryBucket,
    stories: (hl.stories || []).map(publicStory),
  })),
});

function imagePaths(item) {
  return recordMedia(item).map((media) => media.src).filter(Boolean);
}

function referencedImagePaths(database) {
  const paths = new Set();
  for (const project of database.projects) {
    for (const post of project.posts || []) imagePaths(post).forEach((image) => paths.add(image));
    for (const highlight of project.highlights || []) {
      for (const story of highlight.stories || []) imagePaths(story).forEach((image) => paths.add(image));
    }
  }
  return [...paths];
}

function backupError(message) {
  const error = new Error(message);
  error.status = 400;
  error.expose = true;
  return error;
}

function parseImagePath(publicPath) {
  if (typeof publicPath !== 'string') throw backupError('Некорректный путь к фото в резервной копии.');
  const match = /^\/uploads\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/.exec(publicPath);
  if (!match || match[2] === '.' || match[2] === '..') throw backupError('Некорректный путь к фото в резервной копии.');
  return { directory: match[1], filename: match[2] };
}

async function readStoredMedia(publicPath) {
  const { directory, filename } = parseImagePath(publicPath);
  let buffer;
  if (mediaBucket) {
    const object = await mediaBucket.get(`${directory}/${filename}`);
    if (!object) throw backupError(`Не найден медиафайл ${filename} в R2.`);
    buffer = Buffer.from(await object.arrayBuffer());
  } else {
    const uploadRoot = await fs.promises.realpath(UPLOAD_DIR);
    const realPath = await fs.promises.realpath(path.join(UPLOAD_DIR, directory, filename));
    if (!realPath.startsWith(uploadRoot + path.sep)) throw backupError('Фото находится вне папки загрузок.');
    buffer = await fs.promises.readFile(realPath);
  }
  const media = detectMediaType(buffer);
  if (!media) throw backupError(`Не удалось определить формат медиафайла ${filename}.`);
  return { buffer, ...media };
}

function prepareBackup(backup) {
  if (!backup || backup.format !== 'feed-preview-backup' || ![1, 2].includes(backup.version)) {
    throw backupError('Формат файла не распознан. Выберите резервную копию Feed Preview в формате JSON.');
  }
  const mediaFiles = backup.version === 1 ? backup.images : backup.mediaFiles;
  if (!backup.database || !Array.isArray(backup.database.projects) || !mediaFiles || typeof mediaFiles !== 'object' || Array.isArray(mediaFiles)) {
    throw backupError('В резервной копии отсутствуют проекты или фотографии.');
  }

  const database = JSON.parse(JSON.stringify(backup.database));
  const slugs = new Set();
  const decodedImages = new Map();
  const files = [];
  const usedPaths = new Set();
  const projectIds = new Set((db.projects || []).map((project) => project.id));

  function decodeMedia(publicPath, expectedType) {
    if (decodedImages.has(publicPath)) {
      const cached = decodedImages.get(publicPath);
      if (cached.type !== expectedType) throw backupError(`Несовпадает тип медиафайла: ${publicPath}`);
      return cached;
    }
    const entry = mediaFiles[publicPath];
    if (!entry || typeof entry.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data)) {
      throw backupError(`В резервной копии отсутствует медиафайл: ${publicPath}`);
    }
    const buffer = Buffer.from(entry.data, 'base64');
    const detected = detectMediaType(buffer);
    const maxSize = detected?.type === 'video' ? MAX_VIDEO_UPLOAD : MAX_UPLOAD;
    if (!detected || detected.type !== expectedType || buffer.length > maxSize || entry.contentType !== detected.contentType || (entry.type && entry.type !== detected.type)) {
      throw backupError(`Медиафайл в резервной копии повреждён или имеет неподдерживаемый формат: ${publicPath}`);
    }
    decodedImages.set(publicPath, { buffer, ...detected });
    usedPaths.add(publicPath);
    return decodedImages.get(publicPath);
  }

  for (const project of database.projects) {
    if (!project || typeof project !== 'object' || typeof project.name !== 'string' || typeof project.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug)) {
      throw backupError('В резервной копии найден некорректный проект.');
    }
    if (slugs.has(project.slug)) throw backupError(`Повторяется ссылка проекта: ${project.slug}`);
    slugs.add(project.slug);
    if (!Array.isArray(project.posts) || !Array.isArray(project.highlights)) throw backupError(`В проекте «${project.name}» повреждена структура данных.`);

    let projectId;
    do { projectId = rid(6); } while (projectIds.has(projectId) || (!mediaBucket && fs.existsSync(path.join(UPLOAD_DIR, projectId))));
    projectIds.add(projectId);
    project.id = projectId;
    const projectFiles = new Map();
    function restoreRecord(record) {
      if (!record || typeof record !== 'object') throw backupError('В резервной копии найдена некорректная публикация.');
      const sourceMedia = recordMedia(record);
      if (!sourceMedia.length) throw backupError('У публикации в резервной копии нет медиафайлов.');
      record.media = sourceMedia.map((source) => {
        if (!source || !['image', 'video'].includes(source.type)) throw backupError('В резервной копии найден некорректный медиафайл.');
        const sourcePath = source.src;
        parseImagePath(sourcePath);
        const media = decodeMedia(sourcePath, source.type);
        if (!projectFiles.has(sourcePath)) {
          const filename = `${rid(8)}.${media.ext}`;
          projectFiles.set(sourcePath, `/uploads/${projectId}/${filename}`);
          files.push({ projectId, filename, buffer: media.buffer });
        }
        return { type: media.type, src: projectFiles.get(sourcePath), ...(media.type === 'video' ? { contentType: media.contentType } : {}) };
      });
      record.images = record.media.filter((media) => media.type === 'image').map((media) => media.src);
      record.image = record.images[0] || '';
    }

    for (const post of project.posts) restoreRecord(post);
    for (const highlight of project.highlights) {
      if (!highlight || !Array.isArray(highlight.stories)) throw backupError(`В проекте «${project.name}» найдена некорректная история.`);
      for (const story of highlight.stories) restoreRecord(story);
    }
  }

  const unused = Object.keys(mediaFiles).find((publicPath) => !usedPaths.has(publicPath));
  if (unused) throw backupError(`В резервной копии есть неиспользуемый или некорректный файл: ${unused}`);
  return { database, files };
}

/* ───────────── авторизация ───────────── */

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sessionToken = (scope = 'global') => crypto.createHmac('sha256', SECRET).update('editor:' + scope).digest('hex');

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isEditor(req, slug) {
  if (!PASSWORD) return false;
  const c = readCookie(req, 'ed');
  return !!c && (safeEqual(c, sessionToken('global')) || (!!slug && safeEqual(c, sessionToken('project:' + slug))));
}
function requireEditor(req, res, next) {
  const slug = req.params?.slug;
  if (isEditor(req, slug) && (!slug || req.get('X-Feed-Admin') === '1')) return next();
  res.status(401).json({ error: 'Нужно войти, чтобы редактировать' });
}

const attempts = new Map();

/* ───────────── приложение ───────────── */

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

if (mediaBucket) {
  app.get('/uploads/:projectId/:filename', wrap(async (req, res) => {
    const object = await mediaBucket.get(`${req.params.projectId}/${req.params.filename}`);
    if (!object) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(object.httpMetadata?.contentType || 'application/octet-stream');
    Readable.fromWeb(object.body).pipe(res);
  }));
} else {
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));
}
if (!cloudEnv?.ASSETS) app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sendIndex(res, title) {
  const html = cloudEnv?.ASSETS
    ? await (await cloudEnv.ASSETS.fetch('https://feed-preview-assets/index.html')).text()
    : fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  res.set('Cache-Control', 'no-cache').type('html').send(html.replace('%%TITLE%%', esc(title)));
}
app.get('/', (req, res) => sendIndex(res, 'Проекты'));
app.get('/p/:page/admin', (req, res) => {
  const p = db.projects.find((x) => x.slug === req.params.page);
  sendIndex(res, p ? p.name : 'Проект не найден');
});
app.get('/p/:page', (req, res) => {
  const p = db.projects.find((x) => x.slug === req.params.page);
  sendIndex(res, p ? p.name : 'Проект не найден');
});

/* ───────────── API ───────────── */

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', express.json({ limit: '64kb' }));
app.use('/api', async (req, res, next) => {
  if (!remoteDb) return next();
  try {
    await loadRemoteDatabase();
    next();
  } catch (error) { next(error); }
});
app.use('/api', (req, res, next) => {
  if ((restoreInProgress || backupInProgress) && req.method !== 'GET' && req.path !== '/backup/import') {
    return res.status(503).json({ error: 'Выполняется операция с базой данных. Повторите запрос позже.' });
  }
  if (req.method !== 'GET' && req.path !== '/backup/import') {
    activeMutations += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      finishMutation();
    };
    res.once('finish', release);
    res.once('close', release);
  }
  next();
});

app.param('slug', (req, res, next, slug) => {
  const project = db.projects.find((p) => p.slug === slug);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  req.project = project;
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_UPLOAD, files: 10 } });
const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BACKUP_SIZE, files: 1 } });
function uploadError(err, res) {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Видео слишком большое (до 100 МБ)'
    : err.code === 'LIMIT_FILE_COUNT' ? 'Можно загрузить не больше 10 медиафайлов'
    : 'Не удалось загрузить файл';
  res.status(400).json({ error: msg });
}
const uploadMedia = (req, res, next) =>
  upload.fields([{ name: 'images', maxCount: 10 }, { name: 'image', maxCount: 1 }, { name: 'videos', maxCount: 10 }])(req, res, (err) => {
    if (!err) return next();
    uploadError(err, res);
  });

function uploadedMedia(req, res) {
  const files = {
    image: [...(req.files?.images || []), ...(req.files?.image || [])],
    video: req.files?.videos || [],
  };
  if (!files.image.length && !files.video.length) {
    res.status(400).json({ error: 'Добавьте хотя бы одно фото или видео.' });
    return null;
  }

  let order;
  if (req.body?.mediaOrder) {
    try { order = JSON.parse(req.body.mediaOrder); }
    catch { res.status(400).json({ error: 'Не удалось прочитать порядок медиафайлов.' }); return null; }
  } else {
    order = [
      ...files.image.map((_, index) => ({ type: 'image', index })),
      ...files.video.map((_, index) => ({ type: 'video', index })),
    ];
  }
  if (!Array.isArray(order) || order.length !== files.image.length + files.video.length || order.length > 10) {
    res.status(400).json({ error: 'Можно добавить до 10 медиафайлов в одну публикацию.' });
    return null;
  }
  const seen = new Set();
  const result = [];
  for (const item of order) {
    if (!item || !['image', 'video'].includes(item.type) || !Number.isInteger(item.index) || item.index < 0) {
      res.status(400).json({ error: 'В порядке медиафайлов есть ошибка.' });
      return null;
    }
    const key = `${item.type}:${item.index}`;
    const file = files[item.type][item.index];
    if (!file || seen.has(key)) {
      res.status(400).json({ error: 'В порядке медиафайлов есть ошибка.' });
      return null;
    }
    seen.add(key);
    const detected = detectMediaType(file.buffer);
    const maxSize = item.type === 'video' ? MAX_VIDEO_UPLOAD : MAX_UPLOAD;
    if (!detected || detected.type !== item.type || file.buffer.length > maxSize) {
      res.status(400).json({ error: item.type === 'video'
        ? 'Видео должно быть в формате MP4, WebM или MOV и не больше 100 МБ.'
        : 'Фото поддерживаются в формате JPG, PNG или WebP (до 12 МБ).' });
      return null;
    }
    result.push({ ...detected, buffer: file.buffer, originalName: file.originalname });
  }
  return result;
}

async function storeUploadedMedia(project, entries) {
  const result = [];
  try {
    for (const entry of entries) {
      const src = await storeImage(project, entry.buffer, entry.ext);
      result.push({ type: entry.type, src, ...(entry.type === 'video' ? { contentType: entry.contentType } : {}) });
    }
    return result;
  } catch (error) {
    await Promise.all(result.map((item) => removeImage(item.src)));
    throw error;
  }
}

function readImageBuf(file, res) {
  if (!file) {
    res.status(400).json({ error: 'Не передано изображение' });
    return null;
  }
  const ext = detectImageType(file.buffer);
  if (!ext) {
    res.status(400).json({ error: 'Поддерживаются только JPG, PNG и WebP' });
    return null;
  }
  return { buf: file.buffer, ext };
}
function readImage(req, res) {
  return readImageBuf(req.file, res);
}

// сессия
app.get('/api/session', (req, res) => {
  const slug = cleanLine(req.query?.slug, 60);
  res.json({ editor: isEditor(req, slug || undefined), protected: !!PASSWORD || !!cloudEnv });
});

app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.status(503).json({ error: 'Сначала задайте ADMIN_PASSWORD в настройках сервера.' });
  const t = Date.now();
  const a = attempts.get(req.ip) || { n: 0, reset: t + 10 * 60 * 1000 };
  if (t > a.reset) Object.assign(a, { n: 0, reset: t + 10 * 60 * 1000 });
  if (a.n >= 10) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
  if (!safeEqual(String(req.body?.password ?? ''), PASSWORD)) {
    a.n += 1;
    attempts.set(req.ip, a);
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const slug = cleanLine(req.body?.slug, 60);
  if (slug && !db.projects.some((project) => project.slug === slug)) {
    return res.status(404).json({ error: 'Проект не найден' });
  }
  attempts.delete(req.ip);
  res.cookie('ed', sessionToken(slug ? 'project:' + slug : 'global'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
  res.json({ editor: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('ed', { path: '/' });
  res.json({ ok: true });
});

function uploadBackupFile(req, res, next) {
  uploadBackup.single('backup')(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'Резервная копия слишком большая (максимум 256 МБ).' : 'Не удалось загрузить файл резервной копии.',
    });
  });
}

app.get('/api/backup', requireEditor, async (req, res) => {
  if (backupInProgress || restoreInProgress) return res.status(409).json({ error: 'Дождитесь завершения текущей операции с базой данных.' });
  backupInProgress = true;
  try {
    await waitForMutations();
    await queue;
    const database = JSON.parse(JSON.stringify(db));
    const mediaFiles = {};
    let estimatedSize = Buffer.byteLength(JSON.stringify(database)) + 256;
    for (const publicPath of referencedImagePaths(database)) {
      const { buffer, type, contentType } = await readStoredMedia(publicPath);
      estimatedSize += Math.ceil(buffer.length / 3) * 4 + Buffer.byteLength(publicPath) + 64;
      if (estimatedSize > MAX_BACKUP_SIZE) {
        return res.status(413).json({ error: 'Резервная копия превышает 256 МБ. Уменьшите размер медиафайлов или разделите данные на несколько проектов.' });
      }
      mediaFiles[publicPath] = {
        type,
        contentType,
        data: buffer.toString('base64'),
      };
    }
    const backup = { format: 'feed-preview-backup', version: 2, exportedAt: now(), database, mediaFiles };
    const content = JSON.stringify(backup);
    if (Buffer.byteLength(content) > MAX_BACKUP_SIZE) {
      return res.status(413).json({ error: 'Резервная копия превышает 256 МБ и не может быть экспортирована одним файлом.' });
    }
    const date = now().slice(0, 10);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="feed-preview-backup-${date}.json"`);
    res.type('json').send(content);
  } catch (error) {
    console.error('Backup export failed:', error);
    res.status(500).json({ error: 'Не удалось создать резервную копию. Проверьте медиафайлы на сервере.' });
  } finally {
    backupInProgress = false;
  }
});

app.post('/api/backup/import', requireEditor, uploadBackupFile, remoteMutation, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите JSON-файл резервной копии.' });
  if (backupInProgress || restoreInProgress) return res.status(409).json({ error: 'Дождитесь завершения текущей операции с базой данных.' });
  restoreInProgress = true;
  const previousDatabase = db;
  const createdDirectories = new Set();
  const createdObjects = [];
  let committed = false;
  try {
    await waitForMutations();
    await queue;
    let backup;
    try { backup = JSON.parse(req.file.buffer.toString('utf8')); }
    catch { throw backupError('Файл не является корректной резервной копией JSON.'); }
    const prepared = prepareBackup(backup);
    for (const file of prepared.files) {
      if (mediaBucket) {
        const detected = detectMediaType(file.buffer);
        const key = `${file.projectId}/${file.filename}`;
        await mediaBucket.put(key, file.buffer, { httpMetadata: { contentType: detected.contentType } });
        createdObjects.push(key);
      } else {
        const directory = path.join(UPLOAD_DIR, file.projectId);
        if (!createdDirectories.has(directory)) {
          await fs.promises.mkdir(directory, { recursive: false });
          createdDirectories.add(directory);
        }
        await fs.promises.writeFile(path.join(directory, file.filename), file.buffer, { flag: 'wx' });
      }
    }

    db = prepared.database;
    await save();
    committed = true;
    if (mediaBucket) {
      const oldRecords = (previousDatabase.projects || []).flatMap((project) => [
        ...(project.posts || []),
        ...(project.highlights || []).flatMap((highlight) => highlight.stories || []),
      ]);
      await Promise.all(oldRecords.flatMap((record) => recordMedia(record).map((item) => removeImage(item.src))));
    } else {
      await Promise.all((previousDatabase.projects || []).map((project) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(project.id || '')) return null;
        return fs.promises.rm(path.join(UPLOAD_DIR, project.id), { recursive: true, force: true }).catch(() => {});
      }));
    }
    res.json({ ok: true, projects: db.projects.length });
  } catch (error) {
    if (!committed) {
      db = previousDatabase;
      await Promise.all([...createdDirectories].map((directory) => fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {})));
      if (mediaBucket) await Promise.all(createdObjects.map((key) => mediaBucket.delete(key).catch(() => {})));
    }
    const status = error.status && error.status < 500 ? error.status : 500;
    const message = error.expose ? error.message
      : status === 500 ? 'Не удалось восстановить базу данных. Исходные данные сохранены.'
        : 'Не удалось восстановить резервную копию.';
    res.status(status).json({ error: message });
  } finally {
    restoreInProgress = false;
  }
});

// проекты
app.get('/api/projects', requireEditor, (req, res) => {
  const list = db.projects
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      createdAt: p.createdAt,
      cover: p.posts[0]?.images?.[0] || p.posts[0]?.image || p.highlights[0]?.stories[0]?.image || null,
      posts: p.posts.length,
      stories: p.highlights.reduce((n, h) => n + h.stories.length, 0),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

app.post('/api/projects', requireEditor, remoteMutation, wrap(async (req, res) => {
  const name = cleanLine(req.body?.name, LIMITS.projectName);
  if (!name) return res.status(400).json({ error: 'Введите название проекта' });
  const project = { id: rid(6), slug: uniqueSlug(name), name, createdAt: now(), posts: [], highlights: [] };
  db.projects.push(project);
  await save();
  res.status(201).json(publicProject(project));
}));

app.get('/api/projects/:slug', (req, res) => res.json(publicProject(req.project)));

app.patch('/api/projects/:slug', requireEditor, remoteMutation, wrap(async (req, res) => {
  const name = cleanLine(req.body?.name, LIMITS.projectName);
  if (!name) return res.status(400).json({ error: 'Введите название проекта' });
  req.project.name = name; // ссылка (slug) остаётся прежней
  await save();
  res.json(publicProject(req.project));
}));

app.delete('/api/projects/:slug', requireEditor, remoteMutation, wrap(async (req, res) => {
  const deletedProject = req.project;
  db.projects = db.projects.filter((p) => p !== req.project);
  await save();
  if (mediaBucket) {
    const records = [
      ...(deletedProject.posts || []),
      ...(deletedProject.highlights || []).flatMap((highlight) => highlight.stories || []),
    ];
    await Promise.all(records.flatMap((record) => recordMedia(record).map((item) => removeImage(item.src))));
  } else fs.promises.rm(path.join(UPLOAD_DIR, deletedProject.id), { recursive: true, force: true }).catch(() => {});
  res.json({ ok: true });
}));

// посты
app.post('/api/projects/:slug/posts', requireEditor, uploadMedia, remoteMutation, wrap(async (req, res) => {
  const entries = uploadedMedia(req, res);
  if (!entries) return;
  const media = await storeUploadedMedia(req.project, entries);
  const images = media.filter((item) => item.type === 'image').map((item) => item.src);
  const createdAt = now();
  const post = {
    id: rid(),
    text: cleanText(req.body?.text, LIMITS.text),
    topic: cleanLine(req.body?.topic, LIMITS.topic),
    publishAt: cleanDate(req.body?.publishAt, createdAt),
    media,
    images,
    image: images[0] || '',
    createdAt,
  };
  req.project.posts.unshift(post); // новые — в начале сетки
  await save();
  res.status(201).json(publicProject(req.project));
}));

app.patch('/api/projects/:slug/posts/:id', requireEditor, uploadMedia, remoteMutation, wrap(async (req, res) => {
  const post = req.project.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  const hasNewMedia = Object.values(req.files || {}).some((files) => files.length);
  let nextMedia = null;
  if (hasNewMedia) {
    const entries = uploadedMedia(req, res);
    if (!entries) return;
    nextMedia = await storeUploadedMedia(req.project, entries);
  }

  const previous = {
    text: post.text,
    topic: post.topic,
    publishAt: post.publishAt,
    media: post.media,
    images: post.images,
    image: post.image,
  };
  const previousMedia = nextMedia ? recordMedia(post) : null;
  try {
    if (req.body?.text !== undefined) post.text = cleanText(req.body.text, LIMITS.text);
    if (req.body?.topic !== undefined) post.topic = cleanLine(req.body.topic, LIMITS.topic);
    if (req.body?.publishAt !== undefined) post.publishAt = cleanDate(req.body.publishAt, post.createdAt);
    if (nextMedia) {
      post.media = nextMedia;
      post.images = nextMedia.filter((item) => item.type === 'image').map((item) => item.src);
      post.image = post.images[0] || '';
    }
    await save();
  } catch (error) {
    Object.assign(post, previous);
    if (nextMedia) await removeRecordMedia({ media: nextMedia });
    throw error;
  }
  if (previousMedia) await removeRecordMedia({ media: previousMedia });
  res.json(publicProject(req.project));
}));

app.delete('/api/projects/:slug/posts/:id', requireEditor, remoteMutation, wrap(async (req, res) => {
  const post = req.project.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  req.project.posts = req.project.posts.filter((p) => p !== post);
  await save();
  await removeRecordMedia(post);
  res.json(publicProject(req.project));
}));

// истории и «кружки» (актуальное)
app.post('/api/projects/:slug/stories', requireEditor, uploadMedia, remoteMutation, wrap(async (req, res) => {
  const entries = uploadedMedia(req, res);
  if (!entries) return;
  const p = req.project;

  let highlight = null;
  let newTitle = '';
  if (req.body?.highlightId) {
    highlight = p.highlights.find((h) => h.id === req.body.highlightId);
    if (!highlight) return res.status(404).json({ error: 'Кружок не найден' });
  } else {
    newTitle = cleanLine(req.body?.newTitle, LIMITS.highlightTitle);
    if (!newTitle) {
      highlight = p.highlights.find((h) => h.autoStoryBucket);
      if (!highlight) {
        highlight = { id: rid(), title: 'Сторис', autoStoryBucket: true, stories: [] };
        p.highlights.push(highlight);
      }
    }
  }

  const createdAt = now();
  const media = await storeUploadedMedia(p, entries);
  const images = media.filter((item) => item.type === 'image').map((item) => item.src);
  const story = {
    id: rid(),
    media,
    images,
    image: images[0] || '',
    text: cleanText(req.body?.text, LIMITS.text),
    topic: cleanLine(req.body?.topic, LIMITS.topic),
    publishAt: cleanDate(req.body?.publishAt, createdAt),
    createdAt,
  };
  if (!highlight) {
    highlight = { id: rid(), title: newTitle, stories: [] };
    p.highlights.push(highlight);
  }
  highlight.stories.push(story);
  await save();
  res.status(201).json(publicProject(p));
}));

app.patch('/api/projects/:slug/highlights/:id', requireEditor, remoteMutation, wrap(async (req, res) => {
  const h = req.project.highlights.find((x) => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'Кружок не найден' });
  const title = cleanLine(req.body?.title, LIMITS.highlightTitle);
  if (!title) return res.status(400).json({ error: 'Введите название' });
  h.title = title;
  await save();
  res.json(publicProject(req.project));
}));

app.delete('/api/projects/:slug/highlights/:id', requireEditor, remoteMutation, wrap(async (req, res) => {
  const h = req.project.highlights.find((x) => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'Кружок не найден' });
  req.project.highlights = req.project.highlights.filter((x) => x !== h);
  await save();
  await Promise.all(h.stories.map(removeRecordMedia));
  res.json(publicProject(req.project));
}));

app.patch('/api/projects/:slug/highlights/:hid/stories/:sid', requireEditor, uploadMedia, remoteMutation, wrap(async (req, res) => {
  const h = req.project.highlights.find((x) => x.id === req.params.hid);
  const story = h?.stories.find((s) => s.id === req.params.sid);
  if (!story) return res.status(404).json({ error: 'История не найдена' });
  const hasNewMedia = Object.values(req.files || {}).some((files) => files.length);
  let nextMedia = null;
  if (hasNewMedia) {
    const entries = uploadedMedia(req, res);
    if (!entries) return;
    nextMedia = await storeUploadedMedia(req.project, entries);
  }
  const previous = {
    text: story.text,
    topic: story.topic,
    publishAt: story.publishAt,
    media: story.media,
    images: story.images,
    image: story.image,
  };
  const previousMedia = nextMedia ? recordMedia(story) : null;
  try {
    if (req.body?.text !== undefined) story.text = cleanText(req.body.text, LIMITS.text);
    if (req.body?.topic !== undefined) story.topic = cleanLine(req.body.topic, LIMITS.topic);
    if (req.body?.publishAt !== undefined) story.publishAt = cleanDate(req.body.publishAt, story.createdAt);
    if (nextMedia) {
      story.media = nextMedia;
      story.images = nextMedia.filter((item) => item.type === 'image').map((item) => item.src);
      story.image = story.images[0] || '';
    }
    await save();
  } catch (error) {
    Object.assign(story, previous);
    if (nextMedia) await removeRecordMedia({ media: nextMedia });
    throw error;
  }
  if (previousMedia) await removeRecordMedia({ media: previousMedia });
  res.json(publicProject(req.project));
}));

app.delete('/api/projects/:slug/highlights/:hid/stories/:sid', requireEditor, remoteMutation, wrap(async (req, res) => {
  const h = req.project.highlights.find((x) => x.id === req.params.hid);
  const story = h?.stories.find((s) => s.id === req.params.sid);
  if (!story) return res.status(404).json({ error: 'История не найдена' });
  h.stories = h.stories.filter((s) => s !== story);
  if (!h.stories.length) req.project.highlights = req.project.highlights.filter((x) => x !== h); // пустой кружок не нужен
  await save();
  await removeRecordMedia(story);
  res.json(publicProject(req.project));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  if (req.path.startsWith('/api')) return res.status(status).json({ error: status === 500 ? 'Ошибка сервера' : 'Некорректный запрос' });
  res.status(status).type('text/plain').send(status === 500 ? 'Ошибка сервера' : 'Некорректный запрос');
});

if (!cloudEnv) {
  app.listen(PORT, () => {
    console.log(`Сервис запущен: http://localhost:${PORT}`);
    console.log(`Данные: ${DATA_DIR}`);
    if (!PASSWORD) console.warn('⚠  ADMIN_PASSWORD не задан — редактирование заблокировано. Задайте пароль в локальном .env.');
  });
}

module.exports = { app };

