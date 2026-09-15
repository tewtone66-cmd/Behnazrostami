const https = require('https');
const fs = require('fs');
const path = require('path');

const COURSE_TITLE = process.env.COURSE_TITLE || 'مافیای استوری اینستاگرام';
const COURSE_PRICE = process.env.COURSE_PRICE || 'قیمت تستی';
const PAYMENT_URL = process.env.PAYMENT_URL || '';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'Senpaizuto').replace(/^@/, '').toLowerCase();
const token = process.env.BOT_TOKEN;

if (!token) {
  console.log('[telegram] BOT_TOKEN is not set; Telegram bot is disabled.');
  module.exports = null;
} else {
  const API = `https://api.telegram.org/bot${token}`;
  const storageDir = path.join(__dirname, 'storage');
  const stateFile = path.join(storageDir, 'telegram-bot-state.json');

  let offset = 0;
  let stopped = false;
  let adminChatId = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
  let receiptsEnabled = true;
  let botEnabled = true;
  let waitingForLink = null;
  const waitingForUserId = new Set();
  const waitingForSupport = new Set();
  const waitingForAdminReply = new Map();
  const waitingForUserReply = new Map();
  const pendingReceipts = new Map();
  const users = new Map();
  const supportTickets = new Map();
  const offlineQueue = [];

  function loadState() {
    try {
      if (!fs.existsSync(stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      offset = Number(raw.offset || 0);
      adminChatId = raw.adminChatId || adminChatId;
      receiptsEnabled = raw.receiptsEnabled !== false;
      botEnabled = raw.botEnabled !== false;
      waitingForLink = raw.waitingForLink || null;
      for (const u of raw.users || []) users.set(String(u.userId), u);
      for (const r of raw.pendingReceipts || []) pendingReceipts.set(String(r.id), r);
      for (const t of raw.supportTickets || []) supportTickets.set(String(t.id), t);
    } catch (err) {
      console.error('[telegram] state load failed:', err.message);
    }
  }

  function saveState() {
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      const data = {
        offset,
        adminChatId,
        receiptsEnabled,
        botEnabled,
        waitingForLink,
        users: [...users.values()],
        pendingReceipts: [...pendingReceipts.values()],
        supportTickets: [...supportTickets.values()]
      };
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      console.error('[telegram] state save failed:', err.message);
    }
  }

  function telegram(method, body = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${API}/${method}`);
      const payload = JSON.stringify(body);
      const request = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        family: 4,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: 35000
      }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', c => data += c);
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) return reject(new Error(parsed.description || `Telegram API error: ${method}`));
            resolve(parsed.result);
          } catch {
            reject(new Error(`Invalid Telegram response (${response.statusCode})`));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Telegram request timed out')));
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
  }

  const send = (chatId, text, extra = {}) => telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
  const sendPhoto = (chatId, photo, caption, extra = {}) => telegram('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });
  const sendDocument = (chatId, document, caption, extra = {}) => telegram('sendDocument', { chat_id: chatId, document, caption, parse_mode: 'HTML', ...extra });
  const copyMessage = (chatId, fromChatId, messageId, extra = {}) => telegram('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...extra });

  const name = u => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || 'بدون نام';
  const username = u => u?.username ? `@${u.username}` : 'ندارد';
  const safe = s => String(s || '').replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
  const isAdmin = u => Boolean((adminChatId && String(u?.id) === adminChatId) || String(u?.username || '').toLowerCase() === ADMIN_USERNAME);

  const backKeyboard = () => ({ inline_keyboard: [[{ text: '↩️ برگشت به منوی اصلی', callback_data: 'menu' }]] });
  const mainKeyboard = () => ({ inline_keyboard: [
    [{ text: '🎓 معرفی دوره', callback_data: 'course' }],
    [{ text: '📚 سرفصل‌ها', callback_data: 'syllabus' }, { text: '🎁 نمونه رایگان', callback_data: 'sample' }],
    [{ text: '💰 خرید دوره', callback_data: 'buy' }],
    [{ text: '💬 پشتیبانی', callback_data: 'support' }]
  ]});
  const receiptKeyboard = id => ({ inline_keyboard: [
    [{ text: '👤 اطلاعات کاربر', callback_data: `info:${id}` }],
    [{ text: '✅ تایید رسید', callback_data: `approve:${id}` }, { text: '❌ رد رسید', callback_data: `reject:${id}` }],
    [{ text: '🔗 ارسال لینک', callback_data: `link:${id}` }]
  ]});
  const adminKeyboard = () => ({ inline_keyboard: [
    [{ text: receiptsEnabled ? '🟢 دریافت رسید: روشن' : '🔴 دریافت رسید: خاموش', callback_data: 'toggle_receipts' }],
    [{ text: botEnabled ? '🟢 بات: روشن' : '🔴 بات: خاموش', callback_data: 'toggle_bot' }],
    [{ text: '📥 دریافت رسیدهای جدید', callback_data: 'pending_receipts' }],
    [{ text: '💬 پشتیبانی', callback_data: 'support_admin' }],
    [{ text: '👥 مدیریت کاربران', callback_data: 'user_lookup' }],
    [{ text: '🆔 آیدی مدیر', callback_data: 'owner_id' }],
    [{ text: '📊 وضعیت پنل', callback_data: 'admin_status' }]
  ]});
  const userKeyboard = userId => ({ inline_keyboard: [
    [{ text: '👤 اطلاعات کاربر', callback_data: `user_info:${userId}` }],
    [{ text: '🟢 اعطای دسترسی', callback_data: `grant:${userId}` }, { text: '🔴 لغو دسترسی', callback_data: `revoke:${userId}` }],
    [{ text: '📥 رسیدهای این کاربر', callback_data: `user_receipts:${userId}` }],
    [{ text: '🔗 ارسال لینک', callback_data: `user_link:${userId}` }]
  ]});
  const userSupportReplyKeyboard = ticketId => ({ inline_keyboard: [[{ text: '↩️ پاسخ به پشتیبانی', callback_data: `support_user_reply:${ticketId}` }]] });
  const adminSupportReplyKeyboard = ticketId => ({ inline_keyboard: [[{ text: '↩️ پاسخ', callback_data: `support_reply:${ticketId}` }]] });

  function receiptCaption(u, prefix = '📥 رسید پرداخت جدید') {
    return `<b>${prefix}</b>\n\n🎓 دوره: ${safe(COURSE_TITLE)}\n💰 مبلغ: ${safe(COURSE_PRICE)}\n👤 نام: ${safe(name(u))}\n🔹 یوزرنیم: ${safe(username(u))}\n🆔 Telegram ID: <code>${safe(u.id)}</code>\n🕐 زمان: ${new Date().toLocaleString('fa-IR')}`;
  }

  function receiptIdParts(id) {
    const match = String(id || '').match(/^(-?\d+):(\d+)$/);
    return match ? { chatId: match[1], messageId: Number(match[2]) } : null;
  }

  function getReceipt(id) {
    const existing = pendingReceipts.get(String(id));
    if (existing) return existing;
    const parts = receiptIdParts(id);
    if (!parts) return null;
    const user = { id: String(id), chatId: parts.chatId, userId: parts.chatId, name: 'کاربر رسید', username: '', sentAt: new Date().toISOString(), approved: false, rejected: false, access: false, linkSent: '', fileType: '', fileId: '' };
    pendingReceipts.set(String(id), user);
    users.set(String(user.userId), user);
    saveState();
    return user;
  }

  function getOrCreateUser(m) {
    const id = String(m.from?.id || m.chat?.id);
    let u = users.get(id);
    if (!u) u = { userId: id, chatId: String(m.chat.id), name: name(m.from), username: m.from?.username || '', access: false, approved: false, rejected: false, createdAt: new Date().toISOString() };
    else { u.chatId = String(m.chat.id); u.name = name(m.from); u.username = m.from?.username || u.username || ''; }
    users.set(id, u);
    saveState();
    return u;
  }

  async function forwardReceipt(m) {
    if (!receiptsEnabled || !adminChatId) return false;
    const id = `${m.chat.id}:${m.message_id}`;
    const u = getOrCreateUser(m.from ? m : { ...m, from: {} });
    const user = { ...u, id, chatId: String(m.chat.id), userId: String(m.from?.id || m.chat.id), sentAt: new Date().toISOString(), approved: false, rejected: false, access: false, linkSent: '', fileType: m.photo ? 'photo' : 'document', fileId: m.photo ? m.photo[m.photo.length - 1].file_id : m.document?.file_id || '' };
    pendingReceipts.set(id, user);
    users.set(user.userId, user);
    saveState();
    const extra = { reply_markup: receiptKeyboard(id) };
    if (m.photo) { await sendPhoto(adminChatId, user.fileId, receiptCaption(m.from), extra); return true; }
    if (m.document) { await sendDocument(adminChatId, user.fileId, receiptCaption(m.from), extra); return true; }
    return false;
  }

  async function sendReceiptToAdmin(chatId, r) {
    const u = { id: r.userId, first_name: r.name, username: r.username };
    const caption = receiptCaption(u, `📄 رسید #${r.id}`);
    const extra = { reply_markup: receiptKeyboard(r.id) };
    if (r.fileType === 'photo' && r.fileId) return sendPhoto(chatId, r.fileId, caption, extra);
    if (r.fileType === 'document' && r.fileId) return sendDocument(chatId, r.fileId, caption, extra);
    return send(chatId, caption, extra);
  }

  async function sendPendingReceipts(chatId) {
    const pending = [...pendingReceipts.values()].filter(r => !r.approved && !r.rejected);
    if (!pending.length) return send(chatId, '📭 هیچ رسید تاییدنشده‌ای وجود ندارد.', { reply_markup: adminKeyboard() });
    await send(chatId, `<b>📥 رسیدهای جدید</b>\n\nتعداد: <b>${pending.length}</b>`);
    for (const r of pending) await sendReceiptToAdmin(chatId, r);
  }

  async function showUser(chatId, userId) {
    const user = users.get(String(userId));
    if (!user) return send(chatId, '⚠️ کاربری با این Telegram ID در بات پیدا نشد.', { reply_markup: adminKeyboard() });
    return send(chatId, `<b>👤 مدیریت کاربر</b>\n\nنام: ${safe(user.name)}\nیوزرنیم: ${safe(user.username ? '@' + user.username : 'ندارد')}\nTelegram ID: <code>${safe(user.userId)}</code>\nChat ID: <code>${safe(user.chatId)}</code>\nدسترسی دوره: ${user.access ? '🟢 دارد' : '🔴 ندارد'}\nوضعیت پرداخت: ${user.approved ? '✅ تایید شده' : user.rejected ? '❌ رد شده' : '⏳ تایید نشده'}`, { reply_markup: userKeyboard(user.userId) });
  }

  async function startLinkFlow(chatId, userId) {
    const user = users.get(String(userId)) || getReceipt(userId);
    if (!user) return send(chatId, '⚠️ کاربر پیدا نشد.', { reply_markup: adminKeyboard() });
    if (!user.approved) return send(chatId, '⚠️ اول رسید این کاربر را تایید کنید.');
    waitingForLink = String(user.userId);
    saveState();
    return send(chatId, `📨 هر پیامی که الان بفرستید، دقیقاً برای کاربر <code>${safe(user.userId)}</code> ارسال می‌شود.\n\nمتن، لینک، عکس، فایل، ویدیو یا هر پیام دیگری قابل ارسال است.`);
  }

  function newTicketId(userId) { return `${userId}-${Date.now()}`; }

  function supportText(m) {
    if (m.text) return safe(m.text);
    if (m.caption) return safe(m.caption);
    if (m.photo) return '🖼️ عکس';
    if (m.video) return '🎥 ویدیو';
    if (m.document) return '📎 فایل';
    if (m.voice) return '🎤 پیام صوتی';
    if (m.audio) return '🎵 فایل صوتی';
    if (m.sticker) return '🩷 استیکر';
    return '📨 پیام';
  }

  async function sendSupportToAdmin(ticket, m, isReply = false) {
    if (!adminChatId) return;
    const u = m.from || {};
    const prefix = isReply ? '🔁 پاسخ جدید کاربر' : '💬 پیام جدید پشتیبانی';
    const text = `<b>${prefix}</b>\n\n👤 ${safe(name(u))}\n🔹 ${safe(username(u))}\n🆔 Telegram ID: <code>${safe(u.id || ticket.userId)}</code>\n🎫 Ticket: <code>${safe(ticket.id)}</code>\n\n${supportText(m)}\n\n<i>این پیام مربوط به همین تیکت است.</i>`;
    const extra = { reply_markup: adminSupportReplyKeyboard(ticket.id) };
    if (m.photo) return sendPhoto(adminChatId, m.photo[m.photo.length - 1].file_id, text, extra);
    if (m.document) return sendDocument(adminChatId, m.document.file_id, text, extra);
    if (m.video) return copyMessage(adminChatId, m.chat.id, m.message_id, extra);
    if (m.voice) return copyMessage(adminChatId, m.chat.id, m.message_id, extra);
    return send(adminChatId, text, extra);
  }

  async function createSupportTicket(m, isReply = false, ticketId = null) {
    const u = getOrCreateUser(m);
    let ticket = ticketId ? supportTickets.get(String(ticketId)) : null;
    if (!ticket) {
      ticket = { id: newTicketId(u.userId), userId: u.userId, chatId: String(m.chat.id), name: u.name, username: u.username, status: 'open', createdAt: new Date().toISOString(), lastUserMessageId: m.message_id, lastAdminMessageId: null, lastMessageSummary: supportText(m) };
    } else {
      ticket.status = 'open';
      ticket.lastUserMessageId = m.message_id;
      ticket.lastMessageSummary = supportText(m);
    }
    supportTickets.set(ticket.id, ticket);
    saveState();
    try { await sendSupportToAdmin(ticket, m, isReply); } catch (err) { console.error('[telegram] support admin delivery:', err.message); }
    return ticket;
  }

  async function sendAnyAdminReplyToUser(ticket, m) {
    const user = users.get(String(ticket.userId));
    const chatId = ticket.chatId || user?.chatId || ticket.userId;
    const caption = `<b>👑 پاسخ پشتیبانی</b>\n\n🎫 تیکت: <code>${safe(ticket.id)}</code>`;
    if (m.photo) await sendPhoto(chatId, m.photo[m.photo.length - 1].file_id, caption, { reply_markup: userSupportReplyKeyboard(ticket.id) });
    else if (m.document) await sendDocument(chatId, m.document.file_id, caption, { reply_markup: userSupportReplyKeyboard(ticket.id) });
    else if (m.video || m.voice || m.audio || m.sticker) await copyMessage(chatId, m.chat.id, m.message_id, { reply_markup: userSupportReplyKeyboard(ticket.id) });
    else await send(chatId, `${caption}\n\n${safe(m.text || m.caption || 'پیام جدید از پشتیبانی')}`, { reply_markup: userSupportReplyKeyboard(ticket.id) });
    ticket.lastAdminMessageId = m.message_id;
    ticket.status = 'waiting_user';
    ticket.lastAdminSummary = m.text || m.caption || 'پیام پشتیبانی';
    saveState();
  }

  async function sendSupportList(chatId) {
    const tickets = [...supportTickets.values()].filter(t => t.status !== 'closed');
    if (!tickets.length) return send(chatId, '📭 تیکت باز پشتیبانی وجود ندارد.', { reply_markup: adminKeyboard() });
    await send(chatId, `<b>💬 پشتیبانی</b>\n\nتعداد تیکت‌های باز: <b>${tickets.length}</b>`);
    for (const t of tickets) {
      await send(chatId, `<b>🎫 تیکت ${safe(t.id)}</b>\n\n👤 ${safe(t.name)}\n🔹 ${safe(t.username ? '@' + t.username : 'ندارد')}\n🆔 <code>${safe(t.userId)}</code>\n📌 وضعیت: ${t.status === 'waiting_user' ? '🟡 منتظر کاربر' : '🟢 پیام جدید'}\n\nآخرین پیام: ${safe(t.lastMessageSummary || '')}`, { reply_markup: adminSupportReplyKeyboard(t.id) });
    }
  }

  async function processOfflineQueue() {
    if (!botEnabled || !offlineQueue.length) return;
    const queued = offlineQueue.splice(0, offlineQueue.length);
    for (const item of queued) {
      try {
        if (item.type === 'message' && !item.admin) {
          await send(item.chatId, '⚠️ به دلیل اختلال موقت، درخواست شما با تأخیر پردازش شد. بات دوباره فعال شده و درخواست شما در حال پردازش است.');
          await handleMessage(item.message, true);
        } else if (item.type === 'callback') {
          await handleCallback(item.callback, true);
        }
      } catch (err) { console.error('[telegram] queued item:', err.message); }
    }
  }

  async function handleMessage(m, fromQueue = false) {
    const chatId = m.chat.id;
    const text = String(m.text || '').trim();
    const admin = isAdmin(m.from);

    if (!botEnabled && !admin && !fromQueue) {
      offlineQueue.push({ type: 'message', chatId: String(chatId), message: m, admin: false });
      return;
    }

    if (admin) {
      adminChatId = String(chatId);
      if (waitingForLink) {
        const user = users.get(String(waitingForLink)) || getReceipt(waitingForLink);
        if (!user) { waitingForLink = null; saveState(); return send(chatId, '⚠️ کاربر پیدا نشد.', { reply_markup: adminKeyboard() }); }
        if (!user.approved) { waitingForLink = null; saveState(); return send(chatId, '⚠️ اول رسید این کاربر را تایید کنید.', { reply_markup: adminKeyboard() }); }
        try { await copyMessage(user.chatId, chatId, m.message_id); user.access = true; user.linkSent = text || '[پیام ارسال‌شده]'; waitingForLink = null; saveState(); return send(chatId, '✅ پیام با موفقیت برای کاربر ارسال شد و دسترسی فعال شد.', { reply_markup: adminKeyboard() }); }
        catch (err) { return send(chatId, `❌ ارسال پیام انجام نشد.\n\nخطا: ${safe(err.message)}`); }
      }
      if (waitingForAdminReply.has(String(chatId))) {
        const ticketId = waitingForAdminReply.get(String(chatId));
        const ticket = supportTickets.get(ticketId);
        waitingForAdminReply.delete(String(chatId));
        if (!ticket) return send(chatId, '⚠️ تیکت پیدا نشد.', { reply_markup: adminKeyboard() });
        try { await sendAnyAdminReplyToUser(ticket, m); return send(chatId, '✅ پاسخ برای کاربر ارسال شد.', { reply_markup: adminKeyboard() }); }
        catch (err) { return send(chatId, `❌ ارسال پاسخ انجام نشد: ${safe(err.message)}`, { reply_markup: adminKeyboard() }); }
      }
      if (waitingForUserId.has(String(chatId)) && /^\d+$/.test(text)) { waitingForUserId.delete(String(chatId)); return showUser(chatId, text); }
    }

    if (text === '/start' || text === '/menu') return send(chatId, `<b>🎓 ${safe(COURSE_TITLE)}</b>\n\nآموزش کاربردی ساخت و مدیریت استوری برای اینستاگرام.\n\n💰 ${safe(COURSE_PRICE)}\n\nاز منوی زیر انتخاب کنید 👇`, { reply_markup: mainKeyboard() });
    if (text === '/id') return send(chatId, `شناسه تلگرام شما:\n<code>${safe(chatId)}</code>`);
    if (text === '/admin') return admin ? send(chatId, `<b>👑 پنل مدیریت</b>\n\nمدیر: @${safe(ADMIN_USERNAME)}\n🆔 <code>${safe(chatId)}</code>`, { reply_markup: adminKeyboard() }) : send(chatId, '⛔ این دستور فقط برای مدیر است.');

    if (waitingForUserReply.has(String(chatId))) {
      const ticketId = waitingForUserReply.get(String(chatId));
      waitingForUserReply.delete(String(chatId));
      const ticket = supportTickets.get(ticketId);
      if (!ticket) return send(chatId, '⚠️ تیکت پیدا نشد.', { reply_markup: mainKeyboard() });
      await createSupportTicket(m, true, ticketId);
      return send(chatId, `✅ پیام شما برای پشتیبانی ارسال شد.\n\n🎫 تیکت: <code>${safe(ticketId)}</code>\n🔁 این پیام به عنوان پاسخ به آخرین پیام مدیر ثبت شد.`, { reply_markup: userSupportReplyKeyboard(ticketId) });
    }

    if (waitingForSupport.has(String(chatId))) {
      waitingForSupport.delete(String(chatId));
      const ticket = await createSupportTicket(m, false);
      return send(chatId, `✅ پیام با موفقیت ارسال شد.\n\n🎫 شماره تیکت: <code>${safe(ticket.id)}</code>\n\nمنتظر پاسخ مدیران باشید. وقتی مدیر پاسخ بدهد، پایین پیام گزینه «↩️ پاسخ به پشتیبانی» برای ادامه گفتگو نمایش داده می‌شود.`, { reply_markup: backKeyboard() });
    }

    if (m.photo || m.document) {
      const delivered = await forwardReceipt(m);
      if (delivered) return send(chatId, '📤 رسید دریافت شد و برای مدیر ارسال شد. بعد از بررسی نتیجه اعلام می‌شود.');
      if (!receiptsEnabled) return send(chatId, '🔴 دریافت رسید فعلاً خاموش است.');
      return send(chatId, '📤 رسید دریافت شد، اما مدیر هنوز بات را برای دریافت رسید تنظیم نکرده است.');
    }

    return send(chatId, 'از منوی زیر یک گزینه را انتخاب کنید 👇', { reply_markup: mainKeyboard() });
  }

  async function handleCallback(q, fromQueue = false) {
    const chatId = q.message.chat.id;
    const action = String(q.data || '');
    try { await telegram('answerCallbackQuery', { callback_query_id: q.id }); } catch (err) { console.error('[telegram] callback answer:', err.message); }

    if (!botEnabled && !isAdmin(q.from) && !fromQueue) {
      offlineQueue.push({ type: 'callback', callback: q });
      return;
    }

    if (action === 'course') return send(chatId, `<b>🎓 ${safe(COURSE_TITLE)}</b>\n\nاین صفحه معرفی کامل دوره است.\n\nآموزش ساخت، ایده‌پردازی و مدیریت استوری‌های حرفه‌ای اینستاگرام.\n\n💰 ${safe(COURSE_PRICE)}`, { reply_markup: backKeyboard() });
    if (action === 'syllabus') return send(chatId, '<b>📚 سرفصل‌های دوره</b>\n\n1️⃣ اصول طراحی استوری\n2️⃣ ایده‌پردازی و سناریونویسی\n3️⃣ ساخت استوری جذاب\n4️⃣ افزایش تعامل\n5️⃣ نکات فروش و برندینگ', { reply_markup: backKeyboard() });
    if (action === 'sample') return send(chatId, '<b>🎁 نمونه رایگان</b>\n\nنمونه رایگان دوره در نسخه تستی قرار است اینجا نمایش داده شود.', { reply_markup: backKeyboard() });
    if (action === 'buy') return send(chatId, `<b>💳 خرید دوره</b>\n\n🎓 ${safe(COURSE_TITLE)}\n💰 مبلغ: ${safe(COURSE_PRICE)}\n\nبعد از پرداخت، رسید را از گزینه «📤 ارسال رسید» برای ما بفرستید.`, { reply_markup: { inline_keyboard: [
      ...(PAYMENT_URL ? [[{ text: '💳 پرداخت', url: PAYMENT_URL }]] : []),
      [{ text: '📤 ارسال رسید', callback_data: 'send_receipt' }],
      [{ text: '↩️ برگشت', callback_data: 'menu' }]
    ] } });
    if (action === 'send_receipt') return send(chatId, `<b>📤 ارسال رسید</b>\n\nتصویر یا فایل رسید پرداخت را همینجا ارسال کنید.\n\n💰 مبلغ: ${safe(COURSE_PRICE)}`, { reply_markup: backKeyboard() });
    if (action === 'support') { waitingForSupport.add(String(chatId)); return send(chatId, '<b>💬 پشتیبانی</b>\n\nپیامی که می‌خواهید به پشتیبانی بگویید را همینجا ارسال کنید.\n\nمی‌توانید متن، عکس، فایل، ویدیو یا پیام صوتی بفرستید. بعد از ارسال، پیام شما برای مدیران ارسال می‌شود.', { reply_markup: backKeyboard() }); }
    if (action === 'menu') return send(chatId, '<b>🏠 منوی اصلی</b>\n\nیک گزینه را انتخاب کنید 👇', { reply_markup: mainKeyboard() });
    if (action === 'support_user_reply') { const id = action.includes(':') ? action.split(':').slice(1).join(':') : ''; return send(chatId, ''); }

    if (!isAdmin(q.from)) return send(chatId, '⛔ این دکمه فقط برای مدیر است.');
    adminChatId = String(chatId);

    if (action === 'toggle_receipts') { receiptsEnabled = !receiptsEnabled; saveState(); return send(chatId, receiptsEnabled ? '🟢 دریافت رسید روشن شد.' : '🔴 دریافت رسید خاموش شد.', { reply_markup: adminKeyboard() }); }
    if (action === 'toggle_bot') { botEnabled = !botEnabled; saveState(); if (botEnabled) { await send(chatId, '🟢 بات دوباره فعال شد. درخواست‌های ذخیره‌شده در حال پردازش هستند.', { reply_markup: adminKeyboard() }); await processOfflineQueue(); return; } return send(chatId, '🔴 بات خاموش شد. پیام‌ها و درخواست‌های کاربران ذخیره می‌شوند و بعد از روشن‌شدن پردازش خواهند شد.', { reply_markup: adminKeyboard() }); }
    if (action === 'pending_receipts') return sendPendingReceipts(chatId);
    if (action === 'support_admin') return sendSupportList(chatId);
    if (action === 'owner_id') return send(chatId, `🆔 آیدی چت مدیر:\n<code>${safe(chatId)}</code>`, { reply_markup: adminKeyboard() });
    if (action === 'admin_status') return send(chatId, `<b>📊 وضعیت پنل</b>\n\n🧾 رسیدهای تاییدنشده: ${[...pendingReceipts.values()].filter(r => !r.approved && !r.rejected).length}\n👥 کاربران شناخته‌شده: ${users.size}\n💬 تیکت‌های باز: ${[...supportTickets.values()].filter(t => t.status !== 'closed').length}\n📥 دریافت رسید: ${receiptsEnabled ? '🟢 روشن' : '🔴 خاموش'}\n🤖 بات: ${botEnabled ? '🟢 روشن' : '🔴 خاموش'}`, { reply_markup: adminKeyboard() });
    if (action === 'user_lookup') { waitingForUserId.add(String(chatId)); return send(chatId, '🆔 Telegram ID کاربر را بفرستید:'); }

    const [cmd, ...rest] = action.split(':');
    const value = rest.join(':');

    if (cmd === 'support_reply') {
      const ticket = supportTickets.get(value);
      if (!ticket) return send(chatId, '⚠️ تیکت پیدا نشد.', { reply_markup: adminKeyboard() });
      waitingForAdminReply.set(String(chatId), value);
      return send(chatId, `<b>↩️ پاسخ به تیکت</b>\n\n🎫 <code>${safe(value)}</code>\n👤 ${safe(ticket.name)}\n🆔 <code>${safe(ticket.userId)}</code>\n\nپیام پاسخ را ارسال کنید.\nهر نوع پیام قابل ارسال است؛ متن، عکس، فایل، ویدیو، صوت و غیره.`, { reply_markup: adminKeyboard() });
    }
    if (cmd === 'support_user_reply') {
      const ticket = supportTickets.get(value);
      if (!ticket) return send(chatId, '⚠️ تیکت پیدا نشد.', { reply_markup: mainKeyboard() });
      waitingForUserReply.set(String(chatId), value);
      return send(chatId, `<b>↩️ پاسخ به پشتیبانی</b>\n\n🎫 تیکت: <code>${safe(value)}</code>\n\nپیامتان را ارسال کنید تا برای همان تیکت به مدیر ارسال شود.`, { reply_markup: backKeyboard() });
    }
    if (cmd === 'info') { const r = getReceipt(value); if (!r) return send(chatId, '⚠️ رسید پیدا نشد.', { reply_markup: adminKeyboard() }); return send(chatId, `<b>👤 اطلاعات کاربر</b>\n\nنام: ${safe(r.name)}\nیوزرنیم: ${safe(r.username ? '@' + r.username : 'ندارد')}\nTelegram ID: <code>${safe(r.userId)}</code>\nChat ID: <code>${safe(r.chatId)}</code>\nرسید: ${r.approved ? '✅ تایید' : r.rejected ? '❌ رد' : '⏳ در انتظار'}\nدسترسی: ${r.access ? '🟢 دارد' : '🔴 ندارد'}`, { reply_markup: receiptKeyboard(value) }); }
    if (cmd === 'approve') { const r = getReceipt(value); if (!r) return send(chatId, '⚠️ رسید پیدا نشد.'); r.approved = true; r.rejected = false; r.access = false; saveState(); try { await send(r.chatId, `<b>✅ رسید شما تایید شد.</b>\n\n🎓 ${safe(COURSE_TITLE)}\n\nمدیر آماده ارسال دسترسی دوره است.`); } catch (err) {} return send(chatId, '✅ رسید تایید شد. حالا «🔗 ارسال لینک» را بزنید و هر پیامی که می‌خواهید برای کاربر بفرستید.', { reply_markup: receiptKeyboard(value) }); }
    if (cmd === 'reject') { const r = getReceipt(value); if (!r) return send(chatId, '⚠️ رسید پیدا نشد.'); r.rejected = true; r.approved = false; r.access = false; saveState(); try { await send(r.chatId, '❌ رسید پرداخت شما رد شد. در صورت اشتباه، لطفاً رسید صحیح را دوباره ارسال کنید.'); } catch (err) {} return send(chatId, '❌ رسید رد شد.', { reply_markup: adminKeyboard() }); }
    if (cmd === 'link') { const r = getReceipt(value); if (!r) return send(chatId, '⚠️ رسید پیدا نشد.'); return startLinkFlow(chatId, r.userId); }
    if (cmd === 'user_info') return showUser(chatId, value);
    if (cmd === 'grant') { const user = users.get(String(value)); if (!user) return send(chatId, '⚠️ کاربر پیدا نشد.'); user.access = true; saveState(); return send(chatId, '🟢 دسترسی کاربر فعال شد.', { reply_markup: userKeyboard(value) }); }
    if (cmd === 'revoke') { const user = users.get(String(value)); if (!user) return send(chatId, '⚠️ کاربر پیدا نشد.'); user.access = false; saveState(); return send(chatId, '🔴 دسترسی کاربر لغو شد.', { reply_markup: userKeyboard(value) }); }
    if (cmd === 'user_receipts') { const list = [...pendingReceipts.values()].filter(r => r.userId === String(value)); if (!list.length) return send(chatId, '📭 برای این کاربر رسیدی ثبت نشده است.', { reply_markup: userKeyboard(value) }); await send(chatId, `📥 رسیدهای کاربر <code>${safe(value)}</code> — تعداد: ${list.length}`); for (const r of list) await sendReceiptToAdmin(chatId, r); return; }
    if (cmd === 'user_link') return startLinkFlow(chatId, value);
    return send(chatId, 'پنل مدیریت 👑', { reply_markup: adminKeyboard() });
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates) {
          offset = update.update_id + 1;
          saveState();
          try { if (update.callback_query) await handleCallback(update.callback_query); else if (update.message) await handleMessage(update.message); }
          catch (err) { console.error('[telegram] update error:', err.message); }
        }
      } catch (err) {
        console.error('[telegram] polling error:', err.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  async function startup() {
    loadState();
    try { await telegram('deleteWebhook', { drop_pending_updates: false }); } catch (err) { console.error('[telegram] deleteWebhook:', err.message); }
    try { const me = await telegram('getMe'); console.log(`[telegram] bot connected: @${me.username || me.first_name}`); } catch (err) { console.error('[telegram] getMe failed:', err.message); }
    await new Promise(r => setTimeout(r, 1500));
    if (botEnabled) await processOfflineQueue();
    poll();
  }

  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });
  startup();
  module.exports = { telegram };
}
