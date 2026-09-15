const https = require('https');
const COURSE_TITLE = process.env.COURSE_TITLE || 'مافیای استوری اینستاگرام';
const COURSE_PRICE = process.env.COURSE_PRICE || 'قیمت تستی';
const PAYMENT_URL = process.env.PAYMENT_URL || '';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || '';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'Senpaizuto').replace(/^@/, '').toLowerCase();
const token = process.env.BOT_TOKEN;
if (!token) { console.log('[telegram] BOT_TOKEN is not set; Telegram bot is disabled.'); module.exports = null; } else {
  const API = `https://api.telegram.org/bot${token}`; let offset = 0, stopped = false;
  let adminChatId = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
  const pendingReceipts = new Map(); let waitingForLink = null;
  function telegram(method, body = {}) { return new Promise((resolve, reject) => {
    const url = new URL(`${API}/${method}`), payload = JSON.stringify(body);
    const request = https.request({ protocol:url.protocol, hostname:url.hostname, port:443, path:url.pathname, method:'POST', family:4, headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}, timeout:35000 }, response => {
      let data=''; response.setEncoding('utf8'); response.on('data', c => data += c); response.on('end', () => { try { const parsed=JSON.parse(data); if(!parsed.ok) return reject(new Error(parsed.description || `Telegram API error: ${method}`)); resolve(parsed.result); } catch { reject(new Error(`Invalid Telegram response (${response.statusCode})`)); } });
    }); request.on('timeout',()=>request.destroy(new Error('Telegram request timed out'))); request.on('error',reject); request.write(payload); request.end();
  }); }
  const keyboard = () => ({inline_keyboard:[[{text:'🎓 معرفی دوره',callback_data:'course'}],[{text:'📚 سرفصل‌ها',callback_data:'syllabus'},{text:'🎁 نمونه رایگان',callback_data:'sample'}],[{text:'💰 خرید دوره',callback_data:'buy'}],[{text:'💬 پشتیبانی',callback_data:'support'}]]});
  const receiptKeyboard = id => ({inline_keyboard:[[{text:'👤 اطلاعات کاربر',callback_data:`info:${id}`}],[{text:'✅ تایید رسید',callback_data:`approve:${id}`},{text:'❌ رد رسید',callback_data:`reject:${id}`}],[{text:'🔗 ارسال لینک',callback_data:`link:${id}`}]]});
  const send = (chatId,text,extra={}) => telegram('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',...extra});
  const name = u => [u?.first_name,u?.last_name].filter(Boolean).join(' ') || 'بدون نام';
  const username = u => u?.username ? `@${u.username}` : 'ندارد';
  const isAdmin = u => Boolean((adminChatId && String(u?.id)===adminChatId) || String(u?.username||'').toLowerCase()===ADMIN_USERNAME);
  async function forwardReceipt(m) {
    if (!adminChatId) { console.error('[telegram] ADMIN_CHAT_ID is not set; owner must message the bot once.'); return; }
    const id=`${m.chat.id}:${m.message_id}`, u=m.from||{};
    pendingReceipts.set(id,{id,chatId:m.chat.id,userId:u.id,name:name(u),username:u.username||'',sentAt:new Date().toISOString(),approved:false});
    const caption=`<b>📥 رسید پرداخت جدید</b>\n\n🎓 دوره: ${COURSE_TITLE}\n💰 مبلغ: ${COURSE_PRICE}\n👤 نام: ${name(u)}\n🔹 یوزرنیم: ${username(u)}\n🆔 Telegram ID: <code>${u.id}</code>\n🕐 زمان: ${new Date().toLocaleString('fa-IR')}`;
    const common={chat_id:adminChatId,caption,parse_mode:'HTML',reply_markup:receiptKeyboard(id)};
    if(m.photo) return telegram('sendPhoto',{...common,photo:m.photo[m.photo.length-1].file_id});
    if(m.document) return telegram('sendDocument',{...common,document:m.document.file_id});
  }
  async function handleMessage(m) {
    const chatId=m.chat.id, text=String(m.text||'').trim();
    if(isAdmin(m.from)) {
      adminChatId=String(chatId);
      if(waitingForLink && /^https?:\/\//i.test(text)) {
        const r=pendingReceipts.get(waitingForLink);
        if(!r) return send(chatId,'⚠️ رسید پیدا نشد.');
        if(!r.approved) return send(chatId,'⚠️ اول باید رسید را تایید کنید.');
        await send(r.chatId,`<b>✅ رسید پرداخت شما تایید شد.</b>\n\n🎓 ${COURSE_TITLE}\n\n🔗 لینک دسترسی شما:\n${text}`);
        r.linkSent=text; waitingForLink=null; return send(chatId,'✅ لینک با موفقیت برای کاربر ارسال شد.');
      }
    }
    if(text==='/start'||text==='/menu') return send(chatId,`<b>🎓 ${COURSE_TITLE}</b>\n\nآموزش کاربردی ساخت و مدیریت استوری برای اینستاگرام.\n\n💰 ${COURSE_PRICE}\n\nاز منوی زیر اطلاعات دوره را ببینید یا برای خرید اقدام کنید.`,{reply_markup:keyboard()});
    if(text==='/id') return send(chatId,`شناسه تلگرام شما:\n<code>${chatId}</code>`);
    if(text==='/admin') return isAdmin(m.from)?send(chatId,`<b>👑 پنل مدیر</b>\n\nTelegram ID: <code>${chatId}</code>\nUsername: @${ADMIN_USERNAME}\nرسیدهای ثبت‌شده: ${pendingReceipts.size}`):send(chatId,'⛔ این دستور فقط برای مدیر است.');
    if(m.photo||m.document) { await forwardReceipt(m); return send(chatId,'<b>📤 رسید دریافت شد.</b>\n\nرسید شما برای بررسی ارسال شد. بعد از بررسی نتیجه به شما اعلام می‌شود.'); }
    return send(chatId,'از منوی زیر یک گزینه را انتخاب کنید 👇',{reply_markup:keyboard()});
  }
  async function handleCallback(q) {
    const chatId=q.message.chat.id, action=String(q.data||''); await telegram('answerCallbackQuery',{callback_query_id:q.id});
    if(!isAdmin(q.from)) return send(chatId,'⛔ این دکمه فقط برای مدیر است.');
    if(action.startsWith('info:')) { const r=pendingReceipts.get(action.slice(5)); if(!r)return send(chatId,'⚠️ رسید پیدا نشد.'); return send(chatId,`<b>👤 اطلاعات کامل کاربر</b>\n\nنام: ${r.name}\nیوزرنیم: ${r.username?'@'+r.username:'ندارد'}\nTelegram ID: <code>${r.userId}</code>\nChat ID: <code>${r.chatId}</code>\nزمان: ${new Date(r.sentAt).toLocaleString('fa-IR')}`); }
    if(action.startsWith('approve:')) { const r=pendingReceipts.get(action.slice(8)); if(!r)return send(chatId,'⚠️ رسید پیدا نشد.'); r.approved=true; await send(r.chatId,`<b>✅ رسید پرداخت شما تایید شد.</b>\n\nپرداخت دوره «${COURSE_TITLE}» با موفقیت تایید شد.\n\n🔗 مدیر لینک دسترسی را برای شما ارسال می‌کند.`); return send(chatId,'✅ رسید تایید شد. حالا «🔗 ارسال لینک» را بزنید و لینک را بفرستید.'); }
    if(action.startsWith('reject:')) { const r=pendingReceipts.get(action.slice(7)); if(!r)return send(chatId,'⚠️ رسید پیدا نشد.'); r.approved=false; await send(r.chatId,'<b>❌ رسید پرداخت تایید نشد.</b>\n\nلطفاً رسید صحیح را دوباره ارسال کنید.'); return send(chatId,'❌ رسید رد شد و پیام برای کاربر ارسال شد.'); }
    if(action.startsWith('link:')) { const id=action.slice(5), r=pendingReceipts.get(id); if(!r)return send(chatId,'⚠️ رسید پیدا نشد.'); if(!r.approved)return send(chatId,'⚠️ اول باید رسید را تایید کنید.'); waitingForLink=id; return send(chatId,'<b>🔗 ارسال لینک دوره</b>\n\nلینک دوره را همینجا بفرست.'); }
    if(action==='course') return send(chatId,`<b>🎓 ${COURSE_TITLE}</b>\n\nیک دوره آموزشی کامل برای بهتر شدن استوری‌های اینستاگرام.\n\n💰 ${COURSE_PRICE}`,{reply_markup:keyboard()});
    if(action==='syllabus') return send(chatId,'<b>📚 سرفصل‌های دوره</b>\n\n• اصول طراحی استوری\n• ایده‌پردازی و سناریونویسی\n• ساخت استوری جذاب\n• افزایش تعامل\n• نکات مهم فروش و برندینگ',{reply_markup:keyboard()});
    if(action==='sample') return send(chatId,'<b>🎁 نمونه رایگان</b>\n\nنمونه رایگان دوره در نسخه تستی بعداً اضافه می‌شود.',{reply_markup:keyboard()});
    if(action==='buy') return send(chatId,`<b>💳 خرید ${COURSE_TITLE}</b>\n\n💰 مبلغ: ${COURSE_PRICE}\n\nبعد از پرداخت، تصویر رسید را همینجا ارسال کنید.`,{reply_markup:{inline_keyboard:[[...(PAYMENT_URL?[{text:'💳 پرداخت',url:PAYMENT_URL}]:[])],[{text:'📤 ارسال رسید',callback_data:'send_receipt'}],[{text:'↩️ برگشت',callback_data:'menu'}]]}});
    if(action==='send_receipt') return send(chatId,`<b>📤 ارسال رسید پرداخت</b>\n\nتصویر رسید پرداخت را همینجا ارسال کنید.\n\n💰 مبلغ: ${COURSE_PRICE}`);
    if(action==='support') return send(chatId,`<b>💬 پشتیبانی</b>\n\n${SUPPORT_USERNAME?`@${SUPPORT_USERNAME.replace(/^@/,'')}`:'پشتیبانی هنوز تنظیم نشده است.'}`,{reply_markup:keyboard()});
    if(action==='menu') return send(chatId,'منوی اصلی 👇',{reply_markup:keyboard()});
    return send(chatId,'گزینه موردنظر پیدا نشد.',{reply_markup:keyboard()});
  }
  async function poll(){ while(!stopped){ try { const updates=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']}); for(const u of updates){offset=u.update_id+1; try{if(u.message)await handleMessage(u.message);if(u.callback_query)await handleCallback(u.callback_query);}catch(e){console.error('[telegram] update error:',e.message);}} } catch(e){console.error('[telegram] polling error:',e.message);await new Promise(r=>setTimeout(r,5000));} } }
  process.once('SIGTERM',()=>stopped=true); process.once('SIGINT',()=>stopped=true);
  (async()=>{while(!stopped){try{try{await telegram('deleteWebhook',{drop_pending_updates:false});}catch(e){console.error('[telegram] deleteWebhook warning:',e.message);} const bot=await telegram('getMe');console.log(`[telegram] bot connected: @${bot.username}`);await poll();return;}catch(e){console.error('[telegram] startup error:',e.message);await new Promise(r=>setTimeout(r,5000));}}})();
  module.exports={send};
}
