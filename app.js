import { clampRate, nextPlayable } from './player-core.mjs';
const API = 'https://tiktok-tg-player-api.onrender.com';
const ALL = '__all__';
const $ = (id) => document.getElementById(id);
const tg = window.Telegram?.WebApp;
const storage = { get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} } };
let accessKey = '';
try { accessKey = sessionStorage.getItem('player-access') || ''; } catch {}
const prefs = storage.get('player-preferences', {});
const state = { videos: [], playlists: {}, queue: [], current: null, failed: new Set(), rate: clampRate(prefs.rate), volume: Number.isFinite(prefs.volume) ? Math.max(0, Math.min(1, prefs.volume)) : .7, rpt1: !!prefs.rpt1, loop: prefs.loop !== false, want: false, loading: false, retry: 0, generation: 0, lastProgress: Date.now(), position: 0 };
const media = () => $('player');
const savePrefs = () => storage.set('player-preferences', { rate: state.rate, volume: state.volume, rpt1: state.rpt1, loop: state.loop });
const time = (seconds) => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '0:00';
const size = (bytes) => `${(bytes / 1048576).toFixed(1)} МБ`;
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const status = (text) => { $('playback-status').textContent = text; };
let toastTimer;
function toast(message, action, label = 'Отменить') {
  $('toast-message').textContent = message;
  $('toast').hidden = false;
  $('toast-action').hidden = !action;
  $('toast-action').textContent = label;
  $('toast-action').onclick = async () => { $('toast').hidden = true; try { await action(); } catch (e) { toast(e.message); } };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, action ? 15000 : 6000);
}
$('toast-close').onclick = () => { $('toast').hidden = true; };
function headers() { return { ...(accessKey ? { 'x-ingest-key': accessKey } : {}), ...(tg?.initData ? { 'x-telegram-init-data': tg.initData } : {}) }; }
async function request(path, options = {}) {
  const response = await fetch(API + path, { ...options, headers: { ...headers(), ...options.headers }, signal: options.signal || AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Ошибка соединения (${response.status})`), { status: response.status });
  return data;
}
let accessChecked = false;
function showModal(title) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren();
  if (!$('modal').open) $('modal').showModal();
  return $('modal-body');
}
function accessDialog() {
  const body = showModal('Доступ к коллекции');
  body.append(node('p', 'В Telegram владельца доступ подключается автоматически. Для добавления и удаления в обычном браузере введи ключ загрузчика (ingest_key из config.json).'));
  const form = node('form'), input = node('input'), submit = node('button', 'Подключить', 'accent'), note = node('p');
  input.type = 'password'; input.placeholder = 'Ключ доступа'; input.autocomplete = 'off'; input.required = true; input.setAttribute('aria-label', 'Ключ доступа');
  form.append(input, submit, note); body.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault(); submit.disabled = true;
    const previous = accessKey; accessKey = input.value.trim();
    try { await request('/api/access'); accessChecked = true; try { sessionStorage.setItem('player-access', accessKey); } catch {} $('modal').close(); toast('Доступ подключён. Можно добавлять и удалять эдиты.'); }
    catch (e) { accessKey = previous; note.textContent = e.message; }
    finally { submit.disabled = false; }
  };
  const forget = node('button', 'Отключить ключ в этом браузере', 'subtle');
  forget.onclick = () => { accessKey = ''; accessChecked = false; try { sessionStorage.removeItem('player-access'); } catch {} $('modal').close(); toast('Ключ отключён'); };
  body.append(forget);
}
async function ensureAccess() {
  if (accessChecked) return true;
  try { await request('/api/access'); accessChecked = true; return true; }
  catch (e) { if (e.status === 401) { accessDialog(); } else toast(e.message); return false; }
}
function write(path, method, data) { return request(path, { method, headers: { 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); }
$('btn-access').onclick = accessDialog;
$('modal-close').onclick = () => $('modal').close();
for (const dialog of [$('modal'), $('upload-dialog')]) dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });

let loadTask;
function applyLibrary(data) {
  if (!Array.isArray(data?.videos) || !data.playlists || typeof data.playlists !== 'object') return;
  state.videos = data.videos;
  state.playlists = data.playlists;
  renderSelects(); rebuildQueue();
}
async function loadLibrary() {
  if (loadTask) return loadTask;
  loadTask = (async () => {
    $('btn-refresh').disabled = true;
    for (let attempt = 1; attempt <= 6; attempt++) {
      $('connection').textContent = attempt === 1 ? 'Обновляем коллекцию…' : `Подключаемся · ${attempt}/6`;
      try {
        const data = await request('/api/library');
        applyLibrary(data); storage.set('player-library', data);
        $('connection').textContent = `${state.videos.length} эдитов · онлайн`;
        return;
      } catch (e) {
        if (!navigator.onLine || attempt === 6) { $('connection').textContent = 'Нет связи · нажми ↻'; toast('Не удалось обновить коллекцию. Проверь интернет и нажми ↻.'); return; }
        await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 2000, 8000)));
      }
    }
  })().finally(() => { loadTask = null; $('btn-refresh').disabled = false; });
  return loadTask;
}
function renderSelects() {
  const current = $('playlist-select').value || ALL;
  const upload = $('upload-playlist').value;
  $('playlist-select').replaceChildren(new Option(`Все эдиты (${state.videos.length})`, ALL));
  $('upload-playlist').replaceChildren(new Option('Общую коллекцию', ''));
  for (const [name, items] of Object.entries(state.playlists)) {
    $('playlist-select').add(new Option(`${name} (${items.length})`, name));
    $('upload-playlist').add(new Option(name, name));
  }
  $('playlist-select').value = Object.hasOwn(state.playlists, current) ? current : ALL;
  $('upload-playlist').value = Object.hasOwn(state.playlists, upload) ? upload : '';
  $('mobile-count').textContent = state.videos.length;
}
function rebuildQueue() {
  const selected = $('playlist-select').value, query = $('search').value.trim().toLocaleLowerCase();
  const byName = new Map(state.videos.map((v) => [v.name, v]));
  state.queue = (selected === ALL ? state.videos : (state.playlists[selected] || []).map((name) => byName.get(name)).filter(Boolean)).filter((v) => v.name.toLocaleLowerCase().includes(query));
  renderList();
}
function renderList() {
  $('count').textContent = state.queue.length;
  const fragment = document.createDocumentFragment();
  for (const video of state.queue) {
    const item = node('li', undefined, 'video-item'); item.dataset.id = video.file_id; item.dataset.name = video.name;
    item.classList.toggle('active', video.name === state.current?.name);
    item.classList.toggle('broken', state.failed.has(video.file_id));
    const play = node('button', undefined, 'item-play'); play.setAttribute('aria-label', `Смотреть ${video.name}`);
    play.append(node('span', video.name, 'vi-name'), node('span', `${state.failed.has(video.file_id) ? 'Пропущен · ' : ''}${time(video.duration)} · ${size(video.size)}`, 'vi-meta'));
    const remove = node('button', '×', 'item-delete'); remove.title = 'Удалить в один клик'; remove.setAttribute('aria-label', `Удалить ${video.name}`);
    item.append(play, remove); fragment.append(item);
  }
  if (!state.queue.length) fragment.append(node('li', state.videos.length ? 'Ничего не найдено. Попробуй другой запрос.' : 'Здесь появятся твои эдиты. Нажми «Добавить».', 'empty-note'));
  $('video-list').replaceChildren(fragment);
}
function updateActive() {
  for (const item of $('video-list').children) {
    const active = item.dataset.name === state.current?.name;
    item.classList.toggle('active', active);
    item.classList.toggle('broken', state.failed.has(item.dataset.id));
    item.querySelector('.item-play')?.setAttribute('aria-current', active ? 'true' : 'false');
  }
  $('btn-retry-broken').hidden = !state.failed.size;
}
const openSheet = () => { $('sidebar').classList.add('open'); $('sheet-backdrop').hidden = false; $('btn-library').setAttribute('aria-expanded', 'true'); };
const closeSheet = () => { $('sidebar').classList.remove('open'); $('sheet-backdrop').hidden = true; $('btn-library').setAttribute('aria-expanded', 'false'); };
$('btn-library').onclick = openSheet; $('btn-close-library').onclick = closeSheet; $('sheet-backdrop').onclick = closeSheet;
$('video-list').onclick = (event) => {
  const item = event.target.closest('.video-item'); if (!item) return;
  const video = state.queue.find((v) => v.name === item.dataset.name); if (!video) return;
  if (event.target.closest('.item-delete')) { void removeVideo(video); return; }
  state.failed.delete(video.file_id); playVideo(video); closeSheet();
};
$('btn-retry-broken').onclick = () => { state.failed.clear(); updateActive(); toast('Пропущенные эдиты снова доступны в очереди'); };
$('playlist-select').onchange = rebuildQueue;
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(rebuildQueue, 120); };
$('btn-refresh').onclick = loadLibrary;

let preloaded = '', wakeLock;
function applyMediaSettings() {
  const target = media();
  target.volume = state.volume; target.defaultPlaybackRate = state.rate; target.playbackRate = state.rate; target.loop = state.rpt1;
  for (const [id, value] of [['btn-rpt1', state.rpt1], ['btn-loop', state.loop]]) $(id).setAttribute('aria-pressed', String(value));
  $('btn-speed').textContent = `${state.rate}×`; $('speed-value').textContent = `${state.rate}×`; $('volume').value = state.volume * 100;
  for (const button of $('speed-presets').children) button.setAttribute('aria-pressed', String(Number(button.dataset.rate) === state.rate));
}
function updateSession() {
  if (!navigator.mediaSession) return;
  try {
    navigator.mediaSession.playbackState = media().paused ? 'paused' : 'playing';
    const duration = media().duration;
    if (Number.isFinite(duration) && duration > 0) navigator.mediaSession.setPositionState?.({ duration, playbackRate: state.rate, position: Math.max(0, Math.min(duration, media().currentTime)) });
  } catch {}
}
function syncPlay() {
  const playing = !media().paused;
  $('btn-play').textContent = playing ? 'Ⅱ' : '▶';
  $('btn-play').setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
  updateSession();
}
async function acquireWakeLock() {
  if (!media().paused && document.visibilityState === 'visible' && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch {} }
}
function releaseWakeLock() { void wakeLock?.release().catch(() => {}); wakeLock = null; }
function tryPlay() {
  const generation = state.generation;
  state.want = true; state.lastProgress = Date.now();
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  media().play().catch((failure) => {
    if (generation !== state.generation || failure.name === 'AbortError') return;
    if (failure.name === 'NotAllowedError') { state.want = false; state.loading = false; $('spinner').hidden = true; status('НАЖМИ ▶ ДЛЯ ВОСПРОИЗВЕДЕНИЯ'); syncPlay(); }
    else if (media().error) failVideo();
  });
}
function playVideo(video, { retry = false, position = 0, autoplay = true } = {}) {
  state.generation++; state.loading = true;
  media().pause();
  state.current = video; state.retry = retry ? state.retry + 1 : 0; state.position = position; state.lastProgress = Date.now(); state.want = autoplay;
  const target = media();
  target.src = `${API}/api/video/${encodeURIComponent(video.file_id)}`;
  applyMediaSettings(); target.load();
  $('player').classList.remove('visible'); $('placeholder').hidden = true; $('spinner').hidden = !autoplay;
  $('now-playing').textContent = video.name; $('current-time').textContent = time(position); $('duration').textContent = time(video.duration); $('seek').value = 0; $('seek').disabled = true;
  status(autoplay ? 'ЗАГРУЖАЕМ ЭДИТ' : 'ПАУЗА'); updateActive();
  if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: video.name.replace(/\.[^.]+$/, ''), artist: 'Тайник', album: $('playlist-select').value === ALL ? 'Коллекция эдитов' : $('playlist-select').value });
  if (autoplay) tryPlay();
  else state.loading = false;
  syncPlay();
}
function advance({ direction = 1, auto = false } = {}) {
  const index = state.queue.findIndex((v) => v.name === state.current?.name);
  const at = nextPlayable(state.queue, index, state.failed, { direction, wrap: !auto || state.loop });
  if (at < 0) {
    state.want = false; state.loading = false; media().pause(); $('spinner').hidden = true;
    status(state.failed.size >= state.queue.length && state.queue.length ? 'НЕТ ДОСТУПНЫХ ЭДИТОВ' : 'КОЛЛЕКЦИЯ ЗАКОНЧИЛАСЬ'); syncPlay();
    return;
  }
  playVideo(state.queue[at]);
}
let handlingFailure = false;
function failVideo(stalled = false) {
  if (!state.current || handlingFailure || !state.want) return;
  if (!navigator.onLine) { status('НЕТ СЕТИ · ЖДЁМ ПОДКЛЮЧЕНИЯ'); $('spinner').hidden = true; return; }
  handlingFailure = true;
  try {
    if ((stalled || media().error?.code === 2) && state.retry < 1) {
      const position = media().currentTime || state.position; playVideo(state.current, { retry: true, position }); status('ПОВТОРНОЕ ПОДКЛЮЧЕНИЕ'); return;
    }
    const failed = state.current; state.failed.add(failed.file_id); updateActive();
    toast(`Эдит недоступен — пропускаем: ${failed.name}`);
    advance({ auto: true });
  } finally { handlingFailure = false; }
}
function togglePlay() {
  if (!state.current) { advance(); return; }
  if (media().paused) { if (media().error) { state.failed.delete(state.current.file_id); playVideo(state.current); } else tryPlay(); }
  else { state.want = false; state.loading = false; media().pause(); $('spinner').hidden = true; status('ПАУЗА'); }
}
function preloadNext() {
  if (uploadsRunning || navigator.connection?.saveData || /2g/.test(navigator.connection?.effectiveType || '') || !state.current) return;
  const target = media(), duration = target.duration;
  if (!Number.isFinite(duration) || !target.buffered.length || target.buffered.end(target.buffered.length - 1) < duration - 1) return;
  const at = nextPlayable(state.queue, state.queue.findIndex((v) => v.name === state.current.name), state.failed, { wrap: state.loop });
  const next = state.queue[at];
  if (!next || next.file_id === state.current.file_id || preloaded === next.file_id) return;
  preloaded = next.file_id;
  $('preload-player').src = `${API}/api/video/${encodeURIComponent(next.file_id)}`;
  $('preload-player').load();
}
{
  const target = media();
  const active = (callback) => () => { if (target === media()) callback(); };
  target.addEventListener('loadedmetadata', active(() => {
    applyMediaSettings();
    if (state.position > 0 && Number.isFinite(target.duration)) target.currentTime = Math.min(state.position, Math.max(0, target.duration - .1));
    $('duration').textContent = time(target.duration); $('seek').disabled = !Number.isFinite(target.duration);
  }));
  target.addEventListener('loadeddata', active(() => { $('player').classList.add('visible'); }));
  target.addEventListener('playing', active(() => { state.loading = false; state.lastProgress = Date.now(); $('spinner').hidden = true; $('player').classList.add('visible'); status('СЕЙЧАС ИГРАЕТ'); syncPlay(); void acquireWakeLock(); }));
  target.addEventListener('play', active(syncPlay));
  target.addEventListener('pause', active(() => { syncPlay(); releaseWakeLock(); if (!state.loading && !target.ended && !target.error && state.current && !state.failed.has(state.current.file_id)) { state.want = false; status('ПАУЗА'); } }));
  target.addEventListener('waiting', active(() => { if (state.want) { $('spinner').hidden = false; status('БУФЕРИЗАЦИЯ…'); } }));
  target.addEventListener('timeupdate', active(() => {
    if (Math.abs(target.currentTime - state.position) > .05) state.lastProgress = Date.now();
    state.position = target.currentTime; $('current-time').textContent = time(target.currentTime);
    if (Number.isFinite(target.duration) && target.duration > 0) $('seek').value = target.currentTime / target.duration * 1000;
    updateSession();
  }));
  target.addEventListener('progress', active(() => { if (target.buffered.length && Number.isFinite(target.duration)) $('seek').style.setProperty('--buffered', `${target.buffered.end(target.buffered.length - 1) / target.duration * 100}%`); preloadNext(); }));
  target.addEventListener('ended', active(() => { if (!state.rpt1) advance({ auto: true }); }));
  target.addEventListener('error', active(() => { if (target.error) failVideo(); }));
}
setInterval(() => {
  if (!state.current || !state.want || !navigator.onLine || document.hidden || (media().paused && !state.loading)) return;
  if (Date.now() - state.lastProgress > 30000) failVideo(true);
}, 2000);
$('player').onclick = togglePlay;
$('btn-play').onclick = togglePlay; $('btn-start').onclick = () => advance();
$('btn-next').onclick = () => advance(); $('btn-prev').onclick = () => advance({ direction: -1 });
$('seek').oninput = () => { if (Number.isFinite(media().duration)) { media().currentTime = Number($('seek').value) / 1000 * media().duration; state.lastProgress = Date.now(); updateSession(); } };
$('volume').oninput = () => { state.volume = Number($('volume').value) / 100; applyMediaSettings(); savePrefs(); };
for (const [id, key] of [['btn-rpt1', 'rpt1'], ['btn-loop', 'loop']]) $(id).onclick = () => { state[key] = !state[key]; applyMediaSettings(); savePrefs(); };
const setRate = (value) => { state.rate = clampRate(value); applyMediaSettings(); savePrefs(); updateSession(); };
for (const rate of [.5, .75, 1, 1.25, 1.5, 1.75, 2, 2.5]) { const button = node('button', String(rate)); button.dataset.rate = rate; button.onclick = () => setRate(rate); $('speed-presets').append(button); }
$('speed-minus').onclick = () => setRate(state.rate - .1); $('speed-plus').onclick = () => setRate(state.rate + .1);
const closeSpeed = () => { $('speed-panel').hidden = true; $('btn-speed').setAttribute('aria-expanded', 'false'); };
$('btn-speed').onclick = () => { $('speed-panel').hidden = !$('speed-panel').hidden; $('btn-speed').setAttribute('aria-expanded', String(!$('speed-panel').hidden)); };
document.addEventListener('click', (event) => { if (!event.target.closest('.speed-anchor')) closeSpeed(); });
$('btn-fullscreen').onclick = async () => {
  try {
    if (tg?.isVersionAtLeast?.('8.0') && tg.requestFullscreen) { tg.isFullscreen ? tg.exitFullscreen() : tg.requestFullscreen(); }
    else if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else if ($('player').webkitEnterFullscreen) $('player').webkitEnterFullscreen();
    else toast('Полный экран недоступен в этом браузере');
  } catch { toast('Полный экран недоступен'); }
};
if (navigator.mediaSession) {
  const seekBy = (amount) => { const target = media(); if (Number.isFinite(target.duration)) target.currentTime = Math.max(0, Math.min(target.duration, target.currentTime + amount)); };
  for (const [action, handler] of Object.entries({ play: tryPlay, pause: () => { state.want = false; state.loading = false; media().pause(); }, nexttrack: () => advance(), previoustrack: () => advance({ direction: -1 }), seekbackward: (event) => seekBy(-(event.seekOffset || 10)), seekforward: (event) => seekBy(event.seekOffset || 10), seekto: (event) => { if (Number.isFinite(event.seekTime) && Number.isFinite(media().duration)) media().currentTime = Math.max(0, Math.min(media().duration, event.seekTime)); } })) { try { navigator.mediaSession.setActionHandler(action, handler); } catch {} }
}
document.addEventListener('visibilitychange', () => { state.lastProgress = Date.now(); if (!document.hidden) void acquireWakeLock(); else releaseWakeLock(); });
window.addEventListener('offline', () => { $('connection').textContent = 'Нет интернета'; status('НЕТ СЕТИ · ЖДЁМ ПОДКЛЮЧЕНИЯ'); });
window.addEventListener('online', () => { void loadLibrary(); if (state.current && state.want) playVideo(state.current, { position: state.position }); });

const deleting = new Set();
async function removeVideo(video) {
  if (deleting.has(video.name) || !await ensureAccess()) return;
  deleting.add(video.name);
  try {
    await write(`/api/videos/${encodeURIComponent(video.name)}`, 'DELETE');
    const wasCurrent = state.current?.name === video.name;
    if (wasCurrent) {
      const at = nextPlayable(state.queue, state.queue.findIndex((v) => v.name === video.name), new Set([...state.failed, video.file_id]));
      if (at >= 0) playVideo(state.queue[at]);
      else { state.want = false; state.loading = false; media().pause(); state.current = null; $('placeholder').hidden = false; $('spinner').hidden = true; $('now-playing').textContent = 'Выбери эдит'; media().removeAttribute('src'); media().load(); syncPlay(); }
    }
    state.videos = state.videos.filter((v) => v.name !== video.name);
    for (const key of Object.keys(state.playlists)) state.playlists[key] = state.playlists[key].filter((name) => name !== video.name);
    storage.set('player-library', { videos: state.videos, playlists: state.playlists }); renderSelects(); rebuildQueue();
    toast('Эдит удалён из коллекции', async () => { await write(`/api/videos/${encodeURIComponent(video.name)}/restore`, 'POST'); await loadLibrary(); toast('Эдит восстановлен'); });
  } catch (e) { toast(e.message); if (e.status === 401) { accessChecked = false; accessDialog(); } }
  finally { deleting.delete(video.name); }
}
$('btn-delete-current').onclick = () => state.current ? removeVideo(state.current) : toast('Сначала выбери эдит');
async function createPlaylist() {
  if (!await ensureAccess()) return;
  const body = showModal('Новый плейлист'), form = node('form'), input = node('input'), save = node('button', 'Создать', 'accent');
  input.placeholder = 'Название плейлиста'; input.maxLength = 100; input.required = true; input.setAttribute('aria-label', 'Название плейлиста');
  form.append(input, save); body.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault(); const name = input.value.trim();
    if (!name || ['__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(state.playlists, name)) { toast('Выбери другое название'); return; }
    save.disabled = true;
    try { const saved = await write(`/api/playlists/${encodeURIComponent(name)}`, 'POST'); state.playlists = saved.playlists; renderSelects(); $('playlist-select').value = name; rebuildQueue(); $('modal').close(); toast('Плейлист создан'); }
    catch (e) { toast(e.message); } finally { save.disabled = false; }
  };
  input.focus();
}
$('btn-new-playlist').onclick = createPlaylist;
$('btn-add').onclick = async () => {
  if (!state.current) { toast('Сначала выбери эдит'); return; }
  if (!await ensureAccess()) return;
  const video = state.current, body = showModal('Добавить в плейлист');
  for (const [name, list] of Object.entries(state.playlists)) {
    const has = list.includes(video.name), button = node('button', `${has ? '✓ ' : '＋ '}${name}`);
    button.onclick = async () => {
      button.disabled = true;
      try { const saved = await write(`/api/playlists/${encodeURIComponent(name)}/items`, 'POST', { name: video.name, present: !has }); state.playlists = saved.playlists; renderSelects(); rebuildQueue(); $('modal').close(); toast(has ? 'Убрано из плейлиста' : 'Добавлено в плейлист'); }
      catch (e) { toast(e.message); button.disabled = false; }
    };
    body.append(button);
  }
  const create = node('button', '＋ Создать плейлист', 'accent'); create.onclick = createPlaylist; body.append(create);
};

const uploads = [];
let uploadsRunning = false;
const uploadLabels = { queued: 'В очереди', uploading: 'Отправляем', processing: 'Подготавливаем MP4', sending: 'Сохраняем видео', saving: 'Добавляем в коллекцию', done: 'Готово', cancelled: 'Отменено', error: 'Не загрузилось' };
function renderUploads() {
  const fragment = document.createDocumentFragment();
  for (const entry of uploads) {
    const item = node('li', undefined, `upload-item ${entry.status}`), copy = node('div');
    copy.append(node('strong', entry.name), node('small', entry.message || `${uploadLabels[entry.status]}${['uploading', 'processing'].includes(entry.status) ? ` · ${entry.progress || 0}%` : ''}`));
    item.append(copy);
    const progress = node('progress'); progress.max = 100; progress.value = entry.status === 'done' ? 100 : entry.progress || 0; item.append(progress);
    if (entry.status === 'error' || entry.status === 'cancelled') {
      if (entry.file && !entry.invalid) { const retry = node('button', 'Повторить'); retry.onclick = () => { entry.status = 'queued'; entry.message = ''; entry.jobId = null; entry.cancelled = false; renderUploads(); void runUploads(); }; item.append(retry); }
    } else if (entry.status !== 'done' && entry.status !== 'saving') {
      const cancel = node('button', 'Отмена'); cancel.onclick = () => { entry.cancelled = true; entry.xhr?.abort(); if (entry.jobId) void write(`/api/uploads/${entry.jobId}`, 'DELETE').catch((e) => toast(e.message)); if (entry.status === 'queued') entry.status = 'cancelled'; renderUploads(); }; item.append(cancel);
    }
    fragment.append(item);
  }
  $('upload-list').replaceChildren(fragment);
}
function sendFile(entry) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); entry.xhr = xhr;
    xhr.open('POST', `${API}/api/uploads?name=${encodeURIComponent(entry.name)}&playlist=${encodeURIComponent(entry.playlist)}`);
    xhr.timeout = 30 * 60 * 1000;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    for (const [key, value] of Object.entries(headers())) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) { entry.progress = Math.round(event.loaded / event.total * 100); renderUploads(); } };
    xhr.onload = () => { let result; try { result = JSON.parse(xhr.responseText); } catch { result = {}; } if (xhr.status >= 200 && xhr.status < 300) resolve(result); else reject(new Error(result.error || `Ошибка загрузки (${xhr.status})`)); };
    xhr.onerror = () => reject(new Error('Соединение прервано. Повтори загрузку.'));
    xhr.ontimeout = () => reject(new Error('Время загрузки истекло. Повтори при стабильном интернете.'));
    xhr.onabort = () => reject(new Error('Загрузка отменена'));
    xhr.send(entry.file);
  });
}
async function pollJob(entry) {
  let failures = 0;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const job = await request(`/api/uploads/${entry.jobId}`); failures = 0;
      Object.assign(entry, { status: job.status, progress: job.progress, message: job.message || '' }); renderUploads();
      if (job.status === 'done') { entry.file = null; await loadLibrary(); return; }
      if (['error', 'cancelled'].includes(job.status)) return;
    } catch (e) { if (e.status === 404 || ++failures >= 5) throw e; entry.message = 'Связь прервалась; проверяем результат…'; renderUploads(); }
  }
}
async function runUploads() {
  if (uploadsRunning) return;
  uploadsRunning = true;
  $('preload-player').removeAttribute('src'); $('preload-player').load(); preloaded = '';
  try {
    for (const entry of uploads) {
      if (entry.status !== 'queued') continue;
      entry.status = 'uploading'; entry.progress = 0; renderUploads();
      try {
        const job = await sendFile(entry); entry.xhr = null; entry.jobId = job.id; entry.status = job.status; entry.progress = 0;
        try { sessionStorage.setItem('player-upload-job', JSON.stringify({ jobId: job.id, name: entry.name })); } catch {}
        await pollJob(entry);
        try { sessionStorage.removeItem('player-upload-job'); } catch {}
      } catch (e) { entry.status = entry.cancelled ? 'cancelled' : 'error'; entry.message = e.message; }
      renderUploads();
    }
  } finally { uploadsRunning = false; }
}
async function addFiles(files) {
  if (!files.length || !await ensureAccess()) return;
  for (const file of files) {
    if (uploads.some((entry) => entry.name === file.name && !['done', 'error', 'cancelled'].includes(entry.status))) continue;
    const message = !file.size ? 'Файл пуст' : file.size > 512 * 1048576 ? 'Файл больше 512 МБ' : !file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name) ? 'Выбери видеофайл' : '';
    let name = file.name, copy = 2;
    const extension = /\.[^.]+$/.exec(file.name)?.[0] || '';
    const stem = file.name.slice(0, file.name.length - extension.length);
    const used = new Set([...state.videos.map((video) => video.name), ...uploads.filter((entry) => !['error', 'cancelled'].includes(entry.status)).map((entry) => entry.name)]);
    while (used.has(name)) name = `${stem} (${copy++})${extension}`;
    uploads.push({ name, file, status: message ? 'error' : 'queued', invalid: !!message, message, progress: 0, playlist: $('upload-playlist').value });
  }
  renderUploads(); void runUploads();
}
async function openUpload() { if (!await ensureAccess()) return; closeSheet(); $('upload-dialog').showModal(); }
$('btn-upload').onclick = openUpload; $('btn-upload-mobile').onclick = openUpload;
$('upload-close').onclick = () => $('upload-dialog').close();
$('file-input').onchange = () => { void addFiles([...$('file-input').files]); $('file-input').value = ''; };
for (const type of ['dragenter', 'dragover']) $('drop-zone').addEventListener(type, (e) => { e.preventDefault(); $('drop-zone').classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) $('drop-zone').addEventListener(type, (e) => { e.preventDefault(); $('drop-zone').classList.remove('dragging'); if (type === 'drop') void addFiles([...e.dataTransfer.files]); });
window.addEventListener('beforeunload', (event) => { if (uploadsRunning) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeSheet(); closeSpeed(); return; }
  if (event.target.closest('input, select, textarea, button, dialog')) return;
  const actions = { ' ': togglePlay, ArrowRight: () => advance(), ArrowLeft: () => advance({ direction: -1 }) };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
});
if (tg) {
  tg.ready?.(); tg.expand?.();
  try { tg.setHeaderColor?.('#000000'); tg.setBackgroundColor?.('#000000'); if (tg.isVersionAtLeast?.('7.10')) tg.setBottomBarColor?.('#000000'); if (tg.isVersionAtLeast?.('7.7')) tg.disableVerticalSwipes?.(); } catch {}
  const insets = () => document.documentElement.style.setProperty('--tg-top', `${(tg.safeAreaInset?.top || 0) + (tg.contentSafeAreaInset?.top || 0)}px`);
  insets(); tg.onEvent?.('safeAreaChanged', insets); tg.onEvent?.('contentSafeAreaChanged', insets);
}
applyMediaSettings(); applyLibrary(storage.get('player-library', null)); void loadLibrary();
try {
  const pending = JSON.parse(sessionStorage.getItem('player-upload-job') || 'null');
  if (pending?.jobId && (accessKey || tg?.initData)) { const entry = { ...pending, status: 'processing', progress: 0 }; uploads.push(entry); void pollJob(entry).then(() => sessionStorage.removeItem('player-upload-job')).catch((e) => { entry.status = 'error'; entry.message = e.message; renderUploads(); }); }
} catch {}
