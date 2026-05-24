/**
 * bot.js — Telegram Bot
 * Слушает групповой чат, сохраняет сообщения, запускает агента с debounce.
 */
const fetch = require('node-fetch');
const { nanoid } = require('nanoid');
const { extractItems } = require('./agent');

const TG_API = () => `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

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
  const res = await tgRequest('setWebhook', {
    url: `${publicUrl}/tg-webhook`,
    allowed_updates: ['message', 'my_chat_member'],
    drop_pending_updates: true,
  });
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
      await sendMessage(chat.id,
        `🔥 <b>Пикник-бот здесь!</b>\n\n` +
        `Я буду слушать ваш чат и автоматически добавлять продукты в список покупок 🛒\n\n` +
        `Чтобы привязать чат к группе в приложении:\n` +
        `/link КОД — код виден в приложении на экране группы\n\n` +
        `/help — все команды`,
      );
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

  const validCats = new Set(['rent', 'meat', 'grill', 'food', 'drinks', 'extra']);
  let addedCount = 0;

  for (const item of extracted) {
    const existing = await pool.query(
      `SELECT id FROM items WHERE group_id=$1 AND LOWER(name) LIKE LOWER($2)`,
      [groupId, `%${item.name.substring(0, 8)}%`],
    );
    if (existing.rows.length) continue;

    const catId = validCats.has(item.cat) ? item.cat : 'extra';
    const id = nanoid(8);

    await pool.query(`
      INSERT INTO items(id,group_id,cat_id,name,price,qty,unit,source,chat_hint)
      VALUES($1,$2,$3,$4,$5,$6,$7,'chat',$8)
    `, [id, groupId, catId, item.name, item.price || 0, item.qty || 1, item.unit || 'шт', item.hint || '']);

    addedCount++;
  }

  if (addedCount > 0) {
    const state = await getFullState(groupId, pool);
    broadcast(groupId, { type: 'state', state });
    broadcast(groupId, { type: 'agent_notify', message: `🤖 Агент добавил ${addedCount} позиций из чата` });
    await sendMessage(chatId,
      `🤖 Добавил в список ${addedCount} позиций из вашего обсуждения.\nОткройте приложение чтобы проверить!`,
    );
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function handleCommand(text, chatId, msg, pool, broadcast) {
  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase().split('@')[0];

  if (cmd === '/link') {
    const code = parts[1]?.toUpperCase();
    if (!code) { await sendMessage(chatId, '❌ Укажите код группы: /link XXXXXX'); return; }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE invite_code=$1', [code]);
    if (!grp.rows.length) { await sendMessage(chatId, `❌ Группа с кодом <b>${code}</b> не найдена`); return; }
    await pool.query('UPDATE picnic_groups SET tg_chat_id=$1 WHERE invite_code=$2', [chatId, code]);
    await sendMessage(chatId,
      `✅ Чат привязан к группе <b>${grp.rows[0].name}</b>!\n\nТеперь я буду слушать обсуждение и автоматически добавлять продукты в список 🎉`,
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
    const list = items.rows.map(i => `• ${i.name} — ${parseFloat(i.qty)} ${i.unit}`).join('\n');
    await sendMessage(chatId, `📋 <b>${grp.rows[0].name}</b>\n\n${list}`);
    return;
  }

  if (cmd === '/open') {
    const grp = await pool.query('SELECT name FROM picnic_groups WHERE tg_chat_id=$1', [chatId]);
    const appUrl = process.env.PUBLIC_URL || 'https://bbq.teaspv.pro:8443';
    const groupName = grp.rows[0]?.name || 'Пикник';
    await sendMessage(chatId,
      `🔥 <b>${groupName}</b>\n\nОткройте приложение чтобы управлять списком:`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📋 Открыть список', web_app: { url: appUrl } }
          ]]
        }
      }
    );
    return;
  }

  if (cmd === '/help' || cmd === '/start') {
    await sendMessage(chatId,
      `🔥 <b>Пикник-бот</b>\n\n` +
      `Я слушаю ваш чат и автоматически составляю список покупок!\n\n` +
      `<b>Команды:</b>\n` +
      `/link КОД — привязать чат к группе в приложении\n` +
      `/open — открыть приложение\n` +
      `/status — показать текущий список\n` +
      `/help — эта справка`,
    );
  }
}

// ── Internal helper (mirrors server.js getFullState to avoid circular import) ─

async function getFullState(groupId, pool) {
  const [grp, members, cats, items] = await Promise.all([
    pool.query('SELECT * FROM picnic_groups WHERE id=$1', [groupId]),
    pool.query('SELECT * FROM group_members WHERE group_id=$1 ORDER BY joined_at', [groupId]),
    pool.query('SELECT * FROM categories WHERE group_id=$1 ORDER BY position', [groupId]),
    pool.query('SELECT * FROM items WHERE group_id=$1', [groupId]),
  ]);
  return { group: grp.rows[0], members: members.rows, categories: cats.rows, items: items.rows };
}

module.exports = { handleUpdate, setWebhook, sendMessage };
