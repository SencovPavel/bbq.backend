/**
 * MAX Messenger Bot
 * API: https://platform-api.max.ru
 * Docs: https://dev.max.ru/docs-api
 */
require('dotenv').config();
const { pool } = require('./db');
const { broadcast } = require('./ws');

const TOKEN    = process.env.MAX_TOKEN;
const BASE_URL = 'https://platform-api.max.ru';
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!TOKEN) {
  console.warn('⚠️  MAX_TOKEN не задан — MAX бот отключён');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function api(method, path, body = null) {
  if (!TOKEN) return null;
  const opts = {
    method,
    headers: {
      Authorization: TOKEN,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MAX API ${res.status} ${path}: ${txt}`);
  }
  return res.json().catch(() => null);
}

// ── Messaging ─────────────────────────────────────────────────────────────────

/**
 * Отправить сообщение в чат или пользователю.
 * @param {number|string} chatId
 * @param {string} text HTML-текст
 * @param {Array}  attachments  (кнопки и т.п.)
 */
async function sendMessage(chatId, text, attachments = []) {
  const params = new URLSearchParams({ chat_id: String(chatId) });
  return api('POST', `/messages?${params}`, {
    text,
    format: 'html',
    ...(attachments.length ? { attachments } : {}),
  });
}

/** Кнопка «Открыть приложение» */
function appButton(label = 'Открыть приложение') {
  if (!PUBLIC_URL) return [];
  return [{
    type: 'inline_keyboard',
    payload: {
      buttons: [[{
        type: 'url',
        text: label,
        url: PUBLIC_URL,
      }]],
    },
  }];
}

// ── Webhook ───────────────────────────────────────────────────────────────────

async function setWebhook() {
  if (!TOKEN) return;
  if (!PUBLIC_URL) {
    console.warn('MAX: PUBLIC_URL не задан, webhook не зарегистрирован');
    return;
  }
  const webhookUrl = `${PUBLIC_URL}/max-webhook`;
  try {
    const payload = {
      url: webhookUrl,
      update_types: ['message_created', 'bot_added', 'bot_started'],
    };
    if (process.env.MAX_WEBHOOK_SECRET) {
      payload.secret = process.env.MAX_WEBHOOK_SECRET;
    }
    await api('POST', '/subscriptions', payload);
    console.log(`✅ MAX webhook: ${webhookUrl}`);
  } catch (e) {
    console.error('❌ MAX webhook:', e.message);
  }
}

// ── Update handler ────────────────────────────────────────────────────────────

async function handleUpdate(update) {
  if (!update?.update_type) return;
  const type   = update.update_type;
  const chatId = update.chat_id ?? update.message?.recipient?.chat_id;

  // ── Бот добавлен в групповой чат ─────────────────────────────────────────
  if (type === 'bot_added') {
    await sendMessage(chatId,
      `🔥 <b>Пикник-бот здесь!</b>\n\nПривет! Я помогаю планировать пикники: слежу за списком покупок, считаю траты и напоминаю что забыли.\n\nОткрой приложение и создай группу — друзья присоединятся по коду.`,
      appButton()
    );
    return;
  }

  // ── Пользователь открыл личный диалог ────────────────────────────────────
  if (type === 'bot_started') {
    const firstName = update.user?.first_name ?? 'друг';
    await sendMessage(chatId,
      `👋 Привет, ${firstName}!\n\nЯ помогаю организовывать пикники и вечеринки — веду список покупок для всей компании, делю траты и слежу чтобы ничего не забыли.\n\nНажми кнопку ниже чтобы начать 👇`,
      appButton('Открыть Пикник')
    );
    return;
  }

  // ── Входящее сообщение ────────────────────────────────────────────────────
  if (type === 'message_created') {
    const text     = update.message?.body?.text ?? '';
    const userId   = update.user?.user_id;
    const userName = update.user?.first_name ?? 'Участник';

    if (!text || !chatId) return;

    // Сохраняем историю чата для агента (если группа привязана)
    const { rows } = await pool.query(
      'SELECT id FROM picnic_groups WHERE max_chat_id=$1',
      [String(chatId)],
    );
    if (!rows.length) return;

    const groupId = rows[0].id;
    await pool.query(
      'INSERT INTO chat_messages(group_id,user_name,text) VALUES($1,$2,$3)',
      [groupId, userName, text],
    );
    return;
  }
}

module.exports = { setWebhook, handleUpdate, sendMessage };
