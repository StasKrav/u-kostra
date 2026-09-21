import { WebSocketServer } from 'ws';
import { db, queries } from './db.js';
import { findUserByToken, COOKIE } from './auth.js';
import { computeActivity } from './activity.js';

const RATE_LIMIT_MS = 5000;
const MAX_TEXT = 2000;

const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

const clients = new Map();          // userId -> entry
const topicPresence = new Map();    // topicId -> Set<userId>

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function send(entry, payload) {
  if (entry.ws.readyState === 1) entry.ws.send(JSON.stringify(payload));
}

function broadcastTopic(topicId, payload, exceptUserId = null) {
  const ids = topicPresence.get(topicId);
  if (!ids) return;
  const json = JSON.stringify(payload);
  for (const uid of ids) {
    if (uid === exceptUserId) continue;
    const c = clients.get(uid);
    if (c && c.ws.readyState === 1) c.ws.send(json);
  }
}

function broadcastActivity(topicId) {
  broadcastTopic(topicId, {
    type: 'activity',
    topicId,
    activity: computeActivity(topicId),
  });
}

function broadcastActivityAll() {
  // Активность по всем темам всех полян — для огоньков в сайдбаре
  const glades = queries.listGlades.all();
  const activities = {};
  for (const g of glades) {
    const topics = queries.listTopics.all(g.id);
    let maxActivity = 0;
    for (const t of topics) {
      const a = computeActivity(t.id);
      if (a > maxActivity) maxActivity = a;
    }
    activities[g.slug] = maxActivity;
  }
  const payload = JSON.stringify({ type: 'activity-all', activities });
  for (const entry of clients.values()) {
    if (entry.ws.readyState === 1) entry.ws.send(payload);
  }
}

function presenceList(topicId) {
  return queries.listPresence.all(topicId).map(u => ({
    userId: u.id,
    name: u.display_name || 'Кто-то',
  }));
}

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const user = findUserByToken(cookies[COOKIE]);
    if (!user) { ws.close(4001, 'no-session'); return; }

    const entry = {
      ws,
      userId: user.id,
      currentTopicId: null,
      lastSay: 0,
    };
    clients.set(user.id, entry);

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      handleMessage(entry, msg);
    });

    ws.on('close', () => {
      if (entry.currentTopicId !== null) {
        queries.leave.run(entry.userId, entry.currentTopicId);
        const set = topicPresence.get(entry.currentTopicId);
        if (set) {
          set.delete(entry.userId);
          if (set.size === 0) topicPresence.delete(entry.currentTopicId);
        }
        broadcastTopic(entry.currentTopicId, {
          type: 'presence',
          topicId: entry.currentTopicId,
          users: presenceList(entry.currentTopicId),
        });
        broadcastActivity(entry.currentTopicId);
      }
      clients.delete(entry.userId);
    });

    send(entry, { type: 'ready', userId: user.id, displayName: user.display_name });
  });

  setInterval(() => {
    queries.cleanupStalePresence.run();
    for (const tid of topicPresence.keys()) broadcastActivity(tid);
    broadcastActivityAll();
  }, 10_000);
}

function handleMessage(entry, msg) {
  switch (msg.type) {
    case 'enter-topic':  return handleEnterTopic(entry, msg);
    case 'leave-topic':  return handleLeaveTopic(entry, msg);
    case 'say':          return handleSay(entry, msg);
    case 'set-name':     return handleSetName(entry, msg);
    case 'ping':         return handlePing(entry);
  }
}

function handleEnterTopic(entry, msg) {
  const topicId = Number(msg.topicId);
  if (!topicId) return;
  const topic = queries.findTopicById.get(topicId);
  if (!topic) return;

  // Выйти из старой темы
  if (entry.currentTopicId !== null && entry.currentTopicId !== topicId) {
    queries.leave.run(entry.userId, entry.currentTopicId);
    const oldSet = topicPresence.get(entry.currentTopicId);
    if (oldSet) {
      oldSet.delete(entry.userId);
      if (oldSet.size === 0) topicPresence.delete(entry.currentTopicId);
    }
    broadcastTopic(entry.currentTopicId, {
      type: 'presence',
      topicId: entry.currentTopicId,
      users: presenceList(entry.currentTopicId),
    });
    broadcastActivity(entry.currentTopicId);
  }

  // Войти в новую
  entry.currentTopicId = topicId;
  queries.sit.run(entry.userId, topicId);

  if (!topicPresence.has(topicId)) topicPresence.set(topicId, new Set());
  topicPresence.get(topicId).add(entry.userId);

  // История
  const messages = queries.recentMessages.all(topicId, 50).reverse();
  send(entry, {
    type: 'history',
    topicId,
    topic,
    activity: computeActivity(topicId),
    messages,
  });

  // Список присутствующих
  broadcastTopic(topicId, {
    type: 'presence',
    topicId,
    users: presenceList(topicId),
  });
  broadcastActivity(topicId);
}

function handleLeaveTopic(entry, msg) {
  const topicId = Number(msg.topicId);
  if (!topicId) return;
  if (entry.currentTopicId !== topicId) return;

  queries.leave.run(entry.userId, topicId);
  const set = topicPresence.get(topicId);
  if (set) {
    set.delete(entry.userId);
    if (set.size === 0) topicPresence.delete(topicId);
  }
  entry.currentTopicId = null;

  broadcastTopic(topicId, {
    type: 'presence',
    topicId,
    users: presenceList(topicId),
  });
  broadcastActivity(topicId);
}

function handleSay(entry, msg) {
  const now = Date.now();
  if (now - entry.lastSay < RATE_LIMIT_MS) {
    send(entry, { type: 'rate-limit', retryAfter: RATE_LIMIT_MS });
    return;
  }

  const topicId = Number(msg.topicId);
  if (!topicId) return;
  const topic = queries.findTopicById.get(topicId);
  if (!topic) return;

  const text = String(msg.text || '').trim().slice(0, MAX_TEXT);
  if (!text) return;

  const user = getUserById.get(entry.userId);
  const displayName = user?.display_name || 'Аноним';

  const info = queries.insertMessage.run(topicId, entry.userId, displayName, text, 'normal');
  const message = queries.getMessage.get(info.lastInsertRowid);

  queries.updateTopicActivity.run(topicId);

  entry.lastSay = now;

  broadcastTopic(topicId, { type: 'reply', topicId, message });
  broadcastTopic(topicId, {
    type: 'speaking',
    topicId,
    name: displayName,
    userId: entry.userId,
  }, entry.userId);
}

function handleSetName(entry, msg) {
  const name = String(msg.name || '').trim().slice(0, 30);
  if (!name) return;
  const locked = msg.lock ? 1 : 0;
  queries.setDisplayName.run(name, locked, entry.userId);
  send(entry, { type: 'name-set', name, locked: !!locked });
}

function handlePing(entry) {
  if (entry.currentTopicId !== null) {
    queries.sit.run(entry.userId, entry.currentTopicId);
  }
}
