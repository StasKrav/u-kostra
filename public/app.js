// ============================================================
// СОСТОЯНИЕ
// ============================================================
const state = {
  me: null,
  glades: [],
  currentGlade: null,
  messages: [],
  sitting: false,
  presence: [],
  activity: 0,
  targetActivity: 0,
  activities: {},
  presenceByGlade: {},
  ws: null,
  wsReady: false,
  soundOn: false,       
  fireAudio: null,
  currentTopic: null,
  topicsByGlade: {},      
  sidebarView: 'glades',
  commonTopicId: null,
  hasMoreHistory: true,
  loadingHistory: false,
  loadMoreRaf: null,
};
// ============================================================
// WS
// ============================================================
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => { state.wsReady = true; enterGlade(state.currentGlade.slug); };
  ws.onclose = () => { state.wsReady = false; setTimeout(connectWS, 2000); };
  ws.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleServerEvent(msg);
  };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function handleServerEvent(msg) {
  switch (msg.type) {
    case 'ready':
      state.me = { ...state.me, userId: msg.userId, displayName: msg.displayName };
      break;

    case 'history':
      if (msg.topicId !== state.currentTopic?.id) return;
      state.currentTopic = msg.topic;
      state.messages = msg.messages;
      state.targetActivity = msg.activity;
      renderMessages({ scrollToBottom: true });
      updateGladeHeader();
      break;

    case 'reply':
      if (msg.topicId !== state.currentTopic?.id) return;
      if (state.messages.some(m => m.id === msg.message.id)) return;
      state.messages.push(msg.message);
      appendReply(msg.message);
      break;
      
    case 'speaking':
      if (msg.topicId !== state.currentTopic?.id) return;
      if (msg.userId === state.me.userId) return;
      spawnSpeaker(msg.name || 'Аноним');
      break;

    case 'presence':
      if (msg.topicId !== state.currentTopic?.id) return;
      state.presence = msg.users;
      updateOnline();
      updateGladeCounts();
      break;

    case 'activity':
      if (msg.topicId !== state.currentTopic?.id) return;
      state.targetActivity = msg.activity;
      updateFireIntensity(msg.activity);
      updateGladeSparks();
      break;

    case 'activity-all':
      state.activities = msg.activities;
      updateGladeSparks();
      break;

    case 'rate-limit':
      showHint('Подожди немного. Сказать можно раз в 5 секунд.');
      break;

    case 'name-set':
      state.me.displayName = msg.name;
      break;
  }
}

function appendReply(m) {
  const el = document.getElementById('replies');

  // Считаем ДО вставки — пока layout старый
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;

  if (el.children.length >= 500) {
    el.removeChild(el.firstChild);
  }

  el.appendChild(renderReply(m));

  if (wasAtBottom) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================
async function init() {
  // Ждём загрузки шрифтов, чтобы layout был стабильным
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  const me = await fetch('/api/me').then(r => r.json());
  state.me = me;

  const glades = await fetch('/api/glades').then(r => r.json());
  state.glades = glades;
  state.currentGlade = glades[0];

  // Стартовая модалка — показать, если ещё не видел
  if (!localStorage.getItem('koster_intro_seen')) {
    document.getElementById('intro-modal').classList.remove('hidden');
    document.getElementById('fire-video').pause();
  }

  renderSidebar();
  // initFire();
  connectWS();
  bindUI();
  // requestAnimationFrame(tickFire);
}

// ============================================================
// ПОЛЯНЫ
// ============================================================
// ============================================================
// САЙДБАР
// ============================================================
function renderSidebar() {
  const gladesEl = document.getElementById('glades');
  const topicsEl = document.getElementById('topics-bar');

  gladesEl.innerHTML = '';
  topicsEl.innerHTML = '';

  // Якорь «Общий костёр» — всегда
  renderAnchor(gladesEl);

  // Содержимое — в зависимости от состояния
  if (state.sidebarView === 'glades') {
    renderGladeSection(gladesEl);
  } else {
    renderTopicsSection(gladesEl, topicsEl);
  }

  updateGladeSparks();
}

function renderAnchor(el) {
  const anchor = document.createElement('div');
  anchor.className = 'sidebar-anchor' + (state.currentGlade?.slug === 'common' ? ' active' : '');
  anchor.innerHTML = `
    <svg class="icon icon-fire" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
    </svg>
    <span>Большой Костёр</span>
  `;
  anchor.onclick = () => enterGlade('common');
  el.appendChild(anchor);
}

function renderGladeSection(el) {
  // Заголовок «Поляны»
  const title = document.createElement('div');
  title.className = 'sidebar-section-title';
  title.textContent = 'Поляны';
  el.appendChild(title);

  // Список полян
  state.glades.forEach(g => {
    if (g.slug === 'common') return;
    const item = document.createElement('div');
    item.className = 'glade-item' + (g.slug === state.currentGlade?.slug ? ' active' : '');
    item.dataset.slug = g.slug;
    item.innerHTML = `
      <span class="spark"></span>
      <span class="glade-name">${escapeHtml(g.title)}</span>
      <span class="glade-count" data-count></span>
    `;
    item.onclick = () => enterGlade(g.slug);
    el.appendChild(item);
  });
}

function renderTopicsSection(gladesEl, topicsEl) {
  const glade = state.currentGlade;
  if (!glade) return;

  // Заголовок — название поляны
  const title = document.createElement('div');
  title.className = 'sidebar-section-title';
  title.textContent = glade.title;
  gladesEl.appendChild(title);

  // Строка с кнопками — во второй колонке
  const bar = document.createElement('div');
  bar.className = 'topics-bar-inner';

  // Стрелка назад — всегда
  const back = document.createElement('button');
  back.className = 'sidebar-back';
  back.title = 'К полянам';
  back.innerHTML = `
    <svg class="icon icon-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  `;
  back.onclick = () => {
    state.sidebarView = 'glades';
    renderSidebar();
  };
  bar.appendChild(back);

  // Плюс — всегда
  const spacer = document.createElement('div');
  spacer.className = 'topics-bar-spacer';
  bar.appendChild(spacer);

  const newBtn = document.createElement('button');
  newBtn.className = 'topic-new';
  newBtn.title = 'Новая тема';
  newBtn.innerHTML = `
    <svg class="icon icon-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  `;
  newBtn.onclick = () => openTopicModal();
  bar.appendChild(newBtn);

  topicsEl.appendChild(bar);

  // Список тем
  const topics = state.topicsByGlade[glade.slug] || [];
  for (const t of topics) {
    const item = document.createElement('div');
    item.className = 'topic-item' + (t.id === state.currentTopic?.id ? ' active' : '');
    item.innerHTML = `
      <div class="topic-title">${escapeHtml(t.title || '(без названия)')}</div>
      <div class="topic-meta">${t.message_count || 0} ${pluralizeReplies(t.message_count || 0)}</div>
    `;
    item.onclick = () => enterTopic(t);
    topicsEl.appendChild(item);
  }
}

// Утилиты для склонений и времени
function pluralizeReplies(n) {
  if (n === 0) return 'реплик';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'реплика';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'реплики';
  return 'реплик';
}

function relativeTime(ts) {
  if (!ts) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} дн назад`;
  return new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

async function enterGlade(slug) {
  const g = state.glades.find(x => x.slug === slug);
  if (!g) return;

  // Выйти из старой темы
  if (state.currentTopic) {
    wsSend({ type: 'leave-topic', topicId: state.currentTopic.id });
  }

  state.currentGlade = g;
  state.currentTopic = null;
  state.messages = [];
  state.presence = [];
  state.sitting = true;

  updateGladeHeader();
  updateGladeCounts();
  renderMessages();
  updateOnline();
  applyMood(g.mood);

  // Загрузить темы поляны
  try {
    const res = await fetch(`/api/glades/${slug}/topics`);
    if (!res.ok) throw new Error('failed to load topics');
    const data = await res.json();
    state.topicsByGlade[slug] = data.topics;

    // Служебная тема общего костра — запомнить id
    if (slug === 'common') {
      const topic = data.topics[0];
      if (topic) {
        state.commonTopicId = topic.id;
        state.sidebarView = 'glades';
        enterTopic(topic);
      }
    } else {
      state.sidebarView = 'topics';
      if (data.topics.length >= 1) {
        enterTopic(data.topics[0]);
      }
    }
  } catch (e) {
    console.error('Не удалось загрузить темы:', e);
  }

  renderSidebar();
}

function enterTopic(topic) {
  if (state.currentTopic?.id === topic.id) {
    renderSidebar();
    return;
  }

  state.currentTopic = topic;
  state.messages = [];
  state.presence = [];

  updateGladeHeader();
  renderMessages();
  updateOnline();
  renderSidebar();

  wsSend({ type: 'enter-topic', topicId: topic.id });

  state.hasMoreHistory = true;
  state.loadingHistory = false;
}

function updateGladeHeader() {
  const titleEl = document.getElementById('glade-title');
  const descEl  = document.getElementById('glade-desc');

  if (state.currentGlade?.slug === 'common') {
    // Общий костёр — всегда название поляны, без темы
    titleEl.textContent = state.currentGlade.title;
    descEl.textContent = state.currentGlade.description || '';
    return;
  }

  if (state.currentTopic) {
    titleEl.textContent = state.currentTopic.title || '(без названия)';
    descEl.textContent = state.currentTopic.description
      || state.currentGlade?.description
      || '';
  } else if (state.currentGlade) {
    titleEl.textContent = state.currentGlade.title;
    descEl.textContent = state.currentGlade.description || '';
  }
}

function updateGladeSparks() {
  document.querySelectorAll('.glade-item').forEach(el => {
    const slug = el.dataset.slug;
    const isActive = slug === state.currentGlade.slug;
    el.classList.toggle('active', isActive);

    const spark = el.querySelector('.spark');
    if (!spark) return;

    const activity = state.activities[slug] || 0;

    // Базовая яркость от активности (0..1)
    let intensity = Math.min(activity / 20, 1);

    // Активная поляна всегда яркая — она в фокусе
    if (isActive) intensity = Math.max(intensity, 0.85);

    const alpha = 0.15 + intensity * 0.85;
    const size = 6 + intensity * 6;

    spark.style.setProperty('--spark-alpha', alpha.toFixed(3));
    spark.style.setProperty('--spark-size', size.toFixed(1) + 'px');
  });
}

function updateGladeCounts() {
  const items = document.querySelectorAll('.glade-item');
  items.forEach(el => {
    const countEl = el.querySelector('[data-count]');
    if (!countEl) return;

    if (el.dataset.slug === state.currentGlade.slug) {
      const others = state.presence.filter(p => p.userId !== state.me.userId);
      countEl.textContent = others.length > 0 ? others.length : '';
    } else {
      countEl.textContent = '';
    }
  });
}

// ============================================================
// ЛЮДИ
// ============================================================
// ============================================================
// ГОВОРЯЩИЕ (эфемерные)
// ============================================================
const activeSpeakers = [];

function spawnSpeaker(name) {
  const peopleEl = document.getElementById('people');
  if (!peopleEl) return;

  const w = peopleEl.clientWidth || 520;
  const h = peopleEl.clientHeight || 280;
  const cx = w / 2, cy = h / 2;

  let pos = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const rFactor = 0.45 + Math.random() * 0.5;
    const x = cx + Math.cos(angle) * w * 0.42 * rFactor;
    const y = cy + Math.sin(angle) * h * 0.34 * rFactor;

    const minDist = 56;
    const ok = activeSpeakers.every(s => {
      const dx = s.x - x, dy = s.y - y;
      return Math.sqrt(dx * dx + dy * dy) > minDist;
    });

    if (ok) { pos = { x, y, rFactor }; break; }
  }

  if (!pos) {
    const angle = Math.random() * Math.PI * 2;
    pos = {
      x: cx + Math.cos(angle) * w * 0.42,
      y: cy + Math.sin(angle) * h * 0.34,
      rFactor: 0.7,
    };
  }

  const depth = pos.rFactor;
  const size = 56 - (depth - 0.45) * 30;
  const zIndex = Math.round(100 - depth * 60);

  const el = document.createElement('div');
  el.className = 'person ephemeral';
  el.style.left = pos.x + 'px';
  el.style.top = pos.y + 'px';
  el.style.width = size + 'px';
  el.style.height = size + 'px';
  el.style.fontSize = (size * 0.32) + 'px';
  el.style.zIndex = zIndex;
  el.innerHTML = `<span class="name">${escapeHtml(name)}</span>${escapeHtml((name || '?')[0].toUpperCase())}`;

  peopleEl.appendChild(el);

  const speaker = { x: pos.x, y: pos.y, el };
  activeSpeakers.push(speaker);

  setTimeout(() => {
    const i = activeSpeakers.indexOf(speaker);
    if (i >= 0) activeSpeakers.splice(i, 1);
    if (el.parentNode) el.remove();
  }, 3600);
}

function updateOnline() {
  const others = state.presence.filter(p => p.userId !== state.me.userId);
  const n = others.length;

  document.getElementById('online-count').textContent =
    n === 0 ? 'никого' :
    n === 1 ? '1 рядом' :
    `${n} рядом`;
}

// ============================================================
// НАСТРОЕНИЕ ПОЛЯНЫ
// ============================================================
function applyMood(mood) {
  const scene = document.getElementById('scene');
  if (scene) scene.dataset.mood = mood || 'warm';
}

// ============================================================
// ИНТЕНСИВНОСТЬ ОГНЯ (от активности)
// ============================================================
let displayedIntensity = 0.5;
// ============================================================
// ОГОНЬ — реакция на активность + настроение поляны
// ============================================================
const MOOD_TINT = {
  warm:   0,
  bright: +5,
  calm:   -3,
  dark:   -10,
  any:    0,
};

let currentFire = { brightness: 0.8, scale: 1, saturate: 1, glow: 0.3, hue: 0 };
let targetFire  = { brightness: 0.8, scale: 1, saturate: 1, glow: 0.3, hue: 0 };

function computeFireTarget(activity, mood) {
  const t = Math.max(0, Math.min(activity / 25, 1));  // 0..1

  return {
    brightness: 0.5 + t * 0.7,     // 0.5..1.2
    scale:      0.9 + t * 0.2,     // 0.9..1.1
    saturate:   0.8 + t * 0.4,     // 0.8..1.2
    glow:       0.1 + t * 0.5,     // 0.1..0.6
    hue:        MOOD_TINT[mood] || 0,
  };
}

let fireRAF = null;

function updateFireIntensity(activity) {
  const mood = state.currentGlade?.mood;
  targetFire = computeFireTarget(activity, mood);
  startFireLoop();   // запускаем цикл, если ещё не запущен
}

function startFireLoop() {
  if (fireRAF) return;   // уже крутится
  fireRAF = requestAnimationFrame(tickFire);
}

function tickFire() {
  const k = 0.06;
  let stillMoving = false;

  for (const key of Object.keys(currentFire)) {
    const diff = targetFire[key] - currentFire[key];
    if (Math.abs(diff) > 0.001) {
      currentFire[key] += diff * k;
      stillMoving = true;
    } else {
      currentFire[key] = targetFire[key];
    }
  }

  const root = document.documentElement;
  root.style.setProperty('--fire-brightness', currentFire.brightness.toFixed(3));
  root.style.setProperty('--fire-scale',      currentFire.scale.toFixed(3));
  root.style.setProperty('--fire-saturate',   currentFire.saturate.toFixed(3));
  root.style.setProperty('--fire-glow',       currentFire.glow.toFixed(3));
  root.style.setProperty('--fire-hue',        currentFire.hue.toFixed(1) + 'deg');

  if (stillMoving) {
    fireRAF = requestAnimationFrame(tickFire);
  } else {
    fireRAF = null;   // остановились
  }
}

// ============================================================
// РЕПЛИКИ
// ============================================================
function renderMessages(options = {}) {
  const { scrollToBottom = false } = options;
  const el = document.getElementById('replies');

  // Сколько реплик держать в DOM
  const MAX_IN_DOM = 500;

  // Определяем диапазон для рендера
  let from, to;
  if (state.messages.length <= MAX_IN_DOM) {
    from = 0;
    to = state.messages.length;
  } else {
    from = state.messages.length - MAX_IN_DOM;
    to = state.messages.length;
  }

  const visible = state.messages.slice(from, to);

  // Просто рисуем. Скролл не трогаем.
  el.innerHTML = '';
  visible.forEach(m => el.appendChild(renderReply(m)));

  // Если просили — скроллим вниз, но в следующем кадре
  if (scrollToBottom) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

function renderReply(m) {
  const div = document.createElement('div');
  div.className = 'reply';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = m.display_name || 'Аноним';
  div.appendChild(who);
  div.appendChild(document.createTextNode(m.text));
  return div;
}

// ============================================================
// UI
// ============================================================
function bindUI() {
  const input = document.getElementById('say-input');
  const btn = document.getElementById('say-btn');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      say();
    }
  });

  btn.onclick = say;

  // Модалка ника
  document.getElementById('name-ok').onclick = submitName;
  document.getElementById('name-cancel').onclick = () => closeNameModal();
  document.getElementById('name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitName();
  });

  // Модалка создания темы
  document.getElementById('topic-ok').onclick = submitTopic;
  document.getElementById('topic-cancel').onclick = () => closeTopicModal();
  document.getElementById('topic-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitTopic();
  });

  // Шторка настроек
  const drawer = document.getElementById('settings-drawer');
  document.getElementById('settings-btn').onclick = () => {
    drawer.classList.toggle('open');
  };
  document.getElementById('drawer-close').onclick = () => {
    drawer.classList.remove('open');
  };

  // Кнопка звука
  document.getElementById('sound-btn').onclick = toggleSound;
  
  // Иконка звука — стартовое состояние
  setSoundIcon(false);

  // Стартовая модалка — обработчик
  document.getElementById('intro-ok').onclick = () => {
    document.getElementById('intro-modal').classList.add('hidden');
    document.getElementById('fire-video').play();
    localStorage.setItem('koster_intro_seen', '1');
  };

  bindScrollListener();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (fireRAF) {
        cancelAnimationFrame(fireRAF);
        fireRAF = null;
      }
    } else {
      startFireLoop();
    }
  });
}

// ============================================================
// ЗВУК КОСТРА
// ============================================================
function toggleSound() {
  if (state.soundOn) stopSound();
  else startSound();
}

function startSound() {
  if (!state.fireAudio) {
    state.fireAudio = new Audio('/sounds/fire.mp3');
    state.fireAudio.loop = true;
    state.fireAudio.volume = 0;
    state.fireAudio.preload = 'auto';
  }

  state.fireAudio.play().then(() => {
    let vol = 0;
    const fadeIn = setInterval(() => {
      vol += 0.03;
      if (vol >= 0.6) {
        vol = 0.6;
        clearInterval(fadeIn);
      }
      state.fireAudio.volume = vol;
    }, 50);

    state.soundOn = true;
    setSoundIcon(true);
  }).catch(e => {
    console.warn('Не удалось запустить звук:', e);
    showHint('Не удалось загрузить звук костра.');
    setSoundIcon(false);
    state.soundOn = false;
  });
}

function stopSound() {
  if (state.fireAudio) {
    let vol = state.fireAudio.volume;
    const fadeOut = setInterval(() => {
      vol -= 0.05;
      if (vol <= 0) {
        vol = 0;
        clearInterval(fadeOut);
        state.fireAudio.pause();
        state.fireAudio.currentTime = 0;
      }
      state.fireAudio.volume = vol;
    }, 40);
  }
  state.soundOn = false;
  setSoundIcon(false);
}

function setSoundIcon(on) {
  const onIcon  = document.getElementById('sound-icon-on');
  const offIcon = document.getElementById('sound-icon-off');
  const btn     = document.getElementById('sound-btn');
  if (!onIcon || !offIcon || !btn) return;

  onIcon.classList.toggle('hidden', !on);
  offIcon.classList.toggle('hidden', on);
  btn.classList.toggle('on', on);
}

function say() {
  const input = document.getElementById('say-input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.currentTopic) return;

  if (!state.me.displayName) {
    openNameModal(text);
    return;
  }

  wsSend({ type: 'say', topicId: state.currentTopic.id, text });
  input.value = '';
  input.style.height = 'auto';
  showHint('');
}

let pendingText = null;
function openNameModal(text) {
  pendingText = text;
  document.getElementById('name-modal').classList.remove('hidden');
  document.getElementById('fire-video').pause();
  setTimeout(() => document.getElementById('name-input').focus(), 100);
}
function closeNameModal() {
  document.getElementById('name-modal').classList.add('hidden');
  document.getElementById('fire-video').play();
  pendingText = null;
}
function submitName() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) return;
  const lock = document.getElementById('name-lock').checked;

  wsSend({ type: 'set-name', name, lock });
  state.me.displayName = name;

  document.getElementById('name-modal').classList.add('hidden');
  document.getElementById('fire-video').play();

  if (pendingText && state.currentTopic) {
    wsSend({ type: 'say', topicId: state.currentTopic.id, text: pendingText });
    document.getElementById('say-input').value = '';
    pendingText = null;
  }
}

function showHint(text) {
  document.getElementById('say-hint').textContent = text || '';
}

function openTopicModal() {
  document.getElementById('topic-title').value = '';
  document.getElementById('topic-desc').value = '';
  document.getElementById('topic-modal').classList.remove('hidden');
  document.getElementById('fire-video').pause();
  setTimeout(() => document.getElementById('topic-title').focus(), 100);
}

function closeTopicModal() {
  document.getElementById('topic-modal').classList.add('hidden');
  document.getElementById('fire-video').play();
}

async function submitTopic() {
  const title = document.getElementById('topic-title').value.trim();
  if (!title) return;
  const description = document.getElementById('topic-desc').value.trim();

  const slug = state.currentGlade.slug;
  try {
    const res = await fetch(`/api/glades/${slug}/topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    });
    if (!res.ok) throw new Error('failed to create topic');
    const data = await res.json();

    // Добавить в локальный список
    if (!state.topicsByGlade[slug]) state.topicsByGlade[slug] = [];
    state.topicsByGlade[slug].unshift(data.topic);

    closeTopicModal();

    // Сразу перейти в новую тему
    enterTopic(data.topic);
  } catch (e) {
    console.error('Не удалось создать тему:', e);
    alert('Не удалось создать тему');
  }
}

function bindScrollListener() {
  const el = document.getElementById('replies');
  if (!el || el._scrollBound) return;
  el._scrollBound = true;

  let scrollThrottle = null;
  el.addEventListener('scroll', () => {
    if (scrollThrottle) return;
    scrollThrottle = setTimeout(() => {
      scrollThrottle = null;
      if (el.scrollTop < 100) {
        loadMoreHistory();
      }
    }, 100);
  });
}

async function loadMoreHistory() {
  if (state.loadingHistory) return;
  if (!state.hasMoreHistory) return;
  if (!state.currentTopic) return;
  if (state.messages.length === 0) return;

  state.loadingHistory = true;
  showHistoryLoader();

  const el = document.getElementById('replies');
  const prevScrollHeight = el.scrollHeight;
  const prevScrollTop = el.scrollTop;

  const oldest = state.messages[0];
  const before = oldest.created_at;

  try {
    const res = await fetch(
      `/api/topics/${state.currentTopic.id}/messages?before=${before}&limit=50`
    );
    if (!res.ok) throw new Error('failed to load history');
    const data = await res.json();

    if (data.messages.length === 0) {
      state.hasMoreHistory = false;
    } else {
      state.messages = [...data.messages, ...state.messages];
      renderMessages();

      // Один RAF — ставит скролл и отпускает флаг
      requestAnimationFrame(() => {
        const newScrollHeight = el.scrollHeight;
        el.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
        state.loadingHistory = false;
        hideHistoryLoader();
      });
      return;   // ← не сбрасываем флаг в finally
    }
  } catch (e) {
    console.error('Не удалось загрузить историю:', e);
  }

  state.loadingHistory = false;
  hideHistoryLoader();
}

function showHistoryLoader() {
  const loader = document.getElementById('history-loader');
  if (loader) loader.classList.remove('hidden');
}

function hideHistoryLoader() {
  const loader = document.getElementById('history-loader');
  if (loader) loader.classList.add('hidden');
}


// ============================================================
// УТИЛИТЫ
// ============================================================
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Старт
init();
