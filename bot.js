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
  const waitingForUserId = new Set();
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

  const sendPhoto = (chatId, photo, caption, extra = {}) => telegram('sendPhoto', {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: 'HTML',
    ...extra
  });

  const sendDocument = (chatId, document, caption, extra = {}) => telegram('sendDocument', {
    chat_id: chatId,
    document,
    caption,
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

  const userKeyboard = userId => ({ inline_keyboard: [
    [{ text: '👤 اطلاعات کاربر', callback_data: `user_info:${userId}` }],
    [{ text: '🟢 اعطای دسترسی', callback_data: `grant:${userId}` }, { text: '🔴 لغو دسترسی', callback_data: `revoke:${userId}` }],
    [{ text: '📥 رسیدهای این کاربر', callback_data: `user_receipts:${userId}` }],
    [{ text: '🔗 ارسال لینک', callback_data: `user_link:${userId}` }]
  ]});

  function receiptCaption(u, prefix = '📥 رسید پرداخت جدید') {
    return `<b>${prefix}</b>\n\n🎓 دوره: ${COURSE_TITLE}\n💰 مبلغ: ${COURSE_PRICE}\n👤 نام: ${name(u)}\n🔹 یوزرنیم: ${username(u)}\n🆔 Telegram ID: <code>${u.id}</code>\n🕐 زمان: ${new Date().toLocaleString('fa-IR')}`;
  }

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
      rejected: false,
      access: false,
      linkSent: '',
      fileType: m.photo ? 'photo' : 'document',
      fileId: m.photo ? m.photo[m.photo.length - 1].file_id : m.document?.file_id || ''
    };

    pendingReceipts.set(id, user);
    users.set(String(u.id), user);

    const extra = { reply_markup: receiptKeyboard(id) };
    if (m.photo) {
      await sendPhoto(adminChatId, user.fileId, receiptCaption(u), extra);
      return true;
    }
    if (m.document) {
      await sendDocument(adminChatId, user.fileId, receiptCaption(u), extra);
      return true;
    }
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
    if (!pending.length) {
      return send(chatId, '📭 هیچ رسید تاییدنشده‌ای وجود ندارد.', { reply_markup: adminKeyboard() });
    }
    await send(chatId, `<b>📥 رسیدهای جدید</b>\n\nتعداد: <b>${pending.length}</b>`);
    for (const r of pending) await sendReceiptToAdmin(chatId, r);
  }

  async function showUser(chatId, userId) {
    const user = users.get(String(userId));
    if (!user) return send(chatId, '⚠️ کاربری با این Telegram ID در بات پیدا نشد.', { reply_markup: adminKeyboard() });
    return send(chatId, `<b>👤 مدیریت کاربر</b>\n\nنام: ${user.name}\nیوزرنیم: ${user.username ? '@' + user.username : 'ندارد'}\nTelegram ID: <code>${user.userId}</code>\nChat ID: <code>${user.chatId}</code>\nدسترسی دوره: ${user.access ? '🟢 دارد' : '🔴 ندارد'}\nوضعیت پرداخت: ${user.approved ? '✅ تایید شده' : user.rejected ? '❌ رد شده' : '⏳ تایید نشده'}`, { reply_markup: userKeyboard(user.userId) });
  }

  async function startLinkFlow(chatId, userId) {
    const user = users.get(String(userId));
    if (!user) return send(chatId, '⚠️ کاربر پیدا نشد.', { reply_markup: adminKeyboard() });
    if (!user.approved) return send(chatId, '⚠️ اول رسید این کاربر را تایید کنید.');
    waitingForLink = String(user.userId);
    return send(chatId, `🔗 لینک دسترسی برای <code>${user.userId}</code> آماده است.\n\nحالا لینک سایت را همینجا ارسال کنید.\nمثال: https://example.com/course`);
  }

  async function handleMessage(m) {
    const chatId = m.chat.id;
    const text = String(m.text || '').trim();

    if (isAdmin(m.from)) {
      adminChatId = String(chatId);

      if (waitingForLink) {
        if (!/^https?:\/\//i.test(text)) return send(chatId, '⚠️ لطفاً لینک را با http:// یا https:// ارسال کنید.');
        const user = users.get(String(waitingForLink));
        if (!user) {
          waitingForLink = null;
          return send(chatId, '⚠️ کاربر پیدا نشد.', { reply_markup: adminKeyboard() });
        }
        if (!user.approved) {
          waitingForLink = null;
          return send(chatId, '⚠️ اول رسید این کاربر را تایید کنید.', { reply_markup: adminKeyboard() });
        }
        try {
          await send(user.chatId, `<b>✅ پرداخت شما تایید شد.</b>\n\n🎓 ${COURSE_TITLE}\n\n🔗 لینک دسترسی شما:\n${text}`);
          user.access = true;
          user.linkSent = text;
          waitingForLink = null;
          return send(chatId, '✅ لینک با موفقیت برای کاربر ارسال شد و دسترسی فعال شد.', { reply_markup: adminKeyboard() });
        } catch (err) {
          console.error('[telegram] failed to send access link:', err.message);
          return send(chatId, `❌ ارسال لینک انجام نشد.\n\nخطا: ${err.message}`);
        }
      }

      if (waitingForUserId.has(String(chatId)) && /^\d+$/.test(text)) {
        waitingForUserId.delete(String(chatId));
        return showUser(chatId, text);
      }
    }

    if (text === '/start' || text === '/menu') {
      if (isAdmin(m.from)) adminChatId = String(chatId);
      return send(chatId, `<b>🎓 ${COURSE_TITLE}</b>\n\nآموزش کاربردی ساخت و مدیریت استوری برای اینستاگرام.\n\n💰 ${COURSE_PRICE}\n\nاز منوی زیر اطلاعات دوره را ببینید یا برای خرید اقدام کنید.`, { reply_markup: mainKeyboard() });
    }
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
    if (action === 'buy') return send(chatId, `<b>💳 خرید ${COURSE_TITLE}</b>\n\n💰 مبلغ: ${COURSE_PRICE}\n\nبعد از پرداخت، تصویر رسید را همینجا ارسال کنید.`, { reply_markup: { inline_keyboard: [
      ...(PAYMENT_URL ? [[{ text: '💳 پرداخت', url: PAYMENT_URL }]] : []),
      [{ text: '📤 ارسال رسید', callback_data: 'send_receipt' }],
      [{ text: '↩️ برگشت', callback_data: 'menu' }]
    ] } });
    if (action === 'send_receipt') return send(chatId, `<b>📤 ارسال رسید پرداخت</b>\n\nتصویر رسید پرداخت را همینجا ارسال کنید.\n\n💰 مبلغ: ${COURSE_PRICE}`);
    if (action === 'support') return send(chatId, `<b>💬 پشتیبانی</b>\n\n${SUPPORT_USERNAME ? `@${SUPPORT_USERNAME.replace(/^@/, '')}` : 'پشتیبانی هنوز تنظیم نشده است.'}`, { reply_markup: mainKeyboard() });
    if (action === 'menu') return send(chatId, 'منوی اصلی 👇', { reply_markup: mainKeyboard() });

    if (!isAdmin(q.from)) return send(chatId, '⛔ این دکمه فقط برای مدیر است.');
    adminChatId = String(chatId);

    if (action === 'toggle_receipts') {
      receiptsEnabled = !receiptsEnabled;
      return send(chatId, receiptsEnabled ? '🟢 دریافت رسید روشن شد.' : '🔴 دریافت رسید خاموش شد.', { reply_markup: adminKeyboard() });
    }
    if (action === 'pending_receipts') return sendPendingReceipts(chatId);
    if (action === 'owner_id') return send(chatId, `🆔 آیدی چت مدیر:\n<code>${chatId}</code>`, { reply_markup: adminKeyboard() });
    if (action === 'admin_status') return send(chatId, `<b>📊 وضعیت پنل</b>\n\n🧾 رسیدهای تاییدنشده: ${[...pendingReceipts.values()].filter(r => !r.approved && !r.rejected).length}\n👥 کاربران شناخته‌شده: ${users.size}\n📥 دریافت رسید: ${receiptsEnabled ? '🟢 روشن' : '🔴 خاموش'}\n🔗 انتظار لینک: ${waitingForLink ? '🟡 فعال' : '⚪ ندارد'}`, { reply_markup: adminKeyboard() });

    if (action === 'user_lookup') {
      waitingForUserId.add(String(chatId));
      return send(chatId, '🆔 Telegram ID کاربر را بفرستید:');
    }

    const [cmd, value] = action.split(':');
    if (cmd === 'info') {
      const r = pendingReceipts.get(value);
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.', { reply_markup: adminKeyboard() });
      return send(chatId, `<b>👤 اطلاعات کاربر</b>\n\nنام: ${r.name}\nیوزرنیم: ${r.username ? '@' + r.username : 'ندارد'}\nTelegram ID: <code>${r.userId}</code>\nChat ID: <code>${r.chatId}</code>\nرسید: ${r.approved ? '✅ تایید' : r.rejected ? '❌ رد' : '⏳ در انتظار'}\nدسترسی: ${r.access ? '🟢 دارد' : '🔴 ندارد'}` , { reply_markup: receiptKeyboard(value) });
    }

    if (cmd === 'approve') {
      const r = pendingReceipts.get(value);
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.');
      r.approved = true;
      r.rejected = false;
      r.access = false;
      try {
        await send(r.chatId, `<b>✅ رسید شما تایید شد.</b>\n\n🎓 ${COURSE_TITLE}\n\nلطفاً برای دریافت لینک دسترسی، منتظر ارسال لینک از طرف مدیر باشید.`);
      } catch (err) {
        console.error('[telegram] approval notification failed:', err.message);
      }
      return send(chatId, '✅ رسید تایید شد. حالا روی «🔗 ارسال لینک» بزنید و لینک را بفرستید.', { reply_markup: receiptKeyboard(value) });
    }

    if (cmd === 'reject') {
      const r = pendingReceipts.get(value);
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.');
      r.rejected = true;
      r.approved = false;
      r.access = false;
      try { await send(r.chatId, '❌ رسید پرداخت شما رد شد. در صورت اشتباه، لطفاً رسید صحیح را دوباره ارسال کنید.'); }
      catch (err) { console.error('[telegram] rejection notification failed:', err.message); }
      return send(chatId, '❌ رسید رد شد.', { reply_markup: adminKeyboard() });
    }

    if (cmd === 'link') {
      const r = pendingReceipts.get(value);
      if (!r) return send(chatId, '⚠️ رسید پیدا نشد.');
      return startLinkFlow(chatId, r.userId);
    }

    if (cmd === 'user_info') return showUser(chatId, value);
    if (cmd === 'grant') {
      const user = users.get(String(value));
      if (!user) return send(chatId, '⚠️ کاربر پیدا نشد.');
      user.access = true;
      return send(chatId, '🟢 دسترسی کاربر فعال شد.', { reply_markup: userKeyboard(value) });
    }
    if (cmd === 'revoke') {
      const user = users.get(String(value));
      if (!user) return send(chatId, '⚠️ کاربر پیدا نشد.');
      user.access = false;
      return send(chatId, '🔴 دسترسی کاربر لغو شد.', { reply_markup: userKeyboard(value) });
    }
    if (cmd === 'user_receipts') {
      const list = [...pendingReceipts.values()].filter(r => r.userId === String(value));
      if (!list.length) return send(chatId, '📭 برای این کاربر رسیدی ثبت نشده است.', { reply_markup: userKeyboard(value) });
      await send(chatId, `📥 رسیدهای کاربر <code>${value}</code> — تعداد: ${list.length}`);
      for (const r of list) await sendReceiptToAdmin(chatId, r);
      return;
    }
    if (cmd === 'user_link') return startLinkFlow(chatId, value);

    return send(chatId, 'پنل مدیریت 👑', { reply_markup: adminKeyboard() });
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            if (update.callback_query) await handleCallback(update.callback_query);
            else if (update.message) await handleMessage(update.message);
          } catch (err) {
            console.error('[telegram] update error:', err.message);
          }
        }
      } catch (err) {
        console.error('[telegram] polling error:', err.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  async function startup() {
    try { await telegram('deleteWebhook', { drop_pending_updates: false }); } catch (err) { console.error('[telegram] deleteWebhook:', err.message); }
    try {
      const me = await telegram('getMe');
      console.log(`[telegram] bot connected: @${me.username || me.first_name}`);
    } catch (err) {
      console.error('[telegram] getMe failed:', err.message);
    }
    poll();
  }

  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });
  startup();
  module.exports = { telegram };
}
