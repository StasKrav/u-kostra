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

  CREATE TABLE IF NOT EXISTS topics (
    id              INTEGER PRIMARY KEY,
    glade_id        INTEGER NOT NULL REFERENCES glades(id) ON DELETE CASCADE,
    title           TEXT,
    description     TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    last_message_at INTEGER,
    message_count   INTEGER NOT NULL DEFAULT 0,
    is_locked       INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_topics_glade
    ON topics(glade_id, COALESCE(last_message_at, created_at) DESC);

  CREATE TABLE IF NOT EXISTS presence (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    joined_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, topic_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY,
    topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    text         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'normal',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    score        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_topic
    ON messages(topic_id, created_at DESC);

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
  { slug: 'common', title: 'Большой Костёр', description: 'Просто посидеть. Без повода.',         mood: 'warm',   sort_order: 1 },
  { slug: 'advice', title: 'Страна Советов', description: 'Конкретный вопрос — конкретный ответ.', mood: 'calm',   sort_order: 2 },
  { slug: 'vent',   title: 'Выговориться',   description: 'Тут не советуют. Тут слушают.',        mood: 'dark',   sort_order: 3 },
  { slug: 'humor',  title: 'Юмор',           description: 'Тут не жалуются. Тут смеются.',        mood: 'bright', sort_order: 4 },
  { slug: 'media',  title: 'Саморазвитие',   description: 'Книги, фильмы, привычки, навыки.',      mood: 'calm',   sort_order: 5 },
  { slug: 'sport',  title: 'Спорт',          description: 'Бег, зал, велосипед, плавание.',        mood: 'bright', sort_order: 6 },
  { slug: 'abyss',  title: 'Бездна',         description: 'Сырое, странное, случайное.',           mood: 'any',    sort_order: 7 },
];

const insertGlade = db.prepare(`
  INSERT INTO glades (slug, title, description, mood, sort_order, is_permanent)
  VALUES (@slug, @title, @description, @mood, @sort_order, 1)
  ON CONFLICT(slug) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    mood = excluded.mood,
    sort_order = excluded.sort_order
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

  // --- темы ---
  listTopics: db.prepare(`
    SELECT t.*, u.display_name AS author_name
    FROM topics t
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.glade_id = ?
    ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
  `),
  findTopicById: db.prepare(`
    SELECT t.*, g.slug AS glade_slug, g.title AS glade_title
    FROM topics t
    JOIN glades g ON g.id = t.glade_id
    WHERE t.id = ?
  `),
  createTopic: db.prepare(`
    INSERT INTO topics (glade_id, title, description, created_by)
    VALUES (?, ?, ?, ?)
  `),
  deleteTopic: db.prepare(`
    DELETE FROM topics WHERE id = ?
  `),
  updateTopicActivity: db.prepare(`
    UPDATE topics
    SET last_message_at = unixepoch(),
        message_count = message_count + 1
    WHERE id = ?
  `),

  // --- присутствие ---
  sit: db.prepare(`
    INSERT INTO presence (user_id, topic_id, last_seen)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id, topic_id) DO UPDATE SET last_seen = unixepoch()
  `),
  leave: db.prepare(`
    DELETE FROM presence WHERE user_id = ? AND topic_id = ?
  `),
  leaveAll: db.prepare(`
    DELETE FROM presence WHERE user_id = ?
  `),
  listPresence: db.prepare(`
    SELECT u.id, u.display_name FROM presence p
    JOIN users u ON u.id = p.user_id
    WHERE p.topic_id = ? AND p.last_seen > unixepoch() - 40
    ORDER BY p.joined_at ASC
  `),
  countPresence: db.prepare(`
    SELECT COUNT(*) AS n FROM presence
    WHERE topic_id = ? AND last_seen > unixepoch() - 40
  `),
  cleanupStalePresence: db.prepare(`
    DELETE FROM presence WHERE last_seen < unixepoch() - 70
  `),

  // --- сообщения ---
  insertMessage: db.prepare(`
    INSERT INTO messages (topic_id, user_id, display_name, text, kind)
    VALUES (?, ?, ?, ?, ?)
  `),
  getMessage: db.prepare(`
    SELECT m.*, u.id AS author_id FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.id = ?
  `),
  recentMessages: db.prepare(`
    SELECT * FROM messages WHERE topic_id = ?
    ORDER BY created_at DESC LIMIT ?
  `),
  messagesBefore: db.prepare(`
    SELECT * FROM messages
    WHERE topic_id = ? AND created_at < ?
    ORDER BY created_at DESC LIMIT ?
  `),
  countRecentMessages: db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE topic_id = ? AND created_at > unixepoch() - 300
  `),
  lastMessageAt: db.prepare(`
    SELECT MAX(created_at) AS t FROM messages WHERE topic_id = ?
  `),
};
