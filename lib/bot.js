/**
 * bot.js — Telegram Bot
 * Слушает групповой чат, сохраняет сообщения, запускает агента с debounce.
 */
const fetch = require('node-fetch');
const { nanoid } = require('nanoid');
const { extractItems } = require('./agent');
const { getFullState } = require('./db');
const { logActivity } = require('./activity');
const { escapeHtml } = require('./html');
const {
  ensureTelegramGroupReady,
  formatGroupReadyMessage,
  defaultEventName,
} = require('./telegram-group-bootstrap');

const TG_API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// Публичный адрес мини-приложения — единая точка правды для всех inline-кнопок web_app.
const APP_URL = process.env.PUBLIC_URL || 'https://bbq.teaspv.pro:8443';

// Базовые категории, которыми пользуется агент. Источник названий/иконок:
// item.cat_id, который вернул агент, должен совпасть с id категории в группе.
const BASE_CATEGORIES = {
  rent:   { title: 'Аренда и место', icon: '🏠' },
  meat:   { title: 'Мясо',           icon: '🥩' },
  grill:  { title: 'Мангал',         icon: '🔥' },
  food:   { title: 'Еда',            icon: '🍽️' },
  drinks: { title: 'Напитки',        icon: '🥤' },
  extra:  { title: 'Разное',         icon: '📦' },
};

/** groupId → NodeJS.Timeout */
const pendingByChat = new Map();
const DEBOUNCE_MS = 10_000;

// ── Telegram API helpers ─────────────────────────────────────────────────────

async function tgRequest(method, body) {
  try {
    const res = await fetch(`${TG_API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (e) {
    console.error(`tgRequest ${method}:`, e.message);
    return null;
  }
}

function sendMessage(chatId, text, opts = {}) {
  return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
}

async function setWebhook(publicUrl) {
  const payload = {
    url: `${publicUrl}/tg-webhook`,
    allowed_updates: ['message', 'my_chat_member'],
    drop_pending_updates: true,
  };
  if (process.env.TG_WEBHOOK_SECRET) {
    payload.secret_token = process.env.TG_WEBHOOK_SECRET;
  }
  const res = await tgRequest('setWebhook', payload);
  console.log('🤖 Webhook set:', res?.description || res);
  return res;
}

// ── Update handler ───────────────────────────────────────────────────────────

async function handleUpdate(update, pool, broadcast) {
  // Бот добавлен в группу
  if (update.my_chat_member) {
    const { chat, new_chat_member, old_chat_member } = update.my_chat_member;
    const wasOut = ['left', 'kicked'].includes(old_chat_member?.status);
    const isIn   = ['member', 'administrator'].includes(new_chat_member?.status);
    if (wasOut && isIn && chat.type !== 'private') {
      const existing = await pool.query(
        'SELECT id, name FROM picnic_groups WHERE tg_chat_id=$1',
        [chat.id],
      );
      if (!existing.rows.length) {
        await sendTelegramGroupReady(pool, broadcast, {
          chatId: chat.id,
          chatTitle: chat.title,
          addedBy: update.my_chat_member.from,
        });
      }
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId   = msg.chat.id;
  const text     = msg.text.trim();
  const userName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || msg.from?.username || 'Участник';

  if (text.startsWith('/')) {
    await handleCommand(text, chatId, msg, pool, broadcast);
    return;
  }

  const grpRow = await pool.query('SELECT id FROM picnic_groups WHERE tg_chat_id=$1', [chatId]);
  if (!grpRow.rows.length) return;

  const groupId = grpRow.rows[0].id;

  await pool.query(
    'INSERT INTO chat_messages(group_id,tg_msg_id,user_name,text) VALUES($1,$2,$3,$4)',
    [groupId, msg.message_id, userName, text],
  );

  scheduleParse(groupId, chatId, pool, broadcast);
}

function scheduleParse(groupId, chatId, pool, broadcast) {
  if (pendingByChat.has(groupId)) clearTimeout(pendingByChat.get(groupId));
  pendingByChat.set(groupId, setTimeout(async () => {
    pendingByChat.delete(groupId);
    await parseRecentMessages(groupId, chatId, pool, broadcast);
  }, DEBOUNCE_MS));
}

async function parseRecentMessages(groupId, chatId, pool, broadcast) {
  const msgsRes = await pool.query(`
    SELECT user_name, text FROM chat_messages
    WHERE group_id=$1 ORDER BY created_at DESC LIMIT 50
  `, [groupId]);

  const messages = msgsRes.rows.reverse();
  if (!messages.length) return;

  console.log(`🤖 Agent parsing ${messages.length} messages for group ${groupId}`);

  let extracted;
  try { extracted = await extractItems(messages); }
  catch (e) { console.error('extractItems failed:', e.message); return; }
  if (!extracted.length) return;

  // Дедуп делаем в памяти по одному снимку имён — вместо LIKE-запроса на каждую позицию.
  const namesRes = await pool.query('SELECT name FROM items WHERE group_id=$1', [groupId]);
  const existingNames = namesRes.rows.map(r => r.name);

  // Ближайшее будущее событие группы одно на весь батч (если есть)
  const evtRes = await pool.query(
    `SELECT id FROM events WHERE group_id=$1 AND (event_date >= CURRENT_DATE OR event_date IS NULL)
     ORDER BY event_date ASC NULLS LAST, created_at ASC LIMIT 1`,
    [groupId],
  );
  const eventId = evtRes.rows[0]?.id || null;

  // 1) Отсеиваем дубли и раскладываем по базовым категориям
  const fresh = [];
  for (const item of extracted) {
    if (isDuplicateName(existingNames, item.name)) continue;
    existingNames.push(item.name); // чтобы не продублировать внутри самого батча
    fresh.push({ item, cat: resolveCatId(item.cat) });
  }
  if (!fresh.length) return;

  // 2) Гарантируем наличие категорий (по одной на уникальную), иначе позиции «повиснут» вне секций UI
  const catIdByCat = new Map();
  for (const cat of new Set(fresh.map(f => f.cat))) {
    catIdByCat.set(cat, await ensureCategory(pool, groupId, cat));
  }

  // 3) Один multi-row INSERT на весь батч
  const params = [];
  const tuples = fresh.map(({ item, cat }) => {
    const base = params.length;
    params.push(
      nanoid(8), groupId, catIdByCat.get(cat), item.name,
      item.price || 0, item.qty || 1, item.unit || 'шт', item.hint || '', eventId,
    );
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},'chat',$${base + 8},$${base + 9})`;
  });
  await pool.query(
    `INSERT INTO items(id,group_id,cat_id,name,price,qty,unit,source,chat_hint,event_id) VALUES${tuples.join(',')}`,
    params,
  );

  const addedCount = fresh.length;
  await logActivity(pool, {
    groupId, type: 'agent:added', actorName: 'Агент', data: { count: addedCount },
  });
  const state = await getFullState(groupId);
  broadcast(groupId, { type: 'state', state });
  broadcast(groupId, { type: 'agent_notify', message: `🤖 Агент добавил ${addedCount} позиций из чата` });
  await sendMessage(chatId,
    `🤖 Добавил в список ${addedCount} позиций из вашего обсуждения.\nОткройте приложение чтобы проверить!`,
  );
}

// ── Группа в приложении (добавление бота / /start в группе) ───────────────────

async function sendTelegramGroupReady(pool, broadcast, { chatId, chatTitle, addedBy }) {
  const ready = await ensureTelegramGroupReady(pool, broadcast, { chatId, chatTitle, addedBy });
  await sendMessage(chatId, formatGroupReadyMessage(ready), {
    reply_markup: {
      inline_keyboard: [[
        { text: '📋 Открыть приложение', web_app: { url: APP_URL } },
      ]],
    },
  });
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function handleCommand(text, chatId, msg, pool, broadcast) {
  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase().split('@')[0];

  if (cmd === '/link') {
    const code = parts[1]?.toUpperCase();
    if (!code) { await sendMessage(chatId, '❌ Укажите код группы: /link XXXXXX'); return; }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE invite_code=$1', [code]);
    if (!grp.rows.length) { await sendMessage(chatId, `❌ Группа с кодом <b>${escapeHtml(code)}</b> не найдена`); return; }
    await pool.query('UPDATE picnic_groups SET tg_chat_id=$1 WHERE invite_code=$2', [chatId, code]);
    await sendMessage(chatId,
      `✅ Чат привязан к группе <b>${escapeHtml(grp.rows[0].name)}</b>!\n\nТеперь я буду слушать обсуждение и автоматически добавлять продукты в список 🎉`,
    );
    return;
  }

  if (cmd === '/status') {
    const grp = await pool.query('SELECT id,name FROM picnic_groups WHERE tg_chat_id=$1', [chatId]);
    if (!grp.rows.length) { await sendMessage(chatId, '❌ Этот чат не привязан к группе. Используйте /link КОД'); return; }
    const items = await pool.query(
      'SELECT name,qty,unit FROM items WHERE group_id=$1 AND enabled=true ORDER BY cat_id',
      [grp.rows[0].id],
    );
    if (!items.rows.length) { await sendMessage(chatId, '📋 Список пока пуст'); return; }
    const list = items.rows.map(i => `• ${escapeHtml(i.name)} — ${parseFloat(i.qty)} ${escapeHtml(i.unit)}`).join('\n');
    await sendMessage(chatId, `📋 <b>${escapeHtml(grp.rows[0].name)}</b>\n\n${list}`);
    return;
  }

  if (cmd === '/open') {
    const grp = await pool.query('SELECT name FROM picnic_groups WHERE tg_chat_id=$1', [chatId]);
    const groupName = grp.rows[0]?.name || 'Пикник';
    await sendMessage(chatId,
      `🔥 <b>${escapeHtml(groupName)}</b>\n\nОткройте приложение чтобы управлять списком:`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📋 Открыть список', web_app: { url: APP_URL } }
          ]]
        }
      }
    );
    return;
  }

  if (cmd === '/start') {
    const chatType = msg.chat?.type;
    if (chatType === 'group' || chatType === 'supergroup') {
      await sendTelegramGroupReady(pool, broadcast, {
        chatId,
        chatTitle: msg.chat?.title,
        addedBy: msg.from,
      });
      return;
    }
    await sendMessage(chatId,
      `🔥 <b>Планер</b>\n\n` +
      `Добавьте меня в <b>групповой чат</b> — создам группу и событие в приложении автоматически.\n\n` +
      `Или в группе напишите /start\n\n` +
      `<b>Команды в группе:</b>\n` +
      `/link КОД — привязать к уже созданной группе\n` +
      `/open — открыть приложение\n` +
      `/status — список покупок\n` +
      `/help — справка`,
    );
    return;
  }

  if (cmd === '/help') {
    await sendMessage(chatId,
      `🔥 <b>Планер</b>\n\n` +
      `Я слушаю групповой чат и составляю список покупок.\n\n` +
      `<b>Команды:</b>\n` +
      `/start — создать или открыть группу в приложении (в групповом чате)\n` +
      `/link КОД — привязать чат к группе из приложения\n` +
      `/open — открыть приложение\n` +
      `/status — текущий список\n` +
      `/help — эта справка`,
    );
  }
}

/** Разрешает cat в один из допустимых идентификаторов; неизвестные → 'extra'. Экспортируется для тестов. */
const VALID_CATS = new Set(Object.keys(BASE_CATEGORIES));
function resolveCatId(cat) {
  return VALID_CATS.has(cat) ? cat : 'extra';
}

/**
 * Идемпотентно гарантирует наличие базовой категории в группе.
 * Если категория с таким id уже есть (или есть категория с тем же названием) — переиспользуем её id,
 * не плодя дублей. Возвращает id категории, который следует записать в item.cat_id.
 * @param {{ query: Function }} pool
 * @param {string} groupId
 * @param {string} catId — один из ключей BASE_CATEGORIES
 * @returns {Promise<string>}
 */
async function ensureCategory(pool, groupId, catId) {
  const meta = BASE_CATEGORIES[catId] || BASE_CATEGORIES.extra;
  const existing = await pool.query(
    'SELECT id FROM categories WHERE group_id=$1 AND (id=$2 OR LOWER(title)=LOWER($3)) LIMIT 1',
    [groupId, catId, meta.title],
  );
  if (existing.rows.length) return existing.rows[0].id;
  const pos = await pool.query(
    'SELECT COALESCE(MAX(position),0)+1 AS p FROM categories WHERE group_id=$1',
    [groupId],
  );
  await pool.query(
    'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
    [catId, groupId, meta.title, meta.icon, pos.rows[0].p],
  );
  return catId;
}

/**
 * Имя дедуплицируется по первым 8 символам (без учёта регистра).
 * Возвращает true если совпадение найдено.
 * Экспортируется для тестов.
 */
function isDuplicateName(existingNames, newName) {
  const prefix = newName.substring(0, 8).toLowerCase();
  return existingNames.some(n => n.toLowerCase().includes(prefix));
}

module.exports = {
  handleUpdate,
  setWebhook,
  sendMessage,
  resolveCatId,
  isDuplicateName,
  defaultEventName,
  ensureTelegramGroupReady,
  formatGroupReadyMessage,
};
