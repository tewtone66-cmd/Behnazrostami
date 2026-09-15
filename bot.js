const https = require('https');

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
  let offset = 0;
  let stopped = false;
  let adminChatId = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
  let receiptsEnabled = true;
  let waitingForLink = null;
  let waitingForUserId = new Set();

  const pendingReceipts = new Map();
  const users = new Map();

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
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        },
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

  const send = (chatId, text, extra = {}) => telegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra
  });

  const name = u => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || 'بدون نام';
  const username = u => u?.username ? `@${u.username}` : 'ندارد';
  const isAdmin = u => Boolean(
    (adminChatId && String(u?.id) === adminChatId) ||
    String(u?.username || '').toLowerCase() === ADMIN_USERNAME
  );

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
    [{ text: '📥 دریافت رسیدهای جدید', callback_data: 'pending_receipts' }],
    [{ text: '👥 مدیریت کاربران', callback_data: 'user_lookup' }],
    [{ text: '🆔 آیدی مدیر', callback_data: 'owner_id' }],
    [{ text: '📊 وضعیت پنل', callback_data: 'admin_status' }]
  ]});

  async function forwardReceipt(m) {
    if (!receiptsEnabled) return false;
    if (!adminChatId) {
      console.error('[telegram] ADMIN_CHAT_ID is not set; owner must message the bot once.');
      return false;
    }

    const id = `${m.chat.id}:${m.message_id}`;
    const u = m.from || {};
    const user = {
      id,
      chatId: String(m.chat.id),
      userId: String(u.id),
      name: name(u),
      username: u.username || '',
      sentAt: new Date().toISOString(),
      approved: false,
      access: false,
      linkSent: ''
    };

    pendingReceipts.set(id, user);
    users.set(String(u.id), user);

    const caption = `<b>📥 رسید پرداخت جدید</b>\n\n🎓 دوره: ${COURSE_TITLE}\n💰 مبلغ: ${COURSE_PRICE}\n👤 نام: ${name(u)}\n🔹 یوزرنیم: ${username(u)}\n🆔 Telegram ID: <code>${u.id}</code>\n🕐 زمان: ${new Date().toLocaleString('fa-IR')}`;
    const common = { chat_id: adminChatId, caption, parse_mode: 'HTML', reply_markup: receiptKeyboard(id) };

    if (m.photo) {
      await telegram('sendPhoto', { ...common, photo: m.photo[m.photo.length - 1].file_id });
      return true;
    }
    if (m.document) {
      await telegram('sendDocument', { ...common, document: m.document.file_id });
      return true;
    }
    return false;
  }

  async function sendPendingReceipts(chatId) {
    const pending = [...pendingReceipts.values()].filter(r => !r.approved);
    if (!pending.length) return send(chatId, '📭 هیچ رسید تاییدنشده و جدیدی وجود ندارد.', { reply_markup: adminKeyboard() });

    await send(chatId, `<b>📥 رسیدهای جدید</b>\n\nتعداد: <b>${pending.length}</b>\nرسیدهای تاییدنشده زیر ارسال می‌شوند:`);
    for (const r of pending) {
      await send(chatId, `<b>📄 رسید #${r.id}</b>\n\n👤 ${r.name}\n🔹 ${r.username ? '@' + r.username : 'یوزرنیم ندارد'}\n🆔 <code>${r.userId}</code>\n🕐 ${new Date(r.sentAt).toLocaleString('fa-IR')}`, { reply_markup: receiptKeyboard(r.id) });
    }
  }

  function userKeyboard(userId) {
    return { inline_keyboard: [
      [{ text: '👤 اطلاعات کاربر', callback_data: `user_info:${userId}` }],
      [{ text: '🟢 اعطای دسترسی', callback_data: `grant:${userId}` }, { text: '🔴 لغو دسترسی', callback_data: `revoke:${userId}` }],
      [{ text: '📥 رسیدهای این کاربر', callback_data: `user_receipts:${userId}` }],
      [{ text: '🔗 ارسال لینک', callback_data: `user_link:${userId}` }]
    ]};
  }

  async function showUser(chatId, userId) {
    const user = users.get(String(userId));
    if (!user) return send(chatId, '⚠️ کاربری با این Telegram ID در بات پیدا نشد.', { reply_markup: adminKeyboard() });
    return send(chatId, `<b>👤 مدیریت کاربر</b>\n\nنام: ${user.name}\nیوزرنیم: ${user.username ? '@' + user.username : 'ندارد'}\nTelegram ID: <code>${user.userId}</code>\nChat ID: <code>${user.chatId}</code>\nدسترسی دوره: ${user.access ? '🟢 دارد' : '🔴 ندارد'}\nوضعیت پرداخت: ${user.approved ? '✅ تایید شده' : '⏳ تایید نشده'}`, { reply_markup: userKeyboard(user.userId) });
  }

  async function handleMessage(m) {
    const chatId = m.chat.id;
    const text = String(m.text || '').trim();

    if (isAdmin(m.from)) {
      adminChatId = String(chatId);

      if (waitingForLink && /^https?:\/\//i.test(text)) {
        const user = users.get(String(waitingForLink));
        if (!user) {
          waitingForLink = null;
          return send(chatId, '⚠️ کاربر پیدا نشد.');
        }
        if (!user.approved) return send(chatId, '⚠️ اول رسید این کاربر را تایید کنید.');
        user.access = true;
        user.linkSent = text;
        await send(user.chatId, `<b>✅ پرداخت شما تایید شد.</b>\n\n🎓 ${COURSE_TITLE}\n\n🔗 لینک دسترسی شما:\n${text}`);
        waitingForLink = null;
        return send(chatId, '✅ لینک برای کاربر ارسال شد و دسترسی او فعال شد.', { reply_markup: adminKeyboard() });
      }

      if (waitingForUserId.has(String(chatId)) && /^\d+$/.test(text)) {
        waitingForUserId.delete(String(chatId));
        return showUser(chatId, text);
      }
    }

    if (text === '/start' || text === '/menu') return send(chatId, `<b>🎓 ${COURSE_TITLE}</b>\n\nآموزش کاربردی ساخت و مدیریت استوری برای اینستاگرام.\n\n💰 ${COURSE_PRICE}\n\nاز منوی زیر اطلاعات دوره را ببینید یا برای خرید اقدام کنید.`, { reply_markup: mainKeyboard() });
    if (text === '/id') return send(chatId, `شناسه تلگرام شما:\n<code>${chatId}</code>`);
    if (text === '/admin') return isAdmin(m.from) ? send(chatId, `<b>👑 پنل مدیریت</b>\n\nمدیر: @${ADMIN_USERNAME}\n🆔 <code>${chatId}</code>`, { reply_markup: adminKeyboard() }) : send(chatId, '⛔ این دستور فقط برای مدیر است.');

    if (m.photo || m.document) {
      const delivered = await forwardReceipt(m);
      if (delivered) return send(chatId, '📤 رسید دریافت شد و برای مدیر ارسال شد. بعد از بررسی نتیجه اعلام می‌شود.');
      if (!receiptsEnabled) return send(chatId, '🔴 دریافت رسید فعلاً خاموش است.');
      return send(chatId, '📤 رسید دریافت شد، اما مدیر هنوز بات را برای دریافت رسید تنظیم نکرده است.');
    }

    return send(chatId, 'از منوی زیر یک گزینه را انتخاب کنید 👇', { reply_markup: mainKeyboard() });
  }

  async function handleCallback(q) {
    const chatId = q.message.chat.id;
    const action = String(q.data || '');
    await telegram('answerCallbackQuery', { callback_query_id: q.id });

    if (action === 'course') return send(chatId, `<b>🎓 ${COURSE_TITLE}</b>\n\nیک دوره آموزشی کامل برای بهتر شدن استوری‌های اینستاگرام.\n\n💰 ${COURSE_PRICE}`, { reply_markup: mainKeyboard() });
    if (action === 'syllabus') return send(chatId, '<b>📚 سرفصل‌های دوره</b>\n\n• اصول طراحی استوری\n• ایده‌پردازی و سناریونویسی\n• ساخت استوری جذاب\n• افزایش تعامل\n• نکات مهم فروش و برندینگ', { reply_markup: mainKeyboard() });
    if (action === 'sample') return send(chatId, '<b>🎁 نمونه رایگان</b>\n\nنمونه رایگان دوره در نسخه تستی بعداً اضافه می‌شود.', { reply_markup: mainKeyboard() });
    if (action === 'buy') return send(chatId, `<b>💳 خرید ${COURSE_TITLE}</b>\n\n💰 مبلغ: ${COURSE_PRICE}\n\nبعد از پرداخت، تصویر رسید را همینجا ارسال کنید.`, { reply_markup: { inline_keyboard: [[...(PAYMENT_URL ? [{ text: '💳 پرداخت', url: PAYMENT_URL }] : [])], [{ text: '📤 ارسال رسید', callback_data: 'send_receipt' }], [{ text: '↩️ برگشت', callback_data: 'menu' }]] } });
    if (action === 'send_receipt') return send(chatId, `<b>📤 ارسال رسید پرداخت</b>\n\nتصویر رسید پرداخت را همینجا ارسال کنید.\n\n💰 مبلغ: ${COURSE_PRICE}`);
    if (action === 'support') return send(chatId, `<b>💬 پشتیبانی</b>\n\n${SUPPORT_USERNAME ? `@${SUPPORT_USERNAME.replace(/^@/, '')}` : 'پشتیبانی هنوز تنظیم نشده است.'}`, { reply_markup: mainKeyboard() });
    if (action === 'menu') return send(chatId, 'منوی اصلی 👇', { reply_markup: mainKeyboard() });

    if (!isAdmin(q.from)) return send(chatId, '⛔ این دکمه فقط برای مدیر است.');

    if (action === 'toggle_receipts') {
      receiptsEnabled = !receiptsEnabled;
      return send(chatId, receiptsEnabled ? '🟢 دریافت رسید روشن شد.' : '🔴 دریافت رسید خاموش شد.', { reply_markup: adminKeyboard() });
    }
    if (action === 'pending_receipts') return sendPendingReceipts(chatId);
    if (action === 'owner_id') return send(chatId, `<b>🆔 آیدی مدیر</b>\n\nTelegram ID: <code>${chatId}</code>\nUsername: @${ADMIN_USERNAME}`, { reply_markup: adminKeyboard() });
    if (action === 'admin_status') return send(chatId, `<b>📊 وضعیت پنل</b>\n\nدریافت رسید: ${receiptsEnabled ? '🟢 روشن' : '🔴 خاموش'}\nرسیدهای تاییدنشده: ${[...pendingReceipts.values()].filter(r => !r.approved).length}\nکاربران شناخته‌شده: ${users.size}\nآیدی مدیر: <code>${chatId}</code>`, { reply_markup: adminKeyboard() });
    if (action === 'user_lookup') {
      waitingForUserId.add(String(chatId));
      return send(chatId, '<b>👥 مدیریت کاربر</b>\n\nTelegram ID کاربر را همینجا بفرست:');
    }

    if (action.startsWith('info:')) {
      const r = pendingReceipts.get(action.slice(5));
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.', { reply_markup: adminKeyboard() });
      return send(chatId, `<b>👤 اطلاعات کامل کاربر</b>\n\nنام: ${r.name}\nیوزرنیم: ${r.username ? '@' + r.username : 'ندارد'}\nTelegram ID: <code>${r.userId}</code>\nChat ID: <code>${r.chatId}</code>\nدسترسی: ${r.access ? '🟢 دارد' : '🔴 ندارد'}\nپرداخت: ${r.approved ? '✅ تایید شده' : '⏳ تایید نشده'}\nزمان: ${new Date(r.sentAt).toLocaleString('fa-IR')}`);
    }
    if (action.startsWith('approve:')) {
      const r = pendingReceipts.get(action.slice(8));
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.');
      r.approved = true;
      users.set(r.userId, r);
      await send(r.chatId, `<b>✅ رسید پرداخت شما تایید شد.</b>\n\nپرداخت دوره «${COURSE_TITLE}» با موفقیت تایید شد.\n\n🔗 مدیر لینک دسترسی را برای شما ارسال می‌کند.`);
      return send(chatId, '✅ رسید تایید شد. حالا «🔗 ارسال لینک» را بزنید.', { reply_markup: receiptKeyboard(r.id) });
    }
    if (action.startsWith('reject:')) {
      const r = pendingReceipts.get(action.slice(7));
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.');
      r.approved = false;
      return send(r.chatId, '<b>❌ رسید پرداخت تایید نشد.</b>\n\nلطفاً رسید صحیح را دوباره ارسال کنید.') && send(chatId, '❌ رسید رد شد.', { reply_markup: adminKeyboard() });
    }
    if (action.startsWith('link:')) {
      const r = pendingReceipts.get(action.slice(5));
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.');
      if (!r.approved) return send(chatId, '⚠️ اول باید رسید را تایید کنید.');
      waitingForLink = r.userId;
      return send(chatId, `<b>🔗 ارسال لینک</b>\n\nلینک دسترسی کاربر <code>${r.userId}</code> را همینجا بفرست:`);
    }

    if (action.startsWith('user_info:')) {
      const id = action.slice(10), u = users.get(id);
      if (!u) return send(chatId, '⚠️ کاربر پیدا نشد.');
      return send(chatId, `<b>👤 اطلاعات کاربر</b>\n\nنام: ${u.name}\nیوزرنیم: ${u.username ? '@' + u.username : 'ندارد'}\nTelegram ID: <code>${u.userId}</code>\nChat ID: <code>${u.chatId}</code>\nدسترسی: ${u.access ? '🟢 دارد' : '🔴 ندارد'}\nپرداخت: ${u.approved ? '✅ تایید شده' : '⏳ تایید نشده'}`);
    }
    if (action.startsWith('grant:')) {
      const id = action.slice(6), u = users.get(id);
      if (!u) return send(chatId, '⚠️ کاربر پیدا نشد.');
      u.access = true;
      return send(chatId, '🟢 دسترسی این کاربر فعال شد.', { reply_markup: userKeyboard(id) });
    }
    if (action.startsWith('revoke:')) {
      const id = action.slice(7), u = users.get(id);
      if (!u) return send(chatId, '⚠️ کاربر پیدا نشد.');
      u.access = false;
      return send(chatId, '🔴 دسترسی این کاربر لغو شد.', { reply_markup: userKeyboard(id) });
    }
    if (action.startsWith('user_receipts:')) {
      const id = action.slice(14);
      const list = [...pendingReceipts.values()].filter(r => r.userId === id);
      if (!list.length) return send(chatId, '📭 برای این کاربر رسیدی ثبت نشده است.', { reply_markup: userKeyboard(id) });
      for (const r of list) await send(chatId, `<b>📄 رسید</b>\n\nمبلغ: ${COURSE_PRICE}\nوضعیت: ${r.approved ? '✅ تایید شده' : '⏳ تایید نشده'}\nزمان: ${new Date(r.sentAt).toLocaleString('fa-IR')}`, { reply_markup: receiptKeyboard(r.id) });
      return;
    }
    if (action.startsWith('user_link:')) {
      const id = action.slice(10), u = users.get(id);
      if (!u) return send(chatId, '⚠️ کاربر پیدا نشد.');
      if (!u.approved) return send(chatId, '⚠️ اول پرداخت این کاربر را تایید کنید.');
      waitingForLink = id;
      return send(chatId, `<b>🔗 ارسال لینک</b>\n\nلینک دسترسی کاربر <code>${id}</code> را همینجا بفرست:`);
    }

    return send(chatId, 'گزینه موردنظر پیدا نشد.', { reply_markup: adminKeyboard() });
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            if (u.message) await handleMessage(u.message);
            if (u.callback_query) await handleCallback(u.callback_query);
          } catch (e) {
            console.error('[telegram] update error:', e.message);
          }
        }
      } catch (e) {
        console.error('[telegram] polling error:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  process.once('SIGTERM', () => stopped = true);
  process.once('SIGINT', () => stopped = true);

  (async () => {
    while (!stopped) {
      try {
        try { await telegram('deleteWebhook', { drop_pending_updates: false }); }
        catch (e) { console.error('[telegram] deleteWebhook warning:', e.message); }
        const bot = await telegram('getMe');
        console.log(`[telegram] bot connected: @${bot.username}`);
        await poll();
        return;
      } catch (e) {
        console.error('[telegram] startup error:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  })();

  module.exports = { send };
}
