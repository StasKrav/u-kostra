import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

import { queries } from './db.js';
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

// API: история поляны
app.get('/api/glades/:slug/messages', (req, res) => {
  getOrCreateUser(req, res);
  const glade = queries.findGladeBySlug.get(req.params.slug);
  if (!glade) return res.status(404).json({ error: 'no such glade' });
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const messages = queries.recentMessages.all(glade.id, limit).reverse();
  res.json({ glade: { id: glade.id, slug: glade.slug, title: glade.title }, messages });
});

// WebSocket
attachWebSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔥 Костёр горит на http://localhost:${PORT}`);
});
