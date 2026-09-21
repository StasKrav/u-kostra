import { WebSocketServer } from 'ws';
import { db, queries } from './db.js';
import { findUserByToken, COOKIE } from './auth.js';
import { computeActivity } from './activity.js';

const RATE_LIMIT_MS = 5000;
const MAX_TEXT = 2000;

const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');

const clients = new Map();          // userId -> entry
const presenceIndex = new Map();    // gladeId -> Set<userId>

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

function broadcast(gladeId, payload, exceptUserId = null) {
  const ids = presenceIndex.get(gladeId);
  if (!ids) return;
  const json = JSON.stringify(payload);
  for (const uid of ids) {
    if (uid === exceptUserId) continue;
    const c = clients.get(uid);
    if (c && c.ws.readyState === 1) c.ws.send(json);
  }
}

function broadcastActivity(gladeId) {
  broadcast(gladeId, {
    type: 'activity',
    gladeId,
    activity: computeActivity(gladeId),
  });
}

function broadcastActivityAll() {
  const glades = queries.listGlades.all();
  const activities = {};
  for (const g of glades) {
    activities[g.slug] = computeActivity(g.id);
  }
  const payload = JSON.stringify({ type: 'activity-all', activities });
  for (const entry of clients.values()) {
    if (entry.ws.readyState === 1) entry.ws.send(payload);
  }
}

function presenceList(gladeId) {
  return queries.listPresence.all(gladeId).map(u => ({
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
      sittingGlades: new Set(),
      lastSay: 0,
    };
    clients.set(user.id, entry);

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      handleMessage(entry, msg);
    });

    ws.on('close', () => {
      for (const gid of entry.sittingGlades) {
        queries.leave.run(entry.userId, gid);
        const set = presenceIndex.get(gid);
        if (set) {
          set.delete(entry.userId);
          if (set.size === 0) presenceIndex.delete(gid);
        }
        broadcast(gid, { type: 'presence', gladeId: gid, users: presenceList(gid) });
        broadcastActivity(gid);
      }
      clients.delete(entry.userId);
    });

    send(entry, { type: 'ready', userId: user.id, displayName: user.display_name });
  });

  setInterval(() => {
    queries.cleanupStalePresence.run();
    for (const gid of presenceIndex.keys()) broadcastActivity(gid);
    broadcastActivityAll();
  }, 10_000);
}

function handleMessage(entry, msg) {
  switch (msg.type) {
    case 'watch': return handleWatch(entry, msg);
    case 'sit':   return handleSit(entry, msg);
    case 'leave': return handleLeave(entry, msg);
    case 'say':   return handleSay(entry, msg);
    case 'set-name': return handleSetName(entry, msg);
  }
}

function handleWatch(entry, msg) {
  const glade = queries.findGladeBySlug.get(msg.glade);
  if (!glade) return;
  const messages = queries.recentMessages.all(glade.id, 50).reverse();
  send(entry, {
    type: 'history',
    gladeId: glade.id,
    gladeSlug: glade.slug,
    activity: computeActivity(glade.id),
    messages,
  });
}

function handleSit(entry, msg) {
  const glade = queries.findGladeBySlug.get(msg.glade);
  if (!glade) return;

  entry.sittingGlades.add(glade.id);
  queries.sit.run(entry.userId, glade.id);

  if (!presenceIndex.has(glade.id)) presenceIndex.set(glade.id, new Set());
  presenceIndex.get(glade.id).add(entry.userId);

  const messages = queries.recentMessages.all(glade.id, 50).reverse();
  send(entry, {
    type: 'history',
    gladeId: glade.id,
    gladeSlug: glade.slug,
    activity: computeActivity(glade.id),
    messages,
  });

  broadcast(glade.id, { type: 'presence', gladeId: glade.id, users: presenceList(glade.id) });
  broadcastActivity(glade.id);
}

function handleLeave(entry, msg) {
  const glade = queries.findGladeBySlug.get(msg.glade);
  if (!glade) return;

  entry.sittingGlades.delete(glade.id);
  queries.leave.run(entry.userId, glade.id);

  const set = presenceIndex.get(glade.id);
  if (set) {
    set.delete(entry.userId);
    if (set.size === 0) presenceIndex.delete(glade.id);
  }

  broadcast(glade.id, { type: 'presence', gladeId: glade.id, users: presenceList(glade.id) });
  broadcastActivity(glade.id);
}

function handleSay(entry, msg) {
  const now = Date.now();
  if (now - entry.lastSay < RATE_LIMIT_MS) {
    send(entry, { type: 'rate-limit', retryAfter: RATE_LIMIT_MS });
    return;
  }

  const glade = queries.findGladeBySlug.get(msg.glade);
  if (!glade) return;

  const text = String(msg.text || '').trim().slice(0, MAX_TEXT);
  if (!text) return;

  const user = getUserById.get(entry.userId);
  const displayName = user?.display_name || 'Аноним';

  const info = queries.insertMessage.run(glade.id, entry.userId, displayName, text, 'normal');
  const message = queries.getMessage.get(info.lastInsertRowid);

  entry.lastSay = now;

  broadcast(glade.id, { type: 'reply', gladeId: glade.id, message });
  broadcast(glade.id, {
    type: 'speaking',
    gladeId: glade.id,
    name: displayName,
  }, entry.userId);
}

function handleSetName(entry, msg) {
  const name = String(msg.name || '').trim().slice(0, 30);
  if (!name) return;
  const locked = msg.lock ? 1 : 0;
  queries.setDisplayName.run(name, locked, entry.userId);
  send(entry, { type: 'name-set', name, locked: !!locked });
}
