// scripts/migrate-to-topics.js
// Запуск: node scripts/migrate-to-topics.js
//
// Что делает:
// 1. Для каждой поляны создаёт тему:
//    - для 'common' — служебную (title = NULL)
//    - для остальных — 'Архив' (title = 'Архив')
// 2. Привязывает все существующие messages к теме соответствующей поляны.
// 3. Пересоздаёт таблицу messages без glade_id, но с topic_id.

import Database from 'better-sqlite3';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import 'dotenv/config';

const DB_PATH = process.env.DB_PATH || './data/koster.db';

// === Бэкап ===
const backupPath = DB_PATH + '.backup-' + Date.now();
if (existsSync(DB_PATH)) {
  copyFileSync(DB_PATH, backupPath);
  console.log('💾 Бэкап:', backupPath);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');  // ← отключаем на время миграции
// === Создаём таблицу topics, если её нет ===
db.exec(`
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
`);

console.log('🔥 Миграция к темам...\n');

// === 1. Проверим, есть ли уже topic_id ===
const columns = db.prepare("PRAGMA table_info(messages)").all();
const hasTopicId = columns.some(c => c.name === 'topic_id');

if (hasTopicId) {
  console.log('⚠️  Поле topic_id уже есть. Миграция, похоже, уже выполнена.');
  console.log('   Выходим без изменений.');
  process.exit(0);
}

// === 2. Создаём темы для каждой поляны ===
const glades = db.prepare('SELECT * FROM glades').all();

const insertTopic = db.prepare(`
  INSERT INTO topics (glade_id, title, created_at)
  VALUES (?, ?, ?)
`);

const gladeToTopic = {};  // glade_id -> topic_id

for (const g of glades) {
  const title = g.slug === 'common' ? null : 'Архив';
  const info = insertTopic.run(g.id, title, Math.floor(Date.now() / 1000));
  gladeToTopic[g.id] = info.lastInsertRowid;
  console.log(`  📌 ${g.title} → тема "${title || '(служебная)'}" (id=${info.lastInsertRowid})`);
}

console.log('');

// === 3. Пересоздаём таблицу messages ===
console.log('🔄 Пересоздаю messages...');

db.exec(`
  CREATE TABLE messages_new (
    id           INTEGER PRIMARY KEY,
    topic_id     INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    text         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'normal',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    score        INTEGER NOT NULL DEFAULT 0
  );
`);

// Копируем данные, подставляя topic_id по glade_id
const oldMessages = db.prepare('SELECT * FROM messages').all();
const insertNew = db.prepare(`
  INSERT INTO messages_new (id, topic_id, user_id, display_name, text, kind, created_at, score)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const tx = db.transaction((messages) => {
  for (const m of messages) {
    const topicId = gladeToTopic[m.glade_id];
    if (!topicId) {
      console.warn(`  ⚠️  Реплика ${m.id} — нет темы для glade_id=${m.glade_id}. Пропускаем.`);
      continue;
    }
    insertNew.run(m.id, topicId, m.user_id, m.display_name, m.text, m.kind, m.created_at, m.score);
  }
});

tx(oldMessages);
console.log(`  ✅ Перенесено реплик: ${oldMessages.length}`);

// Удаляем старую, переименовываем новую
db.exec(`DROP TABLE messages;`);
db.exec(`ALTER TABLE messages_new RENAME TO messages;`);

// Индексы
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_topic
    ON messages(topic_id, created_at DESC);
`);

// === 4. Пересчитываем счётчики тем ===
console.log('📊 Пересчитываю счётчики тем...');

const topics = db.prepare('SELECT * FROM topics').all();
const countMessages = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE topic_id = ?');
const updateTopic = db.prepare('UPDATE topics SET message_count = ?, last_message_at = ? WHERE id = ?');

for (const t of topics) {
  const r = countMessages.get(t.id);
  updateTopic.run(r.n, r.last, t.id);
}

console.log('');

// === 5. Включаем foreign_keys обратно ===
db.pragma('foreign_keys = ON');

console.log('✅ Миграция завершена.\n');
console.log('   Проверь:');
console.log('   - Темы созданы: SELECT * FROM topics;');
console.log('   - Реплики привязаны: SELECT topic_id, COUNT(*) FROM messages GROUP BY topic_id;');
console.log('');
console.log(`   Бэкап: ${backupPath}`);
