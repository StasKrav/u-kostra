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
  activities: {},           // ← карта slug → активность
  presenceByGlade: {},      // ← карта slug → число людей
  ws: null,
  wsReady: false,
};
// ============================================================
// WS
// ============================================================
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => { state.wsReady = true; enterGlade(state.currentGlade.slug, true); };
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
      if (msg.gladeSlug !== state.currentGlade.slug) return;
      state.messages = msg.messages;
      state.targetActivity = msg.activity;
      renderMessages();
      break;
    case 'reply':
      if (msg.gladeId !== state.currentGlade.id) return;
      state.messages.push(msg.message);
      renderMessages();
      spawnSpeaker(msg.message.display_name || 'Аноним');
      break;
    
    case 'speaking':
      if (msg.gladeId !== state.currentGlade.id) return;
      if (msg.name !== state.me.displayName) {
        spawnSpeaker(msg.name || 'Аноним');
      }
      break;
    case 'presence':
      if (msg.gladeId !== state.currentGlade.id) return;
      state.presence = msg.users;
      updateOnline();
      updateGladeCounts();
      break;
    case 'activity':
      state.targetActivity = msg.activity;
      state.activities[state.currentGlade.slug] = msg.activity;
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

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================
async function init() {
  const me = await fetch('/api/me').then(r => r.json());
  state.me = me;

  const glades = await fetch('/api/glades').then(r => r.json());
  state.glades = glades;
  state.currentGlade = glades[0];

  renderGlades();
  // initFire();
  connectWS();
  bindUI();
}

// ============================================================
// ПОЛЯНЫ
// ============================================================
function renderGlades() {
  const el = document.getElementById('glades');
  el.innerHTML = '';
  state.glades.forEach(g => {
    const item = document.createElement('div');
    item.className = 'glade-item' + (g.slug === state.currentGlade.slug ? ' active' : '');
    item.dataset.slug = g.slug;
    item.innerHTML = `
      <span class="spark"></span>
      <span class="glade-name">${escapeHtml(g.title)}</span>
      <span class="glade-count" data-count></span>
    `;
    item.onclick = () => enterGlade(g.slug, false);
    el.appendChild(item);
  });
  updateGladeSparks();
}

function enterGlade(slug, silent) {
  const g = state.glades.find(x => x.slug === slug);
  if (!g) return;

  if (state.sitting && state.currentGlade) {
    wsSend({ type: 'leave', glade: state.currentGlade.slug });
  }

  state.currentGlade = g;
  state.messages = [];
  state.presence = [];
  state.sitting = true;

  document.getElementById('glade-title').textContent = g.title;
  renderGlades();
  updateGladeCounts();
  renderMessages();
  updateOnline();
  applyMood(g.mood);

  wsSend({ type: 'sit', glade: g.slug });
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
  // Обновляем счётчик только для активной поляны (для остальных у нас нет данных)
  const items = document.querySelectorAll('.glade-item');
  items.forEach(el => {
    const countEl = el.querySelector('[data-count]');
    if (!countEl) return;

    if (el.dataset.slug === state.currentGlade.slug) {
      const n = state.presence.length;
      countEl.textContent = n > 0 ? n : '';
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
  const n = state.presence.length;
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
function updateFireIntensity(activity) {
  const target = Math.max(0, Math.min(activity / 25, 1));
  displayedIntensity += (target - displayedIntensity) * 0.15;
  document.documentElement.style.setProperty('--fire-intensity', displayedIntensity.toFixed(3));
}

function updateOnline() {
  const n = state.presence.length;
  document.getElementById('online-count').textContent =
    n === 0 ? 'никого' :
    n === 1 ? '1 рядом' :
    `${n} рядом`;
}

// ============================================================
// РЕПЛИКИ
// ============================================================
function renderMessages() {
  const el = document.getElementById('replies');
  el.innerHTML = '';
  const last = state.messages.slice(-30);
  last.forEach(m => el.appendChild(renderReply(m)));
  el.scrollTop = el.scrollHeight;
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

// // ============================================================
// // ОГОНЬ — оптимизированная версия
// // ============================================================
// const fireCanvas = document.getElementById('fire-canvas');
// const ctx = fireCanvas.getContext('2d', { alpha: true });
// let particles = [];
// let canvasW = 0, canvasH = 0;
// let currentScale = 1;
// let flameSprite = null;
// let lastFrameTime = 0;
// const TARGET_FPS = 30;
// const FRAME_INTERVAL = 1000 / TARGET_FPS;
// 
// function initFire() {
//   resizeCanvas();
//   window.addEventListener('resize', () => {
//     ctx.setTransform(1, 0, 0, 1, 0, 0);
//     resizeCanvas();
//   });
// 
//   // Спрайт пламени рисуем один раз
//   flameSprite = createFlameSprite();
// 
//   for (let i = 0; i < 70; i++) particles.push(createFlame());   // было 110
//   for (let i = 0; i < 15; i++) particles.push(createSpark(true)); // было 25
// 
//   document.addEventListener('visibilitychange', () => {
//     if (!document.hidden) {
//       lastFrameTime = 0;
//       requestAnimationFrame(animateFire);
//     }
//   });
// 
//   requestAnimationFrame(animateFire);
// }
// 
// function resizeCanvas() {
//   const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // ← потолок DPR
//   const isMobile = window.innerWidth < 900;
// 
//   // Жёсткий лимит физического размера
//   const cssW = Math.min(window.innerWidth * 0.5, isMobile ? 260 : 420);
//   const cssH = isMobile ? 260 : 360;
// 
//   canvasW = cssW;
//   canvasH = cssH;
// 
//   fireCanvas.width = Math.round(cssW * dpr);
//   fireCanvas.height = Math.round(cssH * dpr);
//   fireCanvas.style.width = cssW + 'px';
//   fireCanvas.style.height = cssH + 'px';
//   ctx.scale(dpr, dpr);
// }
// 
// // Offscreen-спрайт пламени — рисуется один раз
// function createFlameSprite() {
//   const size = 64;
//   const c = document.createElement('canvas');
//   c.width = size;
//   c.height = size;
//   const g = c.getContext('2d');
// 
//   const grad = g.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
//   grad.addColorStop(0,   'rgba(255, 240, 200, 1)');
//   grad.addColorStop(0.25,'rgba(255, 180, 80, 0.9)');
//   grad.addColorStop(0.5, 'rgba(255, 110, 30, 0.6)');
//   grad.addColorStop(0.8, 'rgba(200, 60, 10, 0.2)');
//   grad.addColorStop(1,   'rgba(120, 30, 0, 0)');
// 
//   g.fillStyle = grad;
//   g.beginPath();
//   g.arc(size/2, size/2, size/2, 0, Math.PI * 2);
//   g.fill();
// 
//   return c;
// }
// 
// function createFlame() {
//   return {
//     type: 'flame',
//     x: canvasW / 2 + (Math.random() - 0.5) * 90,
//     y: canvasH - 20 + Math.random() * 10,
//     vx: (Math.random() - 0.5) * 0.4,
//     vy: -(1.5 + Math.random() * 2.5),
//     life: 0, maxLife: 60 + Math.random() * 60,
//     size: 12 + Math.random() * 24,
//   };
// }
// 
// function createSpark(initial = false) {
//   return {
//     type: 'spark',
//     x: canvasW / 2 + (Math.random() - 0.5) * 60,
//     y: canvasH - 30 - Math.random() * 20,
//     vx: (Math.random() - 0.5) * 1.5,
//     vy: -(1 + Math.random() * 2),
//     life: initial ? Math.random() * 200 : 0,
//     maxLife: 120 + Math.random() * 100,
//     size: 1 + Math.random() * 2,
//   };
// }
// 
// function animateFire(now = 0) {
//   // Троттлинг FPS
//   if (now - lastFrameTime < FRAME_INTERVAL) {
//     requestAnimationFrame(animateFire);
//     return;
//   }
//   lastFrameTime = now;
// 
//   // Пауза при скрытой вкладке
//   if (document.hidden) return;
// 
//   // Плавная интерполяция активности → масштаб
//   const targetScale = 0.7 + Math.min(state.targetActivity, 25) / 25 * 0.6;
//   currentScale += (targetScale - currentScale) * 0.05;
// 
//   ctx.globalCompositeOperation = 'source-over';
//   ctx.fillStyle = 'rgba(6, 4, 2, 0.22)';  // чуть плотнее — сглаживает хвосты
//   ctx.fillRect(0, 0, canvasW, canvasH);
// 
//   ctx.globalCompositeOperation = 'lighter';
//   const breath = 0.7 + 0.3 * Math.sin(now / 1400);
//   const cx = canvasW / 2;
// 
//   // Пламя — рисуем спрайтами
//   for (let i = 0; i < particles.length; i++) {
//     const p = particles[i];
//     p.life++;
//     p.x += p.vx;
//     p.y += p.vy;
//     p.vy *= 0.985;
//     p.vx += (Math.random() - 0.5) * 0.1;
// 
//     const lifeRatio = p.life / p.maxLife;
//     const alpha = Math.max(0, 1 - lifeRatio) * breath * currentScale;
// 
//     if (p.type === 'flame') {
//       const r = p.size * (1 - lifeRatio * 0.4) * currentScale;
//       if (r > 0.5) {
//         ctx.globalAlpha = alpha;
//         ctx.drawImage(flameSprite, p.x - r, p.y - r, r * 2, r * 2);
//       }
//     } else {
//       // Искра — просто точка, без shadowBlur
//       ctx.globalAlpha = alpha;
//       ctx.fillStyle = 'rgba(255, 200, 120, 1)';
//       ctx.beginPath();
//       ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
//       ctx.fill();
//     }
// 
//     if (p.life >= p.maxLife) {
//       particles[i] = p.type === 'flame' ? createFlame() : createSpark();
//     }
//   }
//   ctx.globalAlpha = 1;
// 
//   // Мягкое свечение основания (один градиент на кадр — терпимо)
//   const glowR = 140 * breath * currentScale;
//   const g = ctx.createRadialGradient(cx, canvasH - 30, 0, cx, canvasH - 30, glowR);
//   g.addColorStop(0, `rgba(255, 130, 40, ${0.28 * breath})`);
//   g.addColorStop(0.5, `rgba(255, 80, 20, ${0.1 * breath})`);
//   g.addColorStop(1, 'rgba(255, 60, 10, 0)');
//   ctx.fillStyle = g;
//   ctx.fillRect(0, 0, canvasW, canvasH);
// 
//   // Угли (без изменений, но их мало — 12 штук)
//   ctx.globalCompositeOperation = 'lighter';
//   for (let i = 0; i < 12; i++) {
//     const ex = cx + (Math.random() - 0.5) * 100 * currentScale;
//     const ey = canvasH - 15 + (Math.random() - 0.5) * 8;
//     const a = Math.random() * 0.5 * breath;
//     ctx.fillStyle = `rgba(255, 80, 20, ${a})`;
//     ctx.beginPath();
//     ctx.arc(ex, ey, (1.5 + Math.random() * 2) * currentScale, 0, Math.PI * 2);
//     ctx.fill();
//   }
// 
//   requestAnimationFrame(animateFire);
// }

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
}

function say() {
  const input = document.getElementById('say-input');
  const text = input.value.trim();
  if (!text) return;

  if (!state.me.displayName) {
    openNameModal(text);
    return;
  }

  wsSend({ type: 'say', glade: state.currentGlade.slug, text });
  input.value = '';
  input.style.height = 'auto';
  showHint('');
}

let pendingText = null;
function openNameModal(text) {
  pendingText = text;
  document.getElementById('name-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('name-input').focus(), 100);
}
function closeNameModal() {
  document.getElementById('name-modal').classList.add('hidden');
  pendingText = null;
}
function submitName() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) return;
  const lock = document.getElementById('name-lock').checked;

  wsSend({ type: 'set-name', name, lock });
  state.me.displayName = name;

  document.getElementById('name-modal').classList.add('hidden');

  if (pendingText) {
    wsSend({ type: 'say', glade: state.currentGlade.slug, text: pendingText });
    document.getElementById('say-input').value = '';
    pendingText = null;
  }
}

function showHint(text) {
  document.getElementById('say-hint').textContent = text || '';
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
