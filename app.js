/**
 * TikTok Player — Mini App
 *
 * Логика перенесена из десктопного video_player.py:
 *   single_loop   → RPT1  (одно видео по кругу)
 *   loop_callback → LOOP  (по кругу весь список)
 *   клик по видео → пауза / воспроизведение
 */

const API = 'https://tiktok-tg-player-api.onrender.com';
const ALL = '__all__';

const tg = window.Telegram?.WebApp;

// ── Состояние ────────────────────────────────────────────────
const state = {
  videos: [],       // вся библиотека
  playlists: {},    // { имя: [имя_файла, ...] }
  queue: [],        // то, что реально играем (с учётом плейлиста и поиска)
  index: -1,        // позиция в queue
  rpt1: false,
  loop: false,
  volume: 0.7,
};

// ── DOM ──────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  list: $('video-list'), count: $('count'), search: $('search'),
  select: $('playlist-select'), refresh: $('btn-refresh'), newPl: $('btn-new-playlist'),
  player: $('player'), placeholder: $('placeholder'), spinner: $('spinner'),
  play: $('btn-play'), prev: $('btn-prev'), next: $('btn-next'),
  rpt1: $('btn-rpt1'), loop: $('btn-loop'),
  volume: $('volume'), volVal: $('vol-val'),
  now: $('now-playing'), add: $('btn-add'), fullscreen: $('btn-fullscreen'),
  modal: $('modal'), modalTitle: $('modal-title'), modalBody: $('modal-body'), modalCancel: $('modal-cancel'),
  toast: $('toast'),
  sidebar: $('sidebar'), libBtn: $('btn-library'), backdrop: $('sheet-backdrop'),
};

// ── Шторка библиотеки (мобильная) ────────────────────────────
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

function openSheet() {
  el.sidebar.classList.add('open');
  el.backdrop.hidden = false;
}

function closeSheet() {
  el.sidebar.classList.remove('open');
  el.backdrop.hidden = true;
}

// ── Утилиты ──────────────────────────────────────────────────
const fmtSize = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

/** Дата из имени: tiktok_20260715_053426.mp4 → 2026-07-15 */
function fmtDate(name) {
  const m = name.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function haptic(type = 'light') {
  tg?.HapticFeedback?.impactOccurred?.(type);
}

// ── Загрузка библиотеки ──────────────────────────────────────
async function loadLibrary() {
  try {
    const res = await fetch(`${API}/api/library`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.videos = Array.isArray(data.videos) ? data.videos : [];
    state.playlists = data.playlists && typeof data.playlists === 'object' ? data.playlists : {};

    renderPlaylistSelect();
    rebuildQueue();
    toast(`Загружено: ${state.videos.length} видео`);
  } catch (e) {
    toast(`Ошибка загрузки: ${e.message}`);
  }
}

// ── Плейлисты ────────────────────────────────────────────────
function renderPlaylistSelect() {
  const current = el.select.value || ALL;
  el.select.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = ALL;
  optAll.textContent = `All Videos (${state.videos.length})`;
  el.select.append(optAll);

  for (const [name, items] of Object.entries(state.playlists)) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = `${name} (${items.length})`;
    el.select.append(o);
  }

  // не сбрасываем выбор пользователя при перерисовке
  el.select.value = [...el.select.options].some((o) => o.value === current) ? current : ALL;
}

async function savePlaylists() {
  try {
    const res = await fetch(`${API}/api/playlists`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.playlists),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    toast(`Не сохранилось: ${e.message}`);
    return false;
  }
}

// ── Очередь и список ─────────────────────────────────────────
function rebuildQueue() {
  const sel = el.select.value || ALL;
  const q = el.search.value.trim().toLowerCase();

  let items;
  if (sel === ALL) {
    items = [...state.videos];
  } else {
    // порядок берём из плейлиста, а не из библиотеки
    const byName = new Map(state.videos.map((v) => [v.name, v]));
    items = (state.playlists[sel] || []).map((n) => byName.get(n)).filter(Boolean);
  }

  if (q) items = items.filter((v) => v.name.toLowerCase().includes(q));

  // сохраняем текущее видео при смене фильтра
  const playingName = state.index >= 0 ? state.queue[state.index]?.name : null;
  state.queue = items;
  state.index = playingName ? items.findIndex((v) => v.name === playingName) : -1;

  renderList();
}

function renderList() {
  el.count.textContent = `(${state.queue.length})`;
  el.list.innerHTML = '';

  if (!state.queue.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = state.videos.length ? 'Ничего не найдено' : 'Библиотека пуста';
    el.list.append(li);
    return;
  }

  const frag = document.createDocumentFragment();

  state.queue.forEach((v, i) => {
    const li = document.createElement('li');
    li.className = 'video-item' + (i === state.index ? ' active' : '');
    li.tabIndex = 0;
    li.dataset.index = String(i);

    const dot = document.createElement('span');
    dot.className = 'vi-dot';

    const name = document.createElement('div');
    name.className = 'vi-name';
    name.textContent = v.name;

    const meta = document.createElement('div');
    meta.className = 'vi-meta';
    meta.textContent = `${fmtSize(v.size)}  ${fmtDate(v.name)}`;

    li.append(dot, name, meta);
    frag.append(li);
  });

  el.list.append(frag);
}

// ── Воспроизведение ──────────────────────────────────────────
function playIndex(i) {
  if (i < 0 || i >= state.queue.length) return;

  const v = state.queue[i];
  state.index = i;

  el.spinner.hidden = false;
  el.placeholder.style.display = 'none';
  el.player.classList.add('visible');

  el.player.src = `${API}/api/video/${encodeURIComponent(v.file_id)}`;
  el.player.loop = state.rpt1;          // RPT1 — нативный повтор, без дёрганья
  el.player.volume = state.volume;
  el.player.play().catch(() => { /* автоплей может быть зарезан — не падаем */ });

  el.now.textContent = v.name;
  el.now.classList.add('playing');
  renderList();

  // подкрутить активный элемент в видимую область
  el.list.querySelector('.video-item.active')?.scrollIntoView({ block: 'nearest' });
}

function next(auto = false) {
  if (!state.queue.length) return;

  const last = state.index >= state.queue.length - 1;
  if (last && auto && !state.loop) return;   // конец списка без LOOP — стоп

  playIndex(last ? 0 : state.index + 1);
}

function prev() {
  if (!state.queue.length) return;
  playIndex(state.index <= 0 ? state.queue.length - 1 : state.index - 1);
}

function togglePlay() {
  if (state.index < 0) {
    if (state.queue.length) playIndex(0);
    return;
  }
  if (el.player.paused) el.player.play().catch(() => {});
  else el.player.pause();
}

function syncPlayButton() {
  const playing = state.index >= 0 && !el.player.paused;
  el.play.textContent = playing ? '||' : '>';
}

// ── Модалка «добавить в плейлист» ────────────────────────────
function openPlaylistModal() {
  if (state.index < 0) { toast('Сначала выбери видео'); return; }

  const video = state.queue[state.index];
  el.modalTitle.textContent = `В плейлист: ${video.name}`;
  el.modalBody.innerHTML = '';

  const names = Object.keys(state.playlists);
  if (!names.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = 'Плейлистов пока нет — создай через «+ New»';
    el.modalBody.append(note);
  }

  for (const name of names) {
    const has = state.playlists[name].includes(video.name);
    const b = document.createElement('button');
    b.className = 'pl-option';
    b.textContent = `${has ? '✓ ' : ''}${name} (${state.playlists[name].length})`;
    b.addEventListener('click', async () => {
      const list = state.playlists[name];
      const at = list.indexOf(video.name);
      if (at >= 0) list.splice(at, 1); else list.unshift(video.name);

      if (await savePlaylists()) {
        toast(at >= 0 ? `Убрано из «${name}»` : `Добавлено в «${name}»`);
        renderPlaylistSelect();
        if (el.select.value === name) rebuildQueue();
      }
      closeModal();
    });
    el.modalBody.append(b);
  }

  el.modal.hidden = false;
}

const closeModal = () => { el.modal.hidden = true; };

async function createPlaylist() {
  const name = prompt('Как наречь новый свиток?')?.trim();
  if (!name) return;
  if (state.playlists[name]) { toast('Такой уже есть'); return; }

  state.playlists[name] = [];
  if (await savePlaylists()) {
    renderPlaylistSelect();
    el.select.value = name;
    rebuildQueue();
    toast(`Плейлист «${name}» создан`);
  }
}

// ── События ──────────────────────────────────────────────────
el.list.addEventListener('click', (e) => {
  const item = e.target.closest('.video-item');
  if (item) {
    haptic();
    playIndex(Number(item.dataset.index));
    if (isMobile()) closeSheet();   // выбрал — шторка уходит, видно видео
  }
});

el.libBtn.addEventListener('click', () => { haptic(); openSheet(); });
el.backdrop.addEventListener('click', closeSheet);

el.list.addEventListener('keydown', (e) => {
  const item = e.target.closest('.video-item');
  if (item && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    playIndex(Number(item.dataset.index));
  }
});

// клик по видео = пауза (как в десктопной версии)
el.player.addEventListener('click', () => { haptic(); togglePlay(); });

el.player.addEventListener('ended', () => { if (!state.rpt1) next(true); });
el.player.addEventListener('playing', () => { el.spinner.hidden = true; syncPlayButton(); });
el.player.addEventListener('pause', syncPlayButton);
el.player.addEventListener('play', syncPlayButton);
el.player.addEventListener('waiting', () => { el.spinner.hidden = false; });
el.player.addEventListener('error', () => {
  el.spinner.hidden = true;
  toast(`Не удалось воспроизвести: ${state.queue[state.index]?.name ?? ''}`);
});

el.play.addEventListener('click', () => { haptic(); togglePlay(); });
el.next.addEventListener('click', () => { haptic(); next(); });
el.prev.addEventListener('click', () => { haptic(); prev(); });

el.rpt1.addEventListener('click', () => {
  state.rpt1 = !state.rpt1;
  el.rpt1.classList.toggle('on', state.rpt1);
  el.player.loop = state.rpt1;
  haptic();
});

el.loop.addEventListener('click', () => {
  state.loop = !state.loop;
  el.loop.classList.toggle('on', state.loop);
  haptic();
});

el.volume.addEventListener('input', () => {
  state.volume = Number(el.volume.value) / 100;
  el.player.volume = state.volume;
  el.volVal.textContent = `${el.volume.value}%`;
});

el.select.addEventListener('change', rebuildQueue);
el.refresh.addEventListener('click', () => { haptic(); loadLibrary(); });
el.newPl.addEventListener('click', createPlaylist);
el.add.addEventListener('click', openPlaylistModal);

let tgFullscreen = false;

el.fullscreen.addEventListener('click', () => {
  // Внутри Telegram — родной метод клиента: браузерный Fullscreen API
  // в его вебвью часто заблокирован политикой хоста и молча не срабатывает.
  if (tg?.requestFullscreen) {
    if (tgFullscreen) tg.exitFullscreen();
    else tg.requestFullscreen();
    return;
  }
  // Открыто как обычная веб-страница — обычный браузерный API
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast('Полноэкранный режим недоступен'));
});

tg?.onEvent?.('fullscreenChanged', () => {
  tgFullscreen = !!tg.isFullscreen;
  el.fullscreen.textContent = tgFullscreen ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
});

tg?.onEvent?.('fullscreenFailed', () => toast('Полноэкранный режим недоступен в этой версии Telegram'));

document.addEventListener('fullscreenchange', () => {
  if (tg?.requestFullscreen) return;   // управляется событиями tg выше
  el.fullscreen.textContent = document.fullscreenElement ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
});
el.modalCancel.addEventListener('click', closeModal);
el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(rebuildQueue, 180);
});

// Горячие клавиши — только когда фокус не в поле ввода
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;

  const actions = {
    ' ': togglePlay,
    ArrowRight: () => next(),
    ArrowLeft: prev,
    Escape: () => { closeModal(); closeSheet(); },
  };
  const fn = actions[e.key];
  if (fn) { e.preventDefault(); fn(); }
});

// ── Старт ────────────────────────────────────────────────────
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('#0f1115');
  tg.setBackgroundColor?.('#0f1115');
  tg.disableVerticalSwipes?.();   // свайп вниз не должен закрывать приложение во время просмотра
}

el.player.volume = state.volume;
loadLibrary();
