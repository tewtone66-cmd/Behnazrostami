const https = require('https');

const COURSE_TITLE = process.env.COURSE_TITLE || 'مافیای استوری اینستاگرام';
const COURSE_PRICE = process.env.COURSE_PRICE || 'قیمت تستی';
const PAYMENT_URL = process.env.PAYMENT_URL || '';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '';

const token = process.env.BOT_TOKEN;

if (!token) {
  console.log('[telegram] BOT_TOKEN is not set; Telegram bot is disabled.');
  module.exports = null;
} else {
  const API = `https://api.telegram.org/bot${token}`;
  let offset = 0;
  let stopped = false;

  // Use IPv4 explicitly. This avoids a common Render/Telegram connection issue
  // where Node's fetch can fail before reaching api.telegram.org.
  function telegram(method, body = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${API}/${method}`);
      const payload = JSON.stringify(body);

      const request = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
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
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) {
              reject(new Error(parsed.description || `Telegram API error: ${method}`));
              return;
            }
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

  function keyboard() {
    return {
      inline_keyboard: [
        [{ text: '🎓 معرفی دوره', callback_data: 'course' }],
        [{ text: '📚 سرفصل‌ها', callback_data: 'syllabus' }, { text: '🎁 نمونه رایگان', callback_data: 'sample' }],
        [{ text: '💰 خرید دوره', callback_data: 'buy' }],
        [{ text: '💬 پشتیبانی', callback_data: 'support' }]
      ]
    };
  }

  async function send(chatId, text, extra = {}) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...extra
    });
  }

  async function handleMessage(message) {
    const chatId = message.chat.id;
    const text = String(message.text || '').trim();

    if (text === '/start' || text === '/menu') {
      return send(chatId,
        `<b>🎓 ${COURSE_TITLE}</b>\n\n` +
        `آموزش کاربردی ساخت و مدیریت استوری برای اینستاگرام.\n\n` +
        `از منوی زیر اطلاعات دوره را ببینید یا برای خرید اقدام کنید.`,
        { reply_markup: keyboard() }
      );
    }

    if (text === '/id') {
      return send(chatId, `شناسه تلگرام شما:\n<code>${chatId}</code>`);
    }

    return send(chatId, 'از منوی زیر یک گزینه را انتخاب کنید 👇', { reply_markup: keyboard() });
  }

  async function handleCallback(query) {
    const chatId = query.message.chat.id;
    const action = query.data;

    await telegram('answerCallbackQuery', { callback_query_id: query.id });

    if (action === 'course') {
      return send(chatId,
        `<b>🎓 ${COURSE_TITLE}</b>\n\n` +
        `یک دوره آموزشی کامل برای بهتر شدن استوری‌های اینستاگرام.\n\n` +
        `💰 ${COURSE_PRICE}`,
        { reply_markup: keyboard() }
      );
    }

    if (action === 'syllabus') {
      return send(chatId,
        `<b>📚 سرفصل‌های دوره</b>\n\n` +
        `• اصول طراحی استوری\n` +
        `• ایده‌پردازی و سناریونویسی\n` +
        `• ساخت استوری جذاب\n` +
        `• افزایش تعامل\n` +
        `• نکات مهم فروش و برندینگ\n\n` +
        `سرفصل‌ها در نسخه نهایی قابل ویرایش هستند.`,
        { reply_markup: keyboard() }
      );
    }

    if (action === 'sample') {
      return send(chatId,
        `<b>🎁 نمونه رایگان</b>\n\n` +
        `این بخش آماده است تا بعداً لینک یا محتوای نمونه رایگان دوره در آن قرار بگیرد.`,
        { reply_markup: keyboard() }
      );
    }

    if (action === 'buy') {
      if (!PAYMENT_URL) {
        return send(chatId,
          `<b>💰 خرید دوره</b>\n\n` +
          `💵 مبلغ: ${COURSE_PRICE}\n\n` +
          `درگاه پرداخت هنوز به بات متصل نشده است. بعد از اتصال درگاه، پرداخت و فعال‌سازی دسترسی خودکار انجام می‌شود.`,
          { reply_markup: keyboard() }
        );
      }

      return send(chatId,
        `<b>💳 پرداخت ${COURSE_TITLE}</b>\n\n` +
        `💵 مبلغ: ${COURSE_PRICE}\n\n` +
        `برای پرداخت روی دکمه زیر بزنید.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 پرداخت', url: PAYMENT_URL }],
              [{ text: '↩️ برگشت', callback_data: 'menu' }]
            ]
          }
        }
      );
    }

    if (action === 'support') {
      const support = SUPPORT_USERNAME ? `@${SUPPORT_USERNAME.replace(/^@/, '')}` : 'پشتیبانی هنوز تنظیم نشده است.';
      return send(chatId,
        `<b>💬 پشتیبانی</b>\n\n${support}`,
        { reply_markup: keyboard() }
      );
    }

    if (action === 'menu') {
      return send(chatId, 'منوی اصلی 👇', { reply_markup: keyboard() });
    }

    return send(chatId, 'گزینه موردنظر پیدا نشد.', { reply_markup: keyboard() });
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await telegram('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query']
        });

        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            if (update.message) await handleMessage(update.message);
            if (update.callback_query) await handleCallback(update.callback_query);
          } catch (error) {
            console.error('[telegram] update error:', error.message);
          }
        }
      } catch (error) {
        console.error('[telegram] polling error:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });

  async function startBot() {
    while (!stopped) {
      try {
        // Don't prevent the bot from starting just because deleting an old
        // webhook temporarily fails.
        try {
          await telegram('deleteWebhook', { drop_pending_updates: false });
        } catch (error) {
          console.error('[telegram] deleteWebhook warning:', error.message);
        }

        const bot = await telegram('getMe');
        console.log(`[telegram] bot connected: @${bot.username}`);
        await poll();
        return;
      } catch (error) {
        console.error('[telegram] startup/poll connection error:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  startBot();
  module.exports = { send };
}
