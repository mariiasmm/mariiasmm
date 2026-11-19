(() => {
  'use strict';

  /* ───────────── утилиты ───────────── */

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const overlay = $('#overlay');
  const toastRoot = $('#toast');

  // мини-хелпер для создания элементов; текст всегда вставляется как текст (без innerHTML)
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // только для встроенных иконок
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return el;
  }

  const svg = (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    back: svg('<path d="M15 5l-7 7 7 7"/>'),
    next: svg('<path d="M9 5l7 7-7 7"/>'),
    download: svg('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
    upload: svg('<path d="M12 16V4m0 0L7 9m5-5l5 5M5 14v5a1 1 0 001 1h12a1 1 0 001-1v-5"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>'),
    link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
    more: svg('<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>'),
    out: svg('<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 8l-4 4 4 4M6 12h10"/>'),
    feed: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
    grid: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>'),
    cal: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>'),
    stack: svg('<rect x="7" y="7" width="12" height="12" rx="1.5"/><path d="M5 15V6.5A1.5 1.5 0 016.5 5H15"/>'),
  };

  const plural = (n, f) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return f[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2];
  };
  const fmtDate = (iso) => {
    const s = String(iso || '').slice(0, 10);
    const [y, m, d] = s.split('-').map(Number);
    const dt = y && m ? new Date(y, m - 1, d) : new Date(iso);
    return dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const extOf = (url) => (url.split('.').pop() || 'jpg').toLowerCase();
  const postImages = (post) => (Array.isArray(post.images) && post.images.length ? post.images : (post.image ? [post.image] : []));
  const storyImages = (story) => (Array.isArray(story.images) && story.images.length ? story.images : (story.image ? [story.image] : []));
  const normalizeMedia = (items) => items.map((item) => typeof item === 'string' ? { type: 'image', src: item } : item).filter((item) => item?.src);
  const postMedia = (post) => normalizeMedia(Array.isArray(post.media) && post.media.length ? post.media : postImages(post));
  const storyMedia = (story) => normalizeMedia(Array.isArray(story.media) && story.media.length ? story.media : storyImages(story));
  const mediaFileSizeLimit = 100 * 1024 * 1024;
  const itemDay = (item) => String(item.publishAt || item.createdAt || '').slice(0, 10);
  const byDay = (a, b) => itemDay(b).localeCompare(itemDay(a)) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  const flatStories = (p) => (p.highlights || []).flatMap((hl) =>
    (hl.stories || []).map((s) => ({ ...s, highlightId: hl.id, highlightTitle: hl.title, autoStoryBucket: !!hl.autoStoryBucket })));

  const state = {
    editor: false,
    protected: false,
    adminMode: false,
    project: null,
    view: ['feed', 'calendar'].includes(localStorage.getItem('fp-view')) ? localStorage.getItem('fp-view') : 'feed',
    feedTab: localStorage.getItem('fp-tab') === 'stories' ? 'stories' : 'posts',
    calMonth: null,
    calDay: todayISO(),
  };
  function setView(v) {
    state.view = v;
    localStorage.setItem('fp-view', v);
    drawProject();
  }
  function setFeedTab(t) {
    state.feedTab = t;
    localStorage.setItem('fp-tab', t);
    drawProject();
  }
  const projectUrl = () => '/api/projects/' + state.project.slug;

  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (state.adminMode && method !== 'GET') opt.headers['X-Feed-Admin'] = '1';
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    let data = null;
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Ошибка запроса');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg) {
    const el = h('div', { class: 'toast' }, msg);
    toastRoot.append(el);
    setTimeout(() => el.remove(), 2400);
  }

  function handleErr(e) {
    if (e.status === 401) {
      toast('Сессия истекла — войдите снова');
      openLogin();
    } else toast(e.message || 'Что-то пошло не так');
  }
  async function guard(fn) {
    try { return await fn(); } catch (e) { handleErr(e); }
  }

  async function copyText(text, msg = 'Скопировано') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (!ok) return toast('Не удалось скопировать');
    }
    toast(msg);
  }

  /* ───────────── слой окон ───────────── */

  const syncLock = () => { document.body.style.overflow = overlay.children.length ? 'hidden' : ''; };
  const mount = (el) => { overlay.append(el); syncLock(); };
  const unmount = (el) => { el.remove(); syncLock(); };
  document.addEventListener('keydown', (e) => {
    const top = overlay.lastElementChild;
    if (top && top._onKey) top._onKey(e);
  });

  function modal({ title = '', wide = false } = {}) {
    let done;
    const closed = new Promise((r) => { done = r; });
    const body = h('div', { class: 'modal-body' });
    const foot = h('div', { class: 'modal-foot' });
    const close = () => {
      if (!el.isConnected) return;
      unmount(el);
      done();
    };
    const card = h('div', { class: 'modal-card' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || null },
      h('div', { class: 'modal-head' },
        h('div', { class: 'modal-title' }, title),
        h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onClick: close, html: I.close })),
      body, foot);
    const el = h('div', { class: 'modal-backdrop', onMousedown: (e) => { if (e.target === el) close(); } }, card);
    el._onKey = (e) => { if (e.key === 'Escape') close(); };
    mount(el);
    return { el, body, foot, close, closed };
  }

  function askText({ title, value = '', placeholder = '', ok = 'Сохранить', max = 60 }) {
    return new Promise((resolve) => {
      const m = modal({ title });
      const input = h('input', { class: 'field', type: 'text', value, placeholder, maxlength: String(max), 'aria-label': title });
      const submit = () => {
        const v = input.value.trim();
        if (!v) return input.focus();
        resolve(v);
        m.close();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      m.body.append(input);
      m.foot.append(h('button', { class: 'btn', onClick: m.close }, 'Отмена'), h('button', { class: 'btn primary', onClick: submit }, ok));
      m.closed.then(() => resolve(null));
      input.focus();
      input.select();
    });
  }

  function askConfirm({ title, text = '', ok = 'Удалить' }) {
    return new Promise((resolve) => {
      const m = modal({ title });
      if (text) m.body.append(h('p', { class: 'modal-text' }, text));
      m.foot.append(
        h('button', { class: 'btn', onClick: m.close }, 'Отмена'),
        h('button', { class: 'btn primary', onClick: () => { resolve(true); m.close(); } }, ok));
      m.closed.then(() => resolve(false));
    });
  }

  function sheet(items) {
    const m = modal({});
    m.body.append(h('div', { class: 'sheet' }, items.filter(Boolean).map((it) =>
      h('button', { class: it.danger ? 'danger' : '', onClick: () => { m.close(); it.run(); } },
        h('span', { class: 'ico', html: it.icon }), it.label))));
    return m;
  }

  /* ───────────── вход ───────────── */

  async function doLogin(password) {
    await api('POST', '/api/login', { password, ...(state.adminMode && state.project ? { slug: state.project.slug } : {}) });
    location.reload();
  }
  async function doLogout() {
    await api('POST', '/api/logout');
    if (state.adminMode && state.project) {
      location.href = '/p/' + state.project.slug;
      return;
    }
    location.reload();
  }
  function openLogin() {
    const m = modal({ title: 'Вход для редактирования' });
    const input = h('input', { class: 'field', type: 'password', placeholder: 'Пароль', autocomplete: 'current-password', 'aria-label': 'Пароль' });
    const err = h('div', { class: 'err' });
    const submit = async () => {
      err.textContent = '';
      try { await doLogin(input.value); } catch (e) { err.textContent = e.message; input.select(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    m.body.append(input, err);
    m.foot.append(h('button', { class: 'btn primary', onClick: submit }, 'Войти'));
    input.focus();
  }

  /* ───────────── загрузка и кадрирование ───────────── */

  function pickFiles({ multiple = false, accept = 'image/*' } = {}) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept, multiple: multiple || null });
      input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        resolve(multiple ? files : (files[0] || null));
      });
      input.addEventListener('cancel', () => resolve(multiple ? [] : null));
      input.click();
    });
  }
  const pickFile = () => pickFiles({ multiple: false });
  const pickMediaFiles = () => pickFiles({ multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime' });

  function mediaFileType(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['mp4', 'webm', 'mov'].includes(ext) || ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type)) return 'video';
    if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
    return null;
  }

  async function appendMediaFormData(form, items, prefix) {
    const counts = { image: 0, video: 0 };
    const order = [];
    for (const item of items) {
      const index = counts[item.type]++;
      if (item.type === 'image') {
        const isStory = prefix === 'story';
        const blob = await item.cropper.toBlob(isStory ? 900 : 1080, isStory ? 0.84 : 0.92);
        form.append('images', blob, `${prefix}-${index + 1}.jpg`);
      } else {
        form.append('videos', item.file, item.file.name);
      }
      order.push({ type: item.type, index });
    }
    form.append('mediaOrder', JSON.stringify(order));
  }

  function mediaThumbnail(media, className = '') {
    const item = typeof media === 'string' ? { type: 'image', src: media } : media;
    if (item?.type !== 'video') return h('img', { class: className, src: item?.src || '', alt: '', loading: 'lazy' });
    const video = h('video', { src: item.src, muted: true, playsinline: true, preload: 'metadata', tabindex: '-1' });
    return h('div', { class: `media-thumb-video ${className}` }, video, h('span', { 'aria-hidden': 'true' }, '▶'));
  }

  function metaFields({ topic = '', date = '' } = {}) {
    const topicEl = h('input', { class: 'field', type: 'text', maxlength: '80', value: topic, placeholder: 'Например, запуск меню', 'aria-label': 'Тема' });
    const dateEl = h('input', { class: 'field', type: 'date', value: date || todayISO(), 'aria-label': 'Дата публикации' });
    const box = h('div', { class: 'meta-fields' },
      h('div', {}, h('div', { class: 'lbl' }, 'Тема'), topicEl),
      h('div', {}, h('div', { class: 'lbl' }, 'Дата публикации'), dateEl));
    return { box, topicEl, dateEl };
  }

  function textField({ value = '', placeholder = 'Текст…', label = 'Текст', max = 2200 } = {}) {
    const ta = h('textarea', { class: 'field', rows: '8', placeholder, 'aria-label': label });
    ta.value = value;
    const count = h('div', { class: 'count' }, `${value.length} / ${max}`);
    ta.addEventListener('input', () => {
      count.textContent = `${ta.value.length} / ${max}`;
      count.classList.toggle('over', ta.value.length > max);
    });
    return { ta, count, box: h('div', {}, h('div', { class: 'lbl' }, label), ta, count) };
  }

  function gallery(urls, { ratio = '4 / 5', onChange } = {}) {
    const list = normalizeMedia(urls.filter(Boolean));
    let i = 0;
    const track = h('div', { class: 'gal-track' }, ...list.map((item) => {
      if (item.type !== 'video') return h('div', { class: 'gal-slide' }, h('img', { src: item.src, alt: '' }));
      const video = h('video', { class: 'gal-video', src: item.src, controls: true, playsinline: true, preload: 'metadata' });
      video.addEventListener('click', (e) => e.stopPropagation());
      return h('div', { class: 'gal-slide' }, video);
    }));
    const dots = list.length > 1
      ? h('div', { class: 'gal-dots' }, ...list.map((_, n) => {
           const b = h('button', { type: 'button', class: 'gal-dot', 'aria-label': 'Медиафайл ' + (n + 1) });
          b.addEventListener('click', (e) => { e.stopPropagation(); go(n); });
          return b;
        }))
      : null;
    const prev = h('button', { type: 'button', class: 'gal-nav prev', 'aria-label': 'Предыдущий медиафайл', html: I.back });
    const next = h('button', { type: 'button', class: 'gal-nav next', 'aria-label': 'Следующий медиафайл', html: I.next });
    const el = h('div', { class: 'gal', style: `aspect-ratio:${ratio}` },
      track,
      list.length > 1 ? [prev, next, dots] : null);
    function go(n) {
      if (!list.length) return;
      track.querySelectorAll('video').forEach((video) => video.pause());
      i = ((n % list.length) + list.length) % list.length;
      track.style.transform = `translateX(${-i * 100}%)`;
      if (dots) [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
      if (onChange) onChange(list[i], i);
    }
    prev.addEventListener('click', (e) => { e.stopPropagation(); go(i - 1); });
    next.addEventListener('click', (e) => { e.stopPropagation(); go(i + 1); });
    let sx = 0, sy = 0, dragging = false, swiped = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      dragging = true;
      swiped = false;
      sx = e.clientX;
      sy = e.clientY;
    });
    el.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        swiped = true;
        go(i + (dx < 0 ? 1 : -1));
      }
    });
    el.addEventListener('pointercancel', () => { dragging = false; });
    el.addEventListener('click', (e) => {
      if (swiped || e.target.closest('.gal-nav, .gal-dot')) {
        e.stopPropagation();
        swiped = false;
      }
    });
    go(0);
    return { el, go, index: () => i, src: () => list[i] };
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть изображение')); };
      img.src = url;
    });
  }

  // Кадрирование с перетаскиванием и масштабом. Результат — JPEG ровно нужного формата (4:5 или 9:16).
  function createCropper(img, ratio, maxWidth = window.innerWidth - 80) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let vh = Math.min(window.innerHeight * 0.5, 460);
    let vw = vh * ratio;
    const maxW = maxWidth;
    if (vw > maxW) { vw = maxW; vh = vw / ratio; }
    vw = Math.round(vw);
    vh = Math.round(vw / ratio);

    const base = Math.max(vw / iw, vh / ih); // «cover»
    let zoom = 1;
    let x = (vw - iw * base) / 2;
    let y = (vh - ih * base) / 2;

    const im = h('img', { src: img.src, alt: '', draggable: 'false' });
    const view = h('div', { class: 'crop-view', style: `width:${vw}px;height:${vh}px` }, im);
    const slider = h('input', { class: 'crop-zoom', type: 'range', min: '1', max: '3', step: '0.01', value: '1', 'aria-label': 'Масштаб' });

    function apply() {
      const s = base * zoom;
      x = Math.min(0, Math.max(vw - iw * s, x));
      y = Math.min(0, Math.max(vh - ih * s, y));
      im.style.width = iw * s + 'px';
      im.style.height = ih * s + 'px';
      im.style.transform = `translate(${x}px, ${y}px)`;
    }
    function setZoom(z) {
      const old = base * zoom;
      const cx = (vw / 2 - x) / old;
      const cy = (vh / 2 - y) / old;
      zoom = z;
      const s = base * zoom;
      x = vw / 2 - cx * s;
      y = vh / 2 - cy * s;
      apply();
    }
    apply();

    slider.addEventListener('input', () => setZoom(parseFloat(slider.value)));
    let drag = null;
    view.addEventListener('pointerdown', (e) => {
      view.setPointerCapture(e.pointerId);
      drag = { px: e.clientX, py: e.clientY, x, y };
    });
    view.addEventListener('pointermove', (e) => {
      if (!drag) return;
      x = drag.x + (e.clientX - drag.px);
      y = drag.y + (e.clientY - drag.py);
      apply();
    });
    const end = () => { drag = null; };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      const z = Math.min(3, Math.max(1, zoom - e.deltaY * 0.002));
      slider.value = String(z);
      setZoom(z);
    }, { passive: false });

    async function toBlob(width, quality = 0.92) {
      const height = Math.round(width / ratio);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingQuality = 'high';
      const s = base * zoom;
      ctx.drawImage(img, -x / s, -y / s, vw / s, vh / s, 0, 0, width, height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (!blob) throw new Error('Не удалось подготовить изображение');
      return blob;
    }

    return {
      el: h('div', { class: 'cropper' }, view, slider, h('p', { class: 'crop-hint' }, 'Перетащите фото и выберите масштаб')),
      toBlob,
    };
  }

  async function readComposeMedia(files, items, ratio, maxWidth) {
    for (const file of files) {
      if (items.length >= 10) {
        toast('Можно добавить не больше 10 медиафайлов');
        break;
      }
      const type = mediaFileType(file);
      if (!type) {
        toast('Поддерживаются фото JPG, PNG, WebP и видео MP4, WebM или MOV');
        continue;
      }
      if (type === 'video' && file.size > mediaFileSizeLimit) {
        toast('Размер видео не должен превышать 100 МБ');
        continue;
      }
      try {
        if (type === 'video') items.push({ type, file, previewUrl: URL.createObjectURL(file) });
        else {
          const img = await loadImage(file);
          items.push({ type, img, cropper: createCropper(img, ratio, maxWidth) });
        }
      } catch (error) { toast(error.message); }
    }
  }

  function releaseComposeMedia(items) {
    items.forEach((item) => URL.revokeObjectURL(item.previewUrl || item.img?.src));
  }

  function composeThumbnail(item) {
    if (item.type === 'video') return mediaThumbnail({ type: 'video', src: item.previewUrl });
    return h('img', { src: item.img.src, alt: '' });
  }

  function paintComposeMedia(cropSlot, item) {
    if (item.type === 'image') {
      cropSlot.replaceChildren(item.cropper.el);
      return;
    }
    const video = h('video', { class: 'crop-video-preview', src: item.previewUrl, controls: true, playsinline: true, preload: 'metadata' });
    cropSlot.replaceChildren(h('div', { class: 'crop-video-card' }, video,
      h('p', { class: 'muted' }, 'Видео будет добавлено без кадрирования.')));
  }

  async function addPost() {
    const files = await pickMediaFiles();
    if (!files.length) return;
    const items = [];
    await readComposeMedia(files, items, 4 / 5);
    if (!items.length) return;

    const m = modal({ title: 'Новый пост', wide: true });
    m.closed.then(() => releaseComposeMedia(items));

    let cur = 0;
    const cropSlot = h('div', { class: 'crop-slot' });
    const thumbs = h('div', { class: 'crop-thumbs' });
    const addMore = h('button', { class: 'btn small', type: 'button' }, 'Добавить медиа');
    const txt = textField({ placeholder: 'Текст поста…', label: 'Подпись' });
    const meta = metaFields({ date: state.view === 'calendar' ? state.calDay : todayISO() });

    function paintThumbs() {
      thumbs.replaceChildren(...items.map((it, n) => {
        const b = h('button', { type: 'button', class: 'crop-thumb' + (n === cur ? ' on' : ''), 'aria-label': 'Медиафайл ' + (n + 1) },
          composeThumbnail(it));
        b.addEventListener('click', () => { cur = n; paintCrop(); });
        return b;
      }));
      addMore.disabled = items.length >= 10;
    }
    function paintCrop() {
      paintComposeMedia(cropSlot, items[cur]);
      paintThumbs();
    }
    addMore.addEventListener('click', async () => {
      const extra = await pickMediaFiles();
      await readComposeMedia(extra, items, 4 / 5);
      paintCrop();
    });

    m.body.append(h('div', { class: 'wizard two' },
      h('div', { class: 'crop-col' }, cropSlot, thumbs, h('div', { class: 'crop-more' }, addMore)),
      h('div', {}, meta.box, txt.box)));
    paintCrop();

    const publish = h('button', { class: 'btn primary' }, 'Опубликовать');
    publish.addEventListener('click', async () => {
      publish.disabled = true;
      publish.textContent = 'Публикация…';
      try {
        const fd = new FormData();
        fd.append('text', txt.ta.value);
        fd.append('topic', meta.topicEl.value);
        fd.append('publishAt', meta.dateEl.value);
        await appendMediaFormData(fd, items, 'post');
        state.project = await api('POST', projectUrl() + '/posts', fd);
        m.close();
        drawProject();
        toast('Пост опубликован');
      } catch (e) {
        publish.disabled = false;
        publish.textContent = 'Опубликовать';
        handleErr(e);
      }
    });
    m.foot.append(h('button', { class: 'btn', onClick: m.close }, 'Отмена'), publish);
  }

  async function addStory() {
    const files = await pickMediaFiles();
    if (!files.length) return;
    const items = [];
    await readComposeMedia(files, items, 9 / 16);
    if (!items.length) return;

    const m = modal({ title: 'Новая история', wide: true });
    let previewUrls = [];
    let previewFrame = null;
    let cur = 0;
    m.closed.then(() => {
      releaseComposeMedia(items);
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
    });

    const cropSlot = h('div', { class: 'crop-slot' });
    const thumbs = h('div', { class: 'crop-thumbs' });
    const addMore = h('button', { class: 'btn small', type: 'button' }, 'Добавить медиа');

    function paintThumbs() {
      thumbs.replaceChildren(...items.map((it, n) => {
        const b = h('button', { type: 'button', class: 'crop-thumb' + (n === cur ? ' on' : ''), 'aria-label': 'Медиафайл ' + (n + 1) },
          composeThumbnail(it));
        b.addEventListener('click', () => { cur = n; paintCrop(); });
        return b;
      }));
      addMore.disabled = items.length >= 10;
    }

    function paintCrop() {
      paintComposeMedia(cropSlot, items[cur]);
      paintThumbs();
    }

    function clearPreviews() {
      previewFrame?.querySelectorAll('video').forEach((video) => video.pause());
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls = [];
    }

    addMore.addEventListener('click', async () => {
      const extra = await pickMediaFiles();
      await readComposeMedia(extra, items, 9 / 16);
      paintCrop();
    });

    function stepCrop() {
      clearPreviews();
      m.body.replaceChildren(h('div', { class: 'crop-col' },
        cropSlot, thumbs,
        h('div', { class: 'crop-more' }, addMore)));
      paintCrop();
      m.foot.replaceChildren(
        h('button', { class: 'btn', onClick: m.close }, 'Отмена'),
        h('button', { class: 'btn primary', onClick: stepPick }, 'Далее'));
    }

    function stepPick() {
      const txt = textField({ placeholder: 'Текст, который пойдёт на историю…', label: 'Текст истории' });
      const meta = metaFields({ date: state.view === 'calendar' ? state.calDay : todayISO() });
      previewFrame = h('div', { class: 'story-compose-frame' });
      const preview = h('aside', { class: 'story-compose-preview' },
        h('div', { class: 'lbl' }, 'Медиа истории'),
        previewFrame);
      const publish = h('button', { class: 'btn primary' }, 'Опубликовать');

      async function send() {
        publish.disabled = true;
        publish.textContent = 'Публикация…';
        try {
          const fd = new FormData();
          await appendMediaFormData(fd, items, 'story');
          fd.append('text', txt.ta.value);
          fd.append('topic', meta.topicEl.value);
          fd.append('publishAt', meta.dateEl.value);
          state.project = await api('POST', projectUrl() + '/stories', fd);
          m.close();
          drawProject();
          toast('История добавлена');
        } catch (e) {
          publish.textContent = 'Опубликовать';
          publish.disabled = false;
          handleErr(e);
        }
      }

      publish.addEventListener('click', send);

      m.body.replaceChildren(
        h('div', { class: 'story-compose' },
          h('div', { class: 'story-compose-fields' },
            meta.box, txt.box),
          preview));
      m.foot.replaceChildren(h('button', { class: 'btn', onClick: stepCrop }, 'Назад'), publish);

      Promise.all(items.map(async (item) => {
        if (item.type === 'video') return { type: 'video', src: item.previewUrl };
        const blob = await item.cropper.toBlob(540);
        const src = URL.createObjectURL(blob);
        previewUrls.push(src);
        return { type: 'image', src };
      })).then((previewMedia) => {
        if (!m.el.isConnected || !m.body.contains(previewFrame)) {
          previewMedia.filter((item) => item.type === 'image').forEach((item) => URL.revokeObjectURL(item.src));
          return;
        }
        const previewGallery = gallery(previewMedia, { ratio: '9 / 16' });
        previewFrame.replaceChildren(previewGallery.el);
        previewGallery.go(cur);
      }).catch((e) => toast(e.message));
    }

    stepCrop();
  }

  /* ───────────── главная: список проектов ───────────── */

  function renderLogin() {
    document.title = 'Вход';
    const input = h('input', { class: 'field', type: 'password', placeholder: 'Пароль', autocomplete: 'current-password', 'aria-label': 'Пароль' });
    const err = h('div', { class: 'err' });
    const submit = async () => {
      err.textContent = '';
      try { await doLogin(input.value); } catch (e) { err.textContent = e.message; input.select(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    app.replaceChildren(h('div', { class: 'login' },
      h('h1', {}, 'Проекты'),
      h('p', { class: 'muted' }, 'Введите пароль, чтобы управлять проектами. Страницы проектов открываются по прямой ссылке.'),
      input, err,
      h('button', { class: 'btn primary', onClick: submit }, 'Войти')));
    input.focus();
  }

  async function createProject() {
    const name = await askText({ title: 'Новый проект', placeholder: 'Например, Кофейня «Утро»', ok: 'Создать' });
    if (!name) return;
    guard(async () => {
      const p = await api('POST', '/api/projects', { name });
      location.href = '/p/' + p.slug + '/admin';
    });
  }

  async function exportDatabase() {
    try {
      const response = await fetch('/api/backup');
      if (!response.ok) {
        let message = 'Не удалось экспортировать базу данных.';
        try { message = (await response.json()).error || message; } catch { /* пустой ответ */ }
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'feed-preview-backup.json';
      const url = URL.createObjectURL(blob);
      const link = h('a', { href: url, download: filename });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast('Резервная копия скачана');
    } catch (error) { handleErr(error); }
  }

  function chooseBackupFile() {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
      let settled = false;
      const done = (file) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(file || null);
      };
      input.addEventListener('change', () => done(input.files?.[0]));
      input.addEventListener('cancel', () => done(null));
      document.body.append(input);
      input.click();
    });
  }

  async function importDatabase() {
    const file = await chooseBackupFile();
    if (!file) return;
    const maxBytes = 256 * 1024 * 1024;
    if (file.size > maxBytes) return toast('Размер резервной копии не должен превышать 256 МБ');
    const confirmed = await askConfirm({
      title: 'Импорт базы данных?',
      text: `Файл «${file.name}» заменит текущие проекты, посты, сторис и медиафайлы. Продолжить?`,
      ok: 'Заменить базу',
    });
    if (!confirmed) return;
    const form = new FormData();
    form.append('backup', file, file.name);
    try {
      const result = await api('POST', '/api/backup/import', form);
      await renderHome();
      toast(`Восстановлено проектов: ${result.projects}`);
    } catch (error) { handleErr(error); }
  }

  function databaseMenu() {
    sheet([
      { icon: I.download, label: 'Экспорт базы данных', run: exportDatabase },
      { icon: I.upload, label: 'Импорт базы данных', run: importDatabase },
    ]);
  }

  async function renderHome() {
    document.title = 'Проекты';
    if (!state.editor) return renderLogin();
    app.replaceChildren(h('div', { class: 'center muted' }, 'Загрузка…'));
    let list;
    try { list = await api('GET', '/api/projects'); } catch (e) {
      if (e.status === 401) { state.editor = false; return renderLogin(); }
      return app.replaceChildren(h('div', { class: 'center' }, h('h1', {}, 'Ошибка'), h('p', { class: 'muted' }, e.message)));
    }
    const cards = list.map((p) =>
      h('a', { class: 'card', href: '/p/' + p.slug + '/admin' },
        h('div', { class: 'card-cover' },
          p.cover ? h('img', { src: p.cover, alt: '', loading: 'lazy' }) : h('span', { class: 'card-initial' }, p.name.trim().charAt(0).toUpperCase())),
        h('div', { class: 'card-name' }, p.name),
        h('div', { class: 'card-meta muted' },
          `${p.posts} ${plural(p.posts, ['пост', 'поста', 'постов'])} · ${p.stories} ${plural(p.stories, ['история', 'истории', 'историй'])}`)));
    app.replaceChildren(
      h('header', { class: 'top' },
        h('div', { class: 'slot' }),
        h('h1', {}, 'Проекты'),
        h('div', { class: 'slot end' }, [
          h('button', { class: 'icon-btn', 'aria-label': 'Импорт и экспорт базы данных', onClick: databaseMenu, html: I.more }),
          state.protected ? h('button', { class: 'btn small', onClick: () => guard(doLogout) }, 'Выйти') : null,
        ])),
      h('section', { class: 'projects', 'aria-label': 'Проекты' },
        h('button', { class: 'card add', onClick: createProject },
          h('div', { class: 'card-cover dashed', html: I.plus }),
          h('div', { class: 'card-name' }, 'Новый проект')),
        cards));
  }

  /* ───────────── страница проекта ───────────── */

  const pv = { el: null, id: null, pushed: false, editing: false, cleanup: null };

  function drawProject() {
    const p = state.project;
    const ed = state.editor;
    document.title = p.name;

    const top = h('header', { class: 'top' },
      h('div', { class: 'slot' }, ed ? h('a', { class: 'icon-btn', href: '/', 'aria-label': 'Все проекты', html: I.back }) : null),
      h('h1', {}, p.name),
      h('div', { class: 'slot end' }, ed ? [
        h('button', { class: 'icon-btn', 'aria-label': 'Скопировать ссылку для клиента', onClick: copyLink, html: I.link }),
        h('button', { class: 'icon-btn', 'aria-label': 'Меню проекта', onClick: projectMenu, html: I.more }),
      ] : null));

    const views = h('div', { class: 'view-switch', role: 'tablist', 'aria-label': 'Вид' },
      [['feed', I.feed, 'Лента'], ['calendar', I.cal, 'Календарь']].map(([id, icon, label]) =>
        h('button', {
          class: 'view-btn' + (state.view === id ? ' on' : ''),
          role: 'tab', 'aria-selected': String(state.view === id),
          onClick: () => setView(id), html: icon + '<span>' + label + '</span>',
        })));

    const body = state.view === 'calendar' ? drawCalendar(p, ed)
      : state.view === 'grid' ? drawGrid(p, ed)
      : drawFeed(p, ed);

    const foot = state.adminMode && state.protected && !ed
      ? h('div', { class: 'foot-link' }, h('button', { onClick: openLogin }, 'Войти для редактирования'))
      : null;

    app.replaceChildren(...[top, views, body, foot].filter(Boolean));
  }

  function postTile(post, i, total) {
    const media = postMedia(post);
    return h('a', {
      class: 'tile', href: '#post=' + post.id, 'aria-label': 'Открыть пост ' + (total - i),
      onClick: (e) => { if (!(e.metaKey || e.ctrlKey || e.shiftKey)) pv.pushed = true; },
    },
      mediaThumbnail(media[0]),
      media.length > 1 ? h('span', { class: 'tile-badge', html: I.stack, title: 'Галерея' }) : null);
  }

  function drawGrid(p, ed) {
    const highlights = p.highlights.filter((x) => x.stories.length && !x.autoStoryBucket);
    const stories = ed || highlights.length
      ? h('section', { class: 'stories', 'aria-label': 'Истории' },
          ed ? h('button', { class: 'story', onClick: addStory },
            h('span', { class: 'ring add', html: I.plus }), h('span', { class: 'label' }, 'Новая')) : null,
          highlights.map((hl) =>
            h('button', { class: 'story', onClick: () => openStories(hl.id) },
              h('span', { class: 'ring' }, mediaThumbnail(storyMedia(hl.stories[0])[0])),
              h('span', { class: 'label' }, hl.title))))
      : null;
    const tiles = p.posts.map((post, i) => postTile(post, i, p.posts.length));
    const grid = h('section', { class: 'grid', 'aria-label': 'Посты' },
      ed ? h('button', { class: 'tile add', 'aria-label': 'Добавить пост', onClick: addPost, html: I.plus }) : null,
      tiles);
    const empty = !ed && !p.posts.length && !highlights.length ? h('div', { class: 'empty' }, 'Постов пока нет') : null;
    return h('div', {}, stories, grid, empty);
  }

  function drawFeed(p, ed) {
    const tab = state.feedTab === 'stories' ? 'stories' : 'posts';
    const tabs = h('div', { class: 'feed-tabs', role: 'tablist', 'aria-label': 'Лента' },
      [['posts', 'Посты'], ['stories', 'Сторис']].map(([id, label]) =>
        h('button', {
          class: 'feed-tab' + (tab === id ? ' on' : ''),
          role: 'tab', 'aria-selected': String(tab === id),
          onClick: () => setFeedTab(id),
        }, label)));

    if (tab === 'stories') {
      const list = flatStories(p).sort(byDay);
      return h('div', {}, tabs,
        ed ? h('div', { class: 'feed-add' }, h('button', { class: 'btn primary', onClick: addStory, html: I.plus + '<span>Новая история</span>' })) : null,
        list.length ? h('section', { class: 'feed-list story-feed-list', 'aria-label': 'Сторис' }, list.map(feedStoryCard))
          : h('div', { class: 'empty' }, ed ? 'Историй пока нет — добавьте первую' : 'Историй пока нет'));
    }

    const list = [...p.posts].sort(byDay);
    return h('div', {}, tabs,
      ed ? h('div', { class: 'feed-add' }, h('button', { class: 'btn primary', onClick: addPost, html: I.plus + '<span>Новый пост</span>' })) : null,
      list.length ? h('section', { class: 'feed-list post-feed-list', 'aria-label': 'Посты' }, list.map(feedPostCard))
        : h('div', { class: 'empty' }, ed ? 'Постов пока нет — добавьте первый' : 'Постов пока нет'));
  }

  function cardMeta(item, extra) {
    return h('div', { class: 'feed-meta' },
      item.topic ? h('span', { class: 'chip' }, item.topic) : null,
      h('span', { class: 'muted' }, fmtDate(itemDay(item))),
      extra || null);
  }

  function feedPostCard(post) {
    const media = postMedia(post);
    const openPost = () => { pv.pushed = true; location.hash = '#post=' + post.id; };
    return h('article', {
      class: 'feed-card post-card',
      onClick: (e) => { if (e.target === e.currentTarget) openPost(); },
    },
      cardMeta(post, media.length > 1 ? h('span', { class: 'muted' }, `${media.length} ${plural(media.length, ['файл', 'файла', 'файлов'])}`) : null),
      h('div', { class: 'post-caption' },
        h('div', { class: 'post-caption-label' }, 'Текст поста'),
        h('div', { class: 'feed-text' }, post.text || h('span', { class: 'muted' }, 'Без текста'))),
      h('div', {
        class: 'feed-media',
        onClick: openPost,
      }, gallery(media).el));
  }

  function feedStoryCard(story) {
    return h('article', {
      class: 'feed-card story-card',
      onClick: (e) => { if (e.target === e.currentTarget) openStories(story.highlightId, story.id); },
    },
      cardMeta(story, story.autoStoryBucket ? null : h('span', { class: 'muted' }, story.highlightTitle)),
      h('div', { class: 'story-caption' },
        h('div', { class: 'story-caption-label' }, 'Текст истории'),
        h('div', { class: 'feed-text' }, story.text || h('span', { class: 'muted' }, 'Текст ещё не добавлен'))),
      h('div', {
        class: 'feed-story-media', role: 'button', tabindex: '0',
        'aria-label': 'Открыть сторис',
        onClick: () => openStories(story.highlightId, story.id),
        onKeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('video, .gal-nav, .gal-dot')) {
            e.preventDefault();
            openStories(story.highlightId, story.id);
          }
        },
      }, gallery(storyMedia(story), { ratio: '9 / 16' }).el));
  }

  function drawCalendar(p, ed) {
    const now = new Date();
    if (!state.calMonth) state.calMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [yy, mm] = state.calMonth.split('-').map(Number);
    const first = new Date(yy, mm - 1, 1);
    const daysIn = new Date(yy, mm, 0).getDate();
    const startPad = (first.getDay() + 6) % 7; // понедельник — первый
    const monthLabel = first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

    const posts = p.posts.map((x) => ({ kind: 'post', ...x }));
    const stories = flatStories(p).map((x) => ({ kind: 'story', ...x }));
    const items = [...posts, ...stories];
    const byDate = new Map();
    items.forEach((it) => {
      const d = itemDay(it);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(it);
    });

    const shift = (delta) => {
      const dt = new Date(yy, mm - 1 + delta, 1);
      state.calMonth = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      drawProject();
    };

    function showDay(iso, dayItems) {
      const m = modal({ title: fmtDate(iso) });
      m.el.classList.add('cal-popup');
      const list = [...dayItems].sort(byDay);
      if (list.length) {
        m.body.append(h('div', { class: 'cal-day-list' }, list.map((it) => {
          if (it.kind === 'post') {
            const media = postMedia(it);
            return h('button', {
              class: 'cal-item',
              'aria-label': `Открыть пост${it.topic ? ' «' + it.topic + '»' : ''}`,
              onClick: () => {
                m.close();
                const hash = '#post=' + it.id;
                if (location.hash === hash) showPost(it.id);
                else { pv.pushed = true; location.hash = hash; }
              },
            },
              mediaThumbnail(media[0]),
              h('div', {},
                h('div', { class: 'cal-item-k post' }, h('span', { class: 'cal-item-title' }, 'Пост' + (it.topic ? ' · ' + it.topic : ''))),
                h('div', { class: 'muted' }, it.text ? it.text.slice(0, 90) : 'Без текста')));
          }
          return h('button', {
            class: 'cal-item cal-story-item',
            'aria-label': `Открыть сторис${it.topic ? ' «' + it.topic + '»' : ''}`,
            onClick: () => { m.close(); openStories(it.highlightId, it.id); },
          },
            mediaThumbnail(storyMedia(it)[0]),
            h('div', {},
              h('div', { class: 'cal-item-k story-type' }, h('span', { class: 'cal-item-title' }, 'Сторис' + (it.topic ? ' · ' + it.topic : ''))),
              h('div', { class: 'muted' }, it.text ? it.text.slice(0, 90) : 'Текст ещё не добавлен')));
        })));
      } else {
        m.body.append(h('div', { class: 'empty calendar-empty' }, 'На эту дату ничего не запланировано'));
      }
      if (ed) {
        m.foot.append(
          h('button', { class: 'btn small', onClick: () => { m.close(); addPost(); } }, 'Добавить пост'),
          h('button', { class: 'btn small', onClick: () => { m.close(); addStory(); } }, 'Добавить сторис'));
      }
    }

    const cells = [];
    for (let i = 0; i < startPad; i++) cells.push(h('div', { class: 'cal-cell empty' }));
    for (let day = 1; day <= daysIn; day++) {
      const iso = `${yy}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayItems = byDate.get(iso) || [];
      const previews = [...dayItems].sort(byDay).slice(0, 3).map((it) => {
        const kind = it.kind === 'post' ? 'Пост' : 'Сторис';
        const title = it.topic || kind;
        return h('span', { class: 'cal-preview', title: kind + ': ' + title },
          h('i', { class: 'cal-preview-dot ' + it.kind }),
          h('span', { class: 'cal-preview-text' }, title));
      });
      if (dayItems.length > previews.length) {
        previews.push(h('span', { class: 'cal-preview-more' }, `+${dayItems.length - previews.length} ещё`));
      }
      cells.push(h('button', {
        class: 'cal-cell' + (iso === state.calDay ? ' on' : '') + (dayItems.length ? ' has' : ''),
        'aria-label': `${fmtDate(iso)}${dayItems.length ? `, публикаций: ${dayItems.length}` : ''}`,
        onClick: () => { state.calDay = iso; drawProject(); showDay(iso, dayItems); },
      },
        h('span', { class: 'cal-num' }, String(day)),
        previews.length ? h('span', { class: 'cal-previews' }, previews) : null));
    }

    return h('div', { class: 'cal' },
      h('div', { class: 'cal-nav' },
        h('button', { class: 'icon-btn', 'aria-label': 'Предыдущий месяц', onClick: () => shift(-1), html: I.back }),
        h('h2', {}, monthLabel),
        h('button', { class: 'icon-btn', 'aria-label': 'Следующий месяц', onClick: () => shift(1), html: I.next })),
      h('div', { class: 'cal-legend', 'aria-label': 'Обозначения календаря' },
        h('span', {}, h('i', { class: 'cal-legend-dot post' }), 'Посты'),
        h('span', {}, h('i', { class: 'cal-legend-dot story' }), 'Сторис')),
      h('p', { class: 'cal-hint' }, 'Выберите дату, чтобы увидеть публикации. Нажмите на карточку, чтобы открыть пост или сторис.'),
      h('div', { class: 'cal-month-grid' },
        h('div', { class: 'cal-week' }, ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((d) => h('span', {}, d))),
        h('div', { class: 'cal-grid' }, cells)));
  }

  const clientProjectUrl = () => location.origin + '/p/' + state.project.slug;
  const adminProjectUrl = () => clientProjectUrl() + '/admin';
  const copyLink = () => copyText(clientProjectUrl(), 'Ссылка для чтения скопирована');
  const copyAdminLink = () => copyText(adminProjectUrl(), 'Админская ссылка скопирована');

  function projectMenu() {
    sheet([
      { icon: I.link, label: 'Скопировать ссылку для клиента', run: copyLink },
      { icon: I.edit, label: 'Скопировать админскую ссылку', run: copyAdminLink },
      { icon: I.edit, label: 'Переименовать проект', run: renameProject },
      { icon: I.trash, label: 'Удалить проект', danger: true, run: deleteProject },
      state.protected ? { icon: I.out, label: 'Выйти', run: () => guard(doLogout) } : null,
    ]);
  }

  async function renameProject() {
    const name = await askText({ title: 'Название проекта', value: state.project.name });
    if (!name || name === state.project.name) return;
    guard(async () => {
      state.project = await api('PATCH', projectUrl(), { name });
      drawProject();
    });
  }

  async function deleteProject() {
    const ok = await askConfirm({
      title: `Удалить «${state.project.name}»?`,
      text: 'Все посты и истории проекта будут удалены безвозвратно, а ссылка перестанет работать.',
    });
    if (!ok) return;
    guard(async () => {
      await api('DELETE', projectUrl());
      location.href = '/';
    });
  }

  async function renderProject(slug) {
    app.replaceChildren(h('div', { class: 'center muted' }, 'Загрузка…'));
    try {
      state.project = await api('GET', '/api/projects/' + slug);
    } catch (e) {
      document.title = 'Не найдено';
      app.replaceChildren(h('div', { class: 'center' },
        h('h1', {}, e.status === 404 ? 'Проект не найден' : 'Ошибка'),
        h('p', { class: 'muted' }, e.status === 404 ? 'Проверьте ссылку или обратитесь к автору.' : e.message),
        state.editor ? h('a', { class: 'btn', href: '/' }, 'Ко всем проектам') : null));
      return;
    }
    drawProject();
    syncHash();
  }

  /* ───────────── просмотр поста ───────────── */

  function syncHash() {
    const m = location.hash.match(/^#post=([\w-]+)$/);
    if (m && state.project && state.project.posts.some((p) => p.id === m[1])) showPost(m[1]);
    else hidePost();
  }
  window.addEventListener('hashchange', syncHash);

  function hidePost() {
    if (pv.cleanup) { pv.cleanup(); pv.cleanup = null; }
    if (pv.el) { unmount(pv.el); pv.el = null; }
    pv.id = null;
    pv.pushed = false;
    pv.editing = false;
  }
  function closePost() {
    if (pv.pushed) { pv.pushed = false; history.back(); } // хэш добавили мы — откатываем историю
    else { history.replaceState(null, '', location.pathname + location.search); hidePost(); }
  }
  function stepPost(d) {
    const posts = state.project.posts;
    const i = posts.findIndex((p) => p.id === pv.id);
    const next = posts[(i + d + posts.length) % posts.length];
    if (!next || next.id === pv.id) return;
    history.replaceState(null, '', '#post=' + next.id);
    showPost(next.id);
  }

  function showPost(id) {
    if (pv.cleanup) { pv.cleanup(); pv.cleanup = null; }
    const p = state.project;
    const idx = p.posts.findIndex((x) => x.id === id);
    if (idx < 0) return hidePost();
    const post = p.posts[idx];
    pv.id = id;
    pv.editing = false;

    if (!pv.el) {
      pv.el = h('div', { class: 'pv', onMousedown: (e) => { if (e.target === pv.el) closePost(); } });
      pv.el._onKey = (e) => {
        if (e.key === 'Escape') return pv.editing ? showPost(pv.id) : closePost();
        if (/^(INPUT|TEXTAREA|VIDEO)$/.test(e.target.tagName)) return;
        if (e.key === 'ArrowLeft') stepPost(-1);
        if (e.key === 'ArrowRight') stepPost(1);
      };
      mount(pv.el);
    }

    const media = postMedia(post);
    const filename = (item) => `${p.slug}-post-${String(p.posts.length - idx).padStart(2, '0')}.${extOf(item?.src || media[0]?.src || 'jpg')}`;
    const textBox = h('div', { class: 'pv-text' }, post.text ? post.text : h('span', { class: 'muted' }, 'Без текста'));
    const dlLabel = h('span', {}, 'Скачать медиафайл');
    const dl = h('a', { class: 'btn', href: media[0]?.src, download: filename(media[0]), html: I.download }, dlLabel);
    const gal = gallery(media, {
      onChange: (item) => {
        dl.href = item.src;
        dl.download = filename(item);
        dlLabel.textContent = item.type === 'video' ? 'Скачать видео' : 'Скачать фото';
      },
    });

    const actions = h('div', { class: 'pv-actions' },
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', disabled: !post.text, onClick: () => copyText(post.text, 'Текст скопирован'), html: I.copy + '<span>Копировать текст</span>' }),
        dl),
      state.editor ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onClick: () => editPost(post, textBox, actions), html: I.edit + '<span>Редактировать</span>' }),
        h('button', { class: 'btn small danger', onClick: () => removePost(post), html: I.trash + '<span>Удалить</span>' })) : null);

    pv.el.replaceChildren(
      h('div', { class: 'pv-card' },
        h('div', { class: 'pv-media' }, gal.el),
        h('div', { class: 'pv-side' },
          h('div', { class: 'pv-meta muted' },
            h('span', {}, [post.topic ? post.topic + ' · ' : '', fmtDate(itemDay(post))].join('')),
            h('span', {}, `${idx + 1} / ${p.posts.length}`)),
          textBox, actions)),
      h('button', { class: 'round-btn pv-close', 'aria-label': 'Закрыть', onClick: closePost, html: I.close }),
      p.posts.length > 1 ? h('button', { class: 'round-btn pv-prev', 'aria-label': 'Предыдущий пост', onClick: () => stepPost(-1), html: I.back }) : null,
      p.posts.length > 1 ? h('button', { class: 'round-btn pv-next', 'aria-label': 'Следующий пост', onClick: () => stepPost(1), html: I.next }) : null);
  }

  function editPost(post, textBox, actions) {
    pv.editing = true;
    const txt = textField({ value: post.text, placeholder: 'Текст поста…', label: 'Подпись' });
    const meta = metaFields({ topic: post.topic || '', date: itemDay(post) });
    let replacementItems = [];
    let replacementIndex = 0;
    const replacementCrop = h('div', { class: 'edit-media-crop' });
    const replacementThumbs = h('div', { class: 'crop-thumbs' });
    const replacementPreview = h('div', { class: 'edit-media-preview', hidden: true }, replacementCrop, replacementThumbs);
    const chooseMedia = h('button', { class: 'btn small', type: 'button' }, 'Заменить медиа');
    const cancelReplacement = h('button', { class: 'btn small', type: 'button', hidden: true }, 'Оставить текущее');
    const cleanupReplacement = () => {
      releaseComposeMedia(replacementItems);
      replacementItems = [];
      if (pv.cleanup === cleanupReplacement) pv.cleanup = null;
    };
    pv.cleanup = cleanupReplacement;
    function paintReplacement() {
      replacementPreview.hidden = !replacementItems.length;
      cancelReplacement.hidden = !replacementItems.length;
      chooseMedia.textContent = replacementItems.length ? 'Выбрать другие файлы' : 'Заменить медиа';
      if (!replacementItems.length) {
        replacementCrop.replaceChildren();
        replacementThumbs.replaceChildren();
        return;
      }
      paintComposeMedia(replacementCrop, replacementItems[replacementIndex]);
      replacementThumbs.replaceChildren(...replacementItems.map((item, index) => {
        const thumb = h('button', { type: 'button', class: 'crop-thumb' + (index === replacementIndex ? ' on' : ''), 'aria-label': 'Медиафайл ' + (index + 1) }, composeThumbnail(item));
        thumb.addEventListener('click', () => { replacementIndex = index; paintReplacement(); });
        return thumb;
      }));
    }
    chooseMedia.addEventListener('click', async () => {
      const files = await pickMediaFiles();
      if (!files.length) return;
      const nextItems = [];
      await readComposeMedia(files, nextItems, 4 / 5, Math.min(320, window.innerWidth - 48));
      if (!nextItems.length) return;
      releaseComposeMedia(replacementItems);
      replacementItems = nextItems;
      replacementIndex = 0;
      pv.cleanup = cleanupReplacement;
      paintReplacement();
    });
    cancelReplacement.addEventListener('click', () => {
      cleanupReplacement();
      paintReplacement();
    });
    const replacementEditor = h('div', { class: 'edit-media-editor' },
      h('div', { class: 'lbl' }, 'Медиа поста'),
      h('div', { class: 'edit-media-controls' }, chooseMedia, cancelReplacement),
      h('p', { class: 'muted edit-media-note' }, 'Выбор заменит всю текущую галерею. Можно выбрать до 10 фото и видео.'),
      replacementPreview);
    const save = h('button', { class: 'btn primary small' }, 'Сохранить');
    save.addEventListener('click', () => guard(async () => {
      save.disabled = true;
      const saveLabel = save.textContent;
      save.textContent = 'Сохраняю…';
      try {
        let payload = {
          text: txt.ta.value, topic: meta.topicEl.value, publishAt: meta.dateEl.value,
        };
        if (replacementItems.length) {
          const form = new FormData();
          form.append('text', txt.ta.value);
          form.append('topic', meta.topicEl.value);
          form.append('publishAt', meta.dateEl.value);
          await appendMediaFormData(form, replacementItems, 'post');
          payload = form;
        }
        const updatedProject = await api('PATCH', `${projectUrl()}/posts/${post.id}`, payload);
        if (replacementItems.length) {
          const updatedPost = updatedProject.posts.find((item) => item.id === post.id);
          const previousMedia = postMedia(post).map((item) => `${item.type}:${item.src}`);
          const savedMedia = updatedPost ? postMedia(updatedPost).map((item) => `${item.type}:${item.src}`) : [];
          if (JSON.stringify(previousMedia) === JSON.stringify(savedMedia)) {
            throw new Error('Сервер не применил замену медиа. Перезапустите сервер проекта и повторите попытку.');
          }
        }
        state.project = updatedProject;
      } finally { save.disabled = false; save.textContent = saveLabel; }
      drawProject();
      showPost(post.id);
      toast('Сохранено');
    }));
    textBox.replaceWith(h('div', { class: 'pv-text' }, meta.box, txt.box, replacementEditor));
    actions.replaceChildren(h('div', { class: 'row' }, save, h('button', { class: 'btn small', onClick: () => showPost(post.id) }, 'Отмена')));
    txt.ta.focus();
  }

  async function removePost(post) {
    const ok = await askConfirm({ title: 'Удалить пост?', text: 'Медиафайлы и текст будут удалены безвозвратно.' });
    if (!ok) return;
    guard(async () => {
      const posts = state.project.posts;
      const i = posts.findIndex((p) => p.id === post.id);
      state.project = await api('DELETE', `${projectUrl()}/posts/${post.id}`);
      drawProject();
      const left = state.project.posts;
      if (!left.length) return closePost();
      const next = left[Math.min(i, left.length - 1)];
      history.replaceState(null, '', '#post=' + next.id);
      showPost(next.id);
    });
  }

  /* ───────────── просмотр историй ───────────── */

  function openStories(hlId, start = 0) {
    let hl = state.project.highlights.find((x) => x.id === hlId);
    if (!hl) return;
    let i = typeof start === 'string'
      ? Math.max(0, hl.stories.findIndex((s) => s.id === start))
      : Math.min(start, hl.stories.length - 1);
    let photoIndex = 0;
    let editing = false;
    let editMediaCleanup = null;
    let heldAt = 0, holding = false;
    let downloadLink = null;
    let downloadLabel = null;

    const bars = h('div', { class: 'sv-bars' });
    const title = h('div', { class: 'sv-title' });
    const img = h('img', { class: 'sv-img', alt: '', draggable: 'false' });
    const video = h('video', { class: 'sv-video', controls: true, playsinline: true, preload: 'metadata', hidden: true });
    const tap = h('div', { class: 'sv-tap' });
    const photoPrev = h('button', { class: 'sv-photo-nav prev', 'aria-label': 'Предыдущий медиафайл истории', hidden: true, html: I.back });
    const photoNext = h('button', { class: 'sv-photo-nav next', 'aria-label': 'Следующий медиафайл истории', hidden: true, html: I.next });
    const photoCount = h('span', { class: 'sv-photo-count', hidden: true });
    const top = h('div', { class: 'sv-top' }, bars, h('div', { class: 'sv-head' }, title));
    const frame = h('div', { class: 'sv-frame' }, img, video, tap, top, photoPrev, photoNext, photoCount);
    const side = h('div', { class: 'sv-side' });
    const card = h('div', { class: 'sv-card' },
      side,
      h('div', { class: 'sv-media' }, frame));
    const root = h('div', { class: 'sv', onMousedown: (e) => { if (e.target === root) close(); } },
      card,
      h('button', { class: 'round-btn pv-close', 'aria-label': 'Закрыть', onClick: close, html: I.close }),
      h('button', { class: 'round-btn pv-prev', 'aria-label': 'Назад', onClick: () => go(i - 1), html: I.back }),
      h('button', { class: 'round-btn pv-next', 'aria-label': 'Вперёд', onClick: () => go(i + 1), html: I.next }));

    function buildBars() {
      bars.replaceChildren(...hl.stories.flatMap((s) => storyMedia(s).map(() => h('div', { class: 'sv-bar' }, h('i')))));
    }
    function paintBars() {
      const current = hl.stories.slice(0, i).reduce((n, s) => n + storyMedia(s).length, 0) + photoIndex;
      [...bars.children].forEach((b, n) => {
        b.firstChild.style.width = (n <= current ? 100 : 0) + '%';
      });
    }
    function setPhoto(n) {
      const media = storyMedia(hl.stories[i]);
      if (!media.length) return;
      photoIndex = ((n % media.length) + media.length) % media.length;
      const current = media[photoIndex];
      const isVideo = current.type === 'video';
      video.pause();
      video.hidden = !isVideo;
      img.hidden = isVideo;
      tap.hidden = isVideo;
      if (isVideo) {
        if (video.src !== new URL(current.src, location.href).href) video.src = current.src;
        video.load();
      } else {
        video.removeAttribute('src');
        video.load();
        img.src = current.src;
      }
      photoPrev.hidden = media.length < 2;
      photoNext.hidden = media.length < 2;
      photoCount.hidden = media.length < 2;
      photoCount.textContent = `${photoIndex + 1} / ${media.length}`;
      if (downloadLink) {
        downloadLink.href = current.src;
        downloadLink.download = `${state.project.slug}-story-${i + 1}-${photoIndex + 1}.${extOf(current.src)}`;
        downloadLabel.textContent = isVideo ? 'Скачать видео' : 'Скачать фото';
      }
      paintBars();
    }
    function close() {
      if (editMediaCleanup) { editMediaCleanup(); editMediaCleanup = null; }
      if (root.isConnected) unmount(root);
    }
    function go(n) {
      if (editing) {
        if (editMediaCleanup) { editMediaCleanup(); editMediaCleanup = null; }
        editing = false;
      }
      if (n < 0) n = hl.stories.length - 1;
      if (n >= hl.stories.length) n = 0;
      i = n;
      photoIndex = 0;
      show();
    }

    photoPrev.addEventListener('click', (e) => { e.stopPropagation(); setPhoto(photoIndex - 1); });
    photoNext.addEventListener('click', (e) => { e.stopPropagation(); setPhoto(photoIndex + 1); });

    function paintSide() {
      const s = hl.stories[i];
      if (editing) {
        const txt = textField({ value: s.text || '', placeholder: 'Текст, который пойдёт на историю…', label: 'Текст истории' });
        const meta = metaFields({ topic: s.topic || '', date: itemDay(s) });
        let replacementItems = [];
        let replacementIndex = 0;
        const replacementCrop = h('div', { class: 'edit-media-crop' });
        const replacementThumbs = h('div', { class: 'crop-thumbs' });
        const replacementPreview = h('div', { class: 'edit-media-preview', hidden: true }, replacementCrop, replacementThumbs);
        const chooseMedia = h('button', { class: 'btn small', type: 'button' }, 'Заменить медиа');
        const cancelReplacement = h('button', { class: 'btn small', type: 'button', hidden: true }, 'Оставить текущее');
        const cleanupReplacement = () => {
          releaseComposeMedia(replacementItems);
          replacementItems = [];
          if (editMediaCleanup === cleanupReplacement) editMediaCleanup = null;
        };
        editMediaCleanup = cleanupReplacement;
        function paintReplacement() {
          replacementPreview.hidden = !replacementItems.length;
          cancelReplacement.hidden = !replacementItems.length;
          chooseMedia.textContent = replacementItems.length ? 'Выбрать другие файлы' : 'Заменить медиа';
          if (!replacementItems.length) {
            replacementCrop.replaceChildren();
            replacementThumbs.replaceChildren();
            return;
          }
          paintComposeMedia(replacementCrop, replacementItems[replacementIndex]);
          replacementThumbs.replaceChildren(...replacementItems.map((item, index) => {
            const thumb = h('button', { type: 'button', class: 'crop-thumb' + (index === replacementIndex ? ' on' : ''), 'aria-label': 'Медиафайл ' + (index + 1) }, composeThumbnail(item));
            thumb.addEventListener('click', () => { replacementIndex = index; paintReplacement(); });
            return thumb;
          }));
        }
        chooseMedia.addEventListener('click', async () => {
          const files = await pickMediaFiles();
          if (!files.length) return;
          const nextItems = [];
          await readComposeMedia(files, nextItems, 9 / 16, Math.min(240, window.innerWidth - 48));
          if (!nextItems.length) return;
          releaseComposeMedia(replacementItems);
          replacementItems = nextItems;
          replacementIndex = 0;
          editMediaCleanup = cleanupReplacement;
          paintReplacement();
        });
        cancelReplacement.addEventListener('click', () => {
          cleanupReplacement();
          paintReplacement();
        });
        const replacementEditor = h('div', { class: 'edit-media-editor story-edit-media' },
          h('div', { class: 'lbl' }, 'Медиа сторис'),
          h('div', { class: 'edit-media-controls' }, chooseMedia, cancelReplacement),
          h('p', { class: 'muted edit-media-note' }, 'Выбор заменит всю текущую галерею. Можно выбрать до 10 фото и видео.'),
          replacementPreview);
        const save = h('button', { class: 'btn primary small' }, 'Сохранить');
        save.addEventListener('click', () => guard(async () => {
          save.disabled = true;
          const saveLabel = save.textContent;
          save.textContent = 'Сохраняю…';
          try {
            let payload = {
              text: txt.ta.value, topic: meta.topicEl.value, publishAt: meta.dateEl.value,
            };
            if (replacementItems.length) {
              const form = new FormData();
              form.append('text', txt.ta.value);
              form.append('topic', meta.topicEl.value);
              form.append('publishAt', meta.dateEl.value);
              await appendMediaFormData(form, replacementItems, 'story');
              payload = form;
            }
            const updatedProject = await api('PATCH', `${projectUrl()}/highlights/${hlId}/stories/${s.id}`, payload);
            if (replacementItems.length) {
              const updatedStory = updatedProject.highlights.find((item) => item.id === hlId)?.stories.find((item) => item.id === s.id);
              const previousMedia = storyMedia(s).map((item) => `${item.type}:${item.src}`);
              const savedMedia = updatedStory ? storyMedia(updatedStory).map((item) => `${item.type}:${item.src}`) : [];
              if (JSON.stringify(previousMedia) === JSON.stringify(savedMedia)) {
                throw new Error('Сервер не применил замену медиа. Перезапустите сервер проекта и повторите попытку.');
              }
            }
            state.project = updatedProject;
          } finally { save.disabled = false; save.textContent = saveLabel; }
          if (editMediaCleanup) { editMediaCleanup(); editMediaCleanup = null; }
          editing = false;
          afterChange();
          toast('Сохранено');
        }));
        side.replaceChildren(
          h('div', { class: 'sv-edit-content' }, meta.box, txt.box, replacementEditor),
          h('div', { class: 'row' }, save, h('button', { class: 'btn small', onClick: () => { editing = false; show(); } }, 'Отмена')));
        txt.ta.focus();
        return;
      }

      const media = storyMedia(s);
      const activeMedia = media[photoIndex] || media[0];
      downloadLabel = h('span', {}, activeMedia?.type === 'video' ? 'Скачать видео' : 'Скачать фото');
      const dl = h('a', { class: 'btn', href: activeMedia?.src, download: `${state.project.slug}-story-${i + 1}-${photoIndex + 1}.${extOf(activeMedia?.src || 'jpg')}`, html: I.download }, downloadLabel);
      downloadLink = dl;
      side.replaceChildren(
        h('div', { class: 'pv-meta muted' },
          h('span', {}, [s.topic ? s.topic + ' · ' : '', fmtDate(itemDay(s))].join('')),
          h('span', {}, `${i + 1} / ${hl.stories.length}`)),
        h('div', { class: 'pv-text' }, s.text ? s.text : h('span', { class: 'muted' }, 'Текст ещё не добавлен')),
        h('div', { class: 'pv-actions' },
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', disabled: !s.text, onClick: () => copyText(s.text, 'Текст скопирован'), html: I.copy + '<span>Копировать текст</span>' }),
            dl),
          state.editor ? h('div', { class: 'row' },
            h('button', { class: 'btn small', onClick: () => { editing = true; paintSide(); }, html: I.edit + '<span>Редактировать</span>' }),
            h('button', { class: 'btn small', onClick: menu, html: I.more + '<span>Ещё</span>' })) : null));
    }

    function show() {
      if (!editing && editMediaCleanup) { editMediaCleanup(); editMediaCleanup = null; }
      const s = hl.stories[i];
      title.textContent = hl.title;
      downloadLink = null;
      downloadLabel = null;
      setPhoto(photoIndex);
      paintBars();
      paintSide();
    }

    tap.addEventListener('pointerdown', (e) => {
      holding = true;
      heldAt = performance.now();
      tap.setPointerCapture(e.pointerId);
    });
    tap.addEventListener('pointerup', (e) => {
      holding = false;
      if (performance.now() - heldAt < 250) {
        const r = tap.getBoundingClientRect();
        const delta = e.clientX - r.left < r.width * 0.3 ? -1 : 1;
        if (storyMedia(hl.stories[i]).length > 1) setPhoto(photoIndex + delta);
        else go(i + delta);
      }
    });
    tap.addEventListener('pointercancel', () => { holding = false; });

    root._onKey = (e) => {
      if (e.key === 'Escape') return editing ? (editing = false, show()) : close();
      if (/^(INPUT|TEXTAREA|VIDEO)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') {
        if (storyMedia(hl.stories[i]).length > 1) setPhoto(photoIndex + 1);
        else go(i + 1);
      }
      if (e.key === 'ArrowLeft') {
        if (storyMedia(hl.stories[i]).length > 1) setPhoto(photoIndex - 1);
        else go(i - 1);
      }
    };

    function afterChange() {
      drawProject();
      const next = state.project.highlights.find((x) => x.id === hlId && x.stories.length);
      if (!next) return close();
      hl = next;
      i = Math.min(i, hl.stories.length - 1);
      photoIndex = 0;
      buildBars();
      show();
    }

    function menu() {
      sheet([
        !hl.autoStoryBucket ? { icon: I.edit, label: 'Переименовать кружок', run: async () => {
          const t = await askText({ title: 'Название кружка', value: hl.title, max: 20 });
          if (!t || t === hl.title) return;
          guard(async () => {
            state.project = await api('PATCH', `${projectUrl()}/highlights/${hlId}`, { title: t });
            afterChange();
          });
        } } : null,
        { icon: I.trash, label: 'Удалить эту историю', danger: true, run: async () => {
          const ok = await askConfirm({ title: 'Удалить историю?', text: 'Медиафайлы будут удалены безвозвратно.' });
          if (!ok) return;
          const sid = hl.stories[i].id;
          guard(async () => {
            state.project = await api('DELETE', `${projectUrl()}/highlights/${hlId}/stories/${sid}`);
            afterChange();
          });
        } },
        !hl.autoStoryBucket ? { icon: I.trash, label: 'Удалить весь кружок', danger: true, run: async () => {
          const ok = await askConfirm({ title: `Удалить кружок «${hl.title}»?`, text: 'Все истории в нём будут удалены безвозвратно.' });
          if (!ok) return;
          guard(async () => {
            state.project = await api('DELETE', `${projectUrl()}/highlights/${hlId}`);
            drawProject();
            close();
          });
        } } : null,
      ]);
    }

    mount(root);
    buildBars();
    show();
  }

  /* ───────────── старт ───────────── */

  (async function boot() {
    const route = location.pathname.match(/^\/p\/([a-z0-9-]+)(\/admin)?\/?$/);
    state.adminMode = !!route?.[2];
    try {
      const sessionUrl = state.adminMode ? '/api/session?slug=' + encodeURIComponent(route[1]) : '/api/session';
      const s = await api('GET', sessionUrl);
      state.editor = state.adminMode ? s.editor : (!route && s.editor);
      state.protected = s.protected;
    } catch { /* без сессии работаем как зритель */ }
    if (route) {
      await renderProject(route[1]);
      if (state.adminMode && state.protected && !state.editor) openLogin();
    } else await renderHome();
  })();
})();

