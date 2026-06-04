require('dotenv').config();
const { Pool } = require('pg');
const { normalizeEventStatusPerGroup } = require('./lib/migrate-event-status');
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

    // v5: admin roles
    await client.query(`
      ALTER TABLE group_members ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    // Назначаем первого вступившего в каждую группу администратором (если нет ни одного)
    await client.query(`
      UPDATE group_members gm
      SET is_admin = TRUE
      FROM (
        SELECT DISTINCT ON (group_id) group_id, user_id
        FROM group_members
        ORDER BY group_id, joined_at ASC
      ) first_member
      WHERE gm.group_id = first_member.group_id
        AND gm.user_id  = first_member.user_id
        AND NOT EXISTS (
          SELECT 1 FROM group_members
          WHERE group_id = gm.group_id AND is_admin = TRUE
        );
    `);
    console.log('✅ Миграция v5 (admin roles) выполнена');

    // v6: MAX Messenger support
    await client.query(`
      ALTER TABLE picnic_groups ADD COLUMN IF NOT EXISTS max_chat_id BIGINT;
      CREATE INDEX IF NOT EXISTS idx_groups_max ON picnic_groups(max_chat_id);
    `);
    console.log('✅ Миграция v6 (MAX messenger) выполнена');

    // v7: web auth (email + password)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
    `);
    console.log('✅ Миграция v7 (web auth) выполнена');

    // v7.1: OAuth accounts + make password_hash nullable
    await client.query(`
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS oauth_accounts (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider    TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        email       TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(provider, provider_id)
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);
    `);
    console.log('✅ Миграция v7.1 (OAuth accounts) выполнена');

    // v8: event status
    await client.query(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    `);
    console.log('✅ Миграция v8 (event status) выполнена');

    // v9: group activity log
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_activity (
        id         SERIAL PRIMARY KEY,
        group_id   TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        event_id   TEXT REFERENCES events(id) ON DELETE SET NULL,
        type       TEXT NOT NULL,
        actor_name TEXT,
        data       JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_group ON group_activity(group_id, created_at DESC);
    `);
    console.log('✅ Миграция v9 (group activity) выполнена');

    // v10: нормализация status в events (группы picnic_groups не затрагиваются)
    const { activeEvents } = await normalizeEventStatusPerGroup(client);
    if (activeEvents.length === 0) {
      console.log('  ↳ Событий для нормализации статуса не найдено');
    } else {
      for (const evt of activeEvents) {
        console.log(`  ↳ Событие «${evt.name}» (${evt.id}) → active, остальные в группе ${evt.group_id} → completed`);
      }
    }
    console.log(`✅ Миграция v10 (статусы событий): ${activeEvents.length} активных событий`);

    // v11: event RSVP — отметка явки участника на событие
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_rsvp (
        event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        attending   BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (event_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rsvp_event ON event_rsvp(event_id);
    `);
    console.log('✅ Миграция v11 (event RSVP) выполнена');

    // v12: family members — «Семья» привязана к аккаунту, не к группе
    await client.query(`
      CREATE TABLE IF NOT EXISTS family_members (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        label       TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS family_member_rsvp (
        family_member_id  TEXT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
        event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        attending         BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (family_member_id, event_id)
      );

      CREATE TABLE IF NOT EXISTS family_group_settings (
        family_member_id  TEXT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
        group_id          TEXT NOT NULL REFERENCES picnic_groups(id) ON DELETE CASCADE,
        include_in_calc   BOOLEAN NOT NULL DEFAULT TRUE,
        cost_pct          INTEGER NOT NULL DEFAULT 100
                          CHECK (cost_pct BETWEEN 0 AND 200),
        PRIMARY KEY (family_member_id, group_id)
      );

      CREATE INDEX IF NOT EXISTS idx_family_owner   ON family_members(owner_id);
      CREATE INDEX IF NOT EXISTS idx_family_rsvp    ON family_member_rsvp(event_id);
      CREATE INDEX IF NOT EXISTS idx_family_grp_set ON family_group_settings(group_id);
    `);
    console.log('✅ Миграция v12 (family members) выполнена');

    // v13: is_superadmin + analytics_events
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS analytics_events (
        id         SERIAL PRIMARY KEY,
        type       TEXT NOT NULL,
        user_id    TEXT,
        group_id   TEXT,
        platform   TEXT,
        meta       JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_type_ts  ON analytics_events(type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_ts       ON analytics_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_group    ON analytics_events(group_id) WHERE group_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_analytics_user     ON analytics_events(user_id)  WHERE user_id  IS NOT NULL;
    `);
    console.log('✅ Миграция v13 (analytics_events + is_superadmin) выполнена');

    // v14: bio поле профиля
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
    `);
    console.log('✅ Миграция v14 (users.bio) выполнена');

    // v15: эмодзи-иконка группы
    await client.query(`
      ALTER TABLE picnic_groups ADD COLUMN IF NOT EXISTS emoji TEXT;
    `);
    console.log('✅ Миграция v15 (groups.emoji) выполнена');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => { console.error('❌', e.message); process.exit(1); });
