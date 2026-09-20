import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import 'dotenv/config';

const DB_PATH = process.env.DB_PATH || './data/koster.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// СХЕМА
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    token         TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    name_locked   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen     INTEGER
  );

  CREATE TABLE IF NOT EXISTS glades (
    id           INTEGER PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    description  TEXT,
    mood         TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    is_permanent INTEGER NOT NULL DEFAULT 1,
    created_by   INTEGER REFERENCES users(id),
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS presence (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    glade_id     INTEGER NOT NULL REFERENCES glades(id) ON DELETE CASCADE,
    joined_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, glade_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY,
    glade_id     INTEGER NOT NULL REFERENCES glades(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    text         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'normal',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    score        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_glade
    ON messages(glade_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS votes (
    message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dir          INTEGER NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_id)
  );
`);

// ============================================================
// СИДЫ: 6 полян
// ============================================================
const GLADES = [
  { slug: 'common', title: 'Общий костёр',  description: 'Просто посидеть. Без повода.',       mood: 'warm',   sort_order: 1 },
  { slug: 'advice', title: 'Спросить совета', description: 'Конкретный вопрос — конкретный ответ.', mood: 'calm',   sort_order: 2 },
  { slug: 'vent',   title: 'Выговориться',  description: 'Тут не советуют. Тут слушают.',       mood: 'dark',   sort_order: 3 },
  { slug: 'humor',  title: 'Поржать',       description: 'Тут не жалуются. Тут ржут.',          mood: 'bright', sort_order: 4 },
  { slug: 'media',  title: 'Что читаете',   description: 'Книги, фильмы, музыка.',              mood: 'calm',   sort_order: 5 },
  { slug: 'abyss',  title: 'Бездна',        description: 'Сырое, странное, случайное.',         mood: 'any',    sort_order: 6 },
];

const insertGlade = db.prepare(`
  INSERT INTO glades (slug, title, description, mood, sort_order, is_permanent)
  VALUES (@slug, @title, @description, @mood, @sort_order, 1)
  ON CONFLICT(slug) DO NOTHING
`);

for (const g of GLADES) insertGlade.run(g);

// ============================================================
// ГОТОВЫЕ ЗАПРОСЫ
// ============================================================
export const queries = {
  // --- пользователи ---
  createUser: db.prepare(`
    INSERT INTO users (token, last_seen) VALUES (?, unixepoch())
  `),
  findUserByToken: db.prepare(`
    SELECT * FROM users WHERE token = ?
  `),
  touchUser: db.prepare(`
    UPDATE users SET last_seen = unixepoch() WHERE id = ?
  `),
  setDisplayName: db.prepare(`
    UPDATE users SET display_name = ?, name_locked = ? WHERE id = ?
  `),

  // --- поляны ---
  listGlades: db.prepare(`
    SELECT * FROM glades WHERE is_permanent = 1 OR expires_at > unixepoch()
    ORDER BY sort_order ASC
  `),
  findGladeBySlug: db.prepare(`
    SELECT * FROM glades WHERE slug = ?
  `),
  findGladeById: db.prepare(`
    SELECT * FROM glades WHERE id = ?
  `),

  // --- присутствие ---
  sit: db.prepare(`
    INSERT INTO presence (user_id, glade_id, last_seen)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id, glade_id) DO UPDATE SET last_seen = unixepoch()
  `),
  leave: db.prepare(`
    DELETE FROM presence WHERE user_id = ? AND glade_id = ?
  `),
  leaveAll: db.prepare(`
    DELETE FROM presence WHERE user_id = ?
  `),
  listPresence: db.prepare(`
    SELECT u.id, u.display_name FROM presence p
    JOIN users u ON u.id = p.user_id
    WHERE p.glade_id = ? AND p.last_seen > unixepoch() - 60
    ORDER BY p.joined_at ASC
  `),
  countPresence: db.prepare(`
    SELECT COUNT(*) AS n FROM presence
    WHERE glade_id = ? AND last_seen > unixepoch() - 60
  `),
  cleanupStalePresence: db.prepare(`
    DELETE FROM presence WHERE last_seen < unixepoch() - 120
  `),

  // --- сообщения ---
  insertMessage: db.prepare(`
    INSERT INTO messages (glade_id, user_id, display_name, text, kind)
    VALUES (?, ?, ?, ?, ?)
  `),
  getMessage: db.prepare(`
    SELECT m.*, u.id AS user_id FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.id = ?
  `),
  recentMessages: db.prepare(`
    SELECT * FROM messages WHERE glade_id = ?
    ORDER BY created_at DESC LIMIT ?
  `),
  countRecentMessages: db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE glade_id = ? AND created_at > unixepoch() - 300
  `),
  lastMessageAt: db.prepare(`
    SELECT MAX(created_at) AS t FROM messages WHERE glade_id = ?
  `),
};
