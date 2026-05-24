require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS picnic_groups (
        id           TEXT PRIMARY KEY,
        invite_code  TEXT UNIQUE NOT NULL,
        name         TEXT NOT NULL,
        tg_chat_id   BIGINT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS group_members (
        id         SERIAL PRIMARY KEY,
        group_id   TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        name       TEXT NOT NULL,
        joined_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS categories (
        id        TEXT NOT NULL,
        group_id  TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        title     TEXT NOT NULL,
        icon      TEXT NOT NULL DEFAULT '📦',
        position  INTEGER DEFAULT 0,
        PRIMARY KEY(id, group_id)
      );

      CREATE TABLE IF NOT EXISTS items (
        id          TEXT NOT NULL,
        group_id    TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        cat_id      TEXT NOT NULL,
        name        TEXT NOT NULL,
        price       NUMERIC(10,2) DEFAULT 0,
        qty         NUMERIC(10,2) DEFAULT 1,
        unit        TEXT DEFAULT 'шт',
        enabled     BOOLEAN DEFAULT TRUE,
        buyer_id    TEXT,
        buyer_name  TEXT,
        bought      BOOLEAN DEFAULT FALSE,
        source      TEXT DEFAULT 'manual',   -- 'chat' | 'manual' | 'agent'
        chat_hint   TEXT,                    -- оригинальная фраза из чата
        PRIMARY KEY(id, group_id)
      );

      -- История сообщений чата для агента
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          SERIAL PRIMARY KEY,
        group_id    TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        tg_msg_id   BIGINT,
        user_name   TEXT NOT NULL,
        text        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- Анализы агента (кэш)
      CREATE TABLE IF NOT EXISTS agent_analyses (
        id         SERIAL PRIMARY KEY,
        group_id   TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        analysis   TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_items_group ON items(group_id);
      CREATE INDEX IF NOT EXISTS idx_members_group ON group_members(group_id);
      CREATE INDEX IF NOT EXISTS idx_chat_group ON chat_messages(group_id);
      CREATE INDEX IF NOT EXISTS idx_groups_chat ON picnic_groups(tg_chat_id);
    `);

    // v4: events + event_id on items
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        group_id    TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        event_date  DATE,
        event_time  TIME,
        location    TEXT,
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE items ADD COLUMN IF NOT EXISTS event_id TEXT REFERENCES events(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_events_group ON events(group_id);
      CREATE INDEX IF NOT EXISTS idx_items_event ON items(event_id);
    `);
    console.log('✅ Миграция v4 выполнена');

    // v4.1: для каждой группы с позициями без event_id — создать дефолтное событие
    const { rows: groups } = await client.query(`
      SELECT DISTINCT g.id, g.name
      FROM picnic_groups g
      JOIN items i ON i.group_id = g.id
      WHERE i.event_id IS NULL
    `);

    for (const group of groups) {
      // Проверяем, нет ли уже события у этой группы
      const { rows: existing } = await client.query(
        'SELECT id FROM events WHERE group_id = $1 LIMIT 1',
        [group.id],
      );

      let eventId;
      if (existing.length) {
        // Событие уже есть — привяжем осиротевшие позиции к нему
        eventId = existing[0].id;
      } else {
        // Создаём дефолтное событие с именем группы
        eventId = require('crypto').randomBytes(4).toString('hex'); // 8 hex chars
        await client.query(
          `INSERT INTO events(id, group_id, name) VALUES($1, $2, $3)`,
          [eventId, group.id, group.name],
        );
      }

      // Привязываем все позиции без event_id к этому событию
      const { rowCount } = await client.query(
        'UPDATE items SET event_id = $1 WHERE group_id = $2 AND event_id IS NULL',
        [eventId, group.id],
      );
      console.log(`  ↳ Группа "${group.name}": привязано ${rowCount} позиций к событию ${eventId}`);
    }

    if (groups.length === 0) {
      console.log('  ↳ Осиротевших позиций не найдено');
    }
    console.log('✅ Миграция v4.1 выполнена');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => { console.error('❌', e.message); process.exit(1); });
