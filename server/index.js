import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

import { db, queries } from './db.js';
import { getOrCreateUser } from './auth.js';
import { attachWebSocket } from './ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

// Статика
app.use(express.static(join(__dirname, '..', 'public')));

// API: кто я
app.get('/api/me', (req, res) => {
  const user = getOrCreateUser(req, res);
  res.json({
    userId: user.id,
    displayName: user.display_name,
    nameLocked: !!user.name_locked,
  });
});

// API: список полян
app.get('/api/glades', (req, res) => {
  getOrCreateUser(req, res);
  const glades = queries.listGlades.all();
  res.json(glades.map(g => ({
    id: g.id, slug: g.slug, title: g.title,
    description: g.description, mood: g.mood,
  })));
});

// API: список тем поляны
app.get('/api/glades/:slug/topics', (req, res) => {
  getOrCreateUser(req, res);
  const glade = queries.findGladeBySlug.get(req.params.slug);
  if (!glade) return res.status(404).json({ error: 'no such glade' });

  const topics = queries.listTopics.all(glade.id);
  res.json({
    glade: { id: glade.id, slug: glade.slug, title: glade.title, description: glade.description },
    topics,
  });
});

// API: создать тему
app.post('/api/glades/:slug/topics', (req, res) => {
  const user = getOrCreateUser(req, res);
  const glade = queries.findGladeBySlug.get(req.params.slug);
  if (!glade) return res.status(404).json({ error: 'no such glade' });

  if (glade.slug === 'common') {
    return res.status(400).json({ error: 'common glade has no topics' });
  }

  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'title required' });

  const description = String(req.body?.description || '').trim().slice(0, 500);

  const info = queries.createTopic.run(glade.id, title, description, user.id);
  const topic = queries.findTopicById.get(info.lastInsertRowid);

  res.json({ topic });
});

// API: реплики темы
app.get('/api/topics/:id/messages', (req, res) => {
  getOrCreateUser(req, res);
  const topicId = Number(req.params.id);
  const topic = queries.findTopicById.get(topicId);
  if (!topic) return res.status(404).json({ error: 'no such topic' });

  const limit = Math.min(Number(req.query.limit || 50), 200);
  let messages;
  if (req.query.before) {
    messages = queries.messagesBefore.all(topicId, Number(req.query.before), limit);
  } else {
    messages = queries.recentMessages.all(topicId, limit);
  }
  res.json({ topic, messages: messages.reverse() });
});

// API: удалить тему (только автор)
app.delete('/api/topics/:id', (req, res) => {
  const user = getOrCreateUser(req, res);
  const topicId = Number(req.params.id);
  const topic = queries.findTopicById.get(topicId);
  if (!topic) return res.status(404).json({ error: 'no such topic' });
  if (topic.created_by !== user.id) return res.status(403).json({ error: 'not your topic' });

  queries.deleteTopic.run(topicId);
  res.json({ ok: true });
});

// WebSocket
attachWebSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔥 Костёр горит на http://localhost:${PORT}`);
});
