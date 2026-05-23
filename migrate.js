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
    console.log('✅ Миграция v3 выполнена');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => { console.error('❌', e.message); process.exit(1); });
