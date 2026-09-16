const fs=require('fs');
const path=require('path');
const https=require('https');
const botFile=path.join(__dirname,'bot.js');
let bot=fs.readFileSync(botFile,'utf8');

// Normalize admin/owner authorization. ADMIN_USERNAME (and optional ADMIN_CHAT_ID)
// can always open the panel; the first configured-admin use becomes the initial owner.
const adminBlock=`const isOwner = u => Boolean(ownerId && String(u?.id) === String(ownerId));
  const isManager = u => managers.has(String(u?.id));
  const isConfiguredAdmin = u => Boolean((u?.username && String(u.username).toLowerCase() === ADMIN_USERNAME) || (process.env.ADMIN_CHAT_ID && String(u?.id) === String(process.env.ADMIN_CHAT_ID)));
  const hasPerm = (u,p) => isOwner(u) || isConfiguredAdmin(u) || Boolean(managers.get(String(u?.id))?.permissions?.[p]);
  const canAdmin = u => isOwner(u) || isManager(u) || isConfiguredAdmin(u);`;
bot=bot.replace(/const isOwner = u =>[\s\S]*?const canAdmin = u =>[^;]+;/,adminBlock);

// Always wake the bot before its normal OFF guard.
bot=bot.replace(/async function handleMessage\(m(?:,\s*queued=false)?\)\s*\{/,"async function handleMessage(m,queued=false){if(!botEnabled){botEnabled=true;saveState();}if(isConfiguredAdmin(m.from)&&!ownerId){ownerId=String(m.from.id);saveState();}");
bot=bot.replace(/async function handleCallback\(q(?:,\s*queued=false)?\)\s*\{/,"async function handleCallback(q,queued=false){if(!botEnabled){botEnabled=true;saveState();}if(isConfiguredAdmin(q.from)&&!ownerId){ownerId=String(q.from.id);saveState();}");

// Record incoming user messages and expose complete history in the admin panel.
if(!bot.includes('function __recordUserHistory')){
 const helper=`\n  function __recordUserHistory(m){try{const id=String(m.from?.id||m.chat?.id||'');const u=users.get(id);if(!u)return;u.messages=u.messages||[];u.messages.push({messageId:m.message_id,chatId:String(m.chat?.id||id),type:m.text?'text':m.photo?'photo':m.video?'video':m.document?'document':m.voice?'voice':m.audio?'audio':m.sticker?'sticker':m.animation?'animation':'other',text:String(m.text||m.caption||''),summary:messageSummary(m),at:new Date().toISOString()});if(u.messages.length>2000)u.messages=u.messages.slice(-2000);saveState();}catch(e){console.error('[telegram] history:',e.message);}}\n  async function __showHistoryUsers(chatId){const list=[...users.values()].filter(u=>(u.messages||[]).length);if(!list.length)return send(chatId,'📭 هنوز پیامی ثبت نشده است.',{reply_markup:adminUsers()});const rows=list.slice(0,50).map(u=>[{text:'📨 '+String(u.name||'کاربر').slice(0,22)+' | '+u.userId,callback_data:'user_history:'+u.userId+':0'}]);rows.push([{text:'↩️ کاربران',callback_data:'admin_users'}]);return send(chatId,'<b>📜 پیام‌های کاربران</b>\\n\\nیک کاربر را انتخاب کن:',{reply_markup:{inline_keyboard:rows}});}\n  async function __showUserHistory(chatId,userId,page=0){const u=users.get(String(userId)),list=u?.messages||[];if(!list.length)return send(chatId,'📭 برای این کاربر پیامی ثبت نشده است.',{reply_markup:adminUsers()});const size=8,total=Math.ceil(list.length/size),p=Math.max(0,Math.min(Number(page)||0,total-1)),items=list.slice(p*size,p*size+size);let out='<b>📜 پیام‌های کاربر</b>\\n\\n👤 '+safe(u.name||'کاربر')+'\\n🆔 <code>'+safe(userId)+'</code>\\n📄 صفحه '+(p+1)+'/'+total+'\\n\\n';for(const [i,x] of items.entries()){out+=(p*size+i+1)+'. <b>'+safe(new Date(x.at).toLocaleString('fa-IR'))+'</b> | '+safe(x.summary||x.type||'پیام')+'\\n';if(x.text)out+='↳ '+safe(x.text.slice(0,500))+'\\n';out+='\\n';}const nav=[];if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'user_history:'+userId+':'+(p-1)});if(p<total-1)nav.push({text:'بعدی ➡️',callback_data:'user_history:'+userId+':'+(p+1)});const rows=[];if(nav.length)rows.push(nav);for(let i=0;i<items.length;i++)rows.push([{text:'👁 پیام '+(p*size+i+1),callback_data:'user_message:'+userId+':'+(p*size+i)}]);rows.push([{text:'↩️ پیام‌های کاربران',callback_data:'admin_user_history'}]);return send(chatId,out,{reply_markup:{inline_keyboard:rows}});}\n  async function __showUserMessage(chatId,userId,index){const u=users.get(String(userId)),x=u?.messages?.[Number(index)];if(!u||!x)return send(chatId,'❌ پیام پیدا نشد.',{reply_markup:adminUsers()});try{await copyMessage(chatId,x.chatId||u.chatId,x.messageId);}catch(e){return send(chatId,'⚠️ این پیام دیگر از تلگرام قابل کپی نیست.\\n\\n'+safe(x.text||x.summary||'پیام رسانه‌ای'),{reply_markup:{inline_keyboard:[[{text:'↩️ تاریخچه کاربر',callback_data:'user_history:'+userId+':'+Math.floor(Number(index)/8)}]]}});}}\n`;
 bot=bot.replace('function messageSummary(m){',helper+'function messageSummary(m){');
}

// Call the history recorder after the user object has been created.
bot=bot.replace("const chatId=String(m.chat.id),text=String(m.text||'').trim(),admin=canAdmin(m.from),owner=isOwner(m.from);","const chatId=String(m.chat.id),text=String(m.text||'').trim(),admin=canAdmin(m.from),owner=isOwner(m.from);if(!admin)__recordUserHistory(m);");

// Manager and ownership prompts are edited in-place, not sent as a new page.
bot=bot.replace("waitingForManager.set(chatId,true);return send(chatId,'🆔 Telegram ID مدیر جدید را ارسال کنید.',{reply_markup:adminManagers()});","waitingForManager.set(chatId,q.message.message_id);return page('🛡 <b>افزودن مدیر</b>\\n\\n🆔 آیدی عددی مدیر جدید را بفرست:',adminManagers());");
bot=bot.replace("waitingForOwnership.set(chatId,true);return send(chatId,'🆔 Telegram ID مالک جدید را ارسال کنید.\\n\\nپس از انتقال، مالک جدید دسترسی کامل خواهد داشت.',{reply_markup:adminOwnership()});","waitingForOwnership.set(chatId,q.message.message_id);return page('👑 <b>انتقال مالکیت</b>\\n\\n🆔 آیدی عددی مالک جدید را بفرست:',adminOwnership());");

// Handle the stored prompt IDs when the administrator sends the requested ID.
bot=bot.replace("if(waitingForManager.has(chatId)&&/^\\d+$/.test(text)&&hasPerm(m.from,'managers')){const id=text;waitingForManager.delete(chatId);","if(waitingForManager.has(chatId)&&/^\\d+$/.test(text)&&hasPerm(m.from,'managers')){const promptId=waitingForManager.get(chatId);const id=text;waitingForManager.delete(chatId);");
bot=bot.replace("saveState();return send(chatId,'✅ مدیر اضافه شد. حالا می‌توانید دسترسی‌های او را تنظیم کنید.',{reply_markup:managerKeyboard(id)});","saveState();try{if(Number.isInteger(promptId))return edit(chatId,promptId,'✅ مدیر اضافه شد. حالا می‌توانید دسترسی‌های او را تنظیم کنید.',managerKeyboard(id));}catch{}return send(chatId,'✅ مدیر اضافه شد. حالا می‌توانید دسترسی‌های او را تنظیم کنید.',{reply_markup:managerKeyboard(id)});");
bot=bot.replace("if(waitingForOwnership.has(chatId)&&/^\\d+$/.test(text)&&owner){const newOwner=text;waitingForOwnership.delete(chatId);","if(waitingForOwnership.has(chatId)&&/^\\d+$/.test(text)&&owner){const promptId=waitingForOwnership.get(chatId);const newOwner=text;waitingForOwnership.delete(chatId);");
bot=bot.replace("saveState();try{await send(newOwner,'👑 شما به عنوان مالک جدید بات تعیین شدید. اکنون دسترسی کامل به پنل مدیریت دارید.');}catch{}return send(chatId,'✅ مالکیت داخلی بات منتقل شد. شما دیگر مالک اصلی نیستید.',{reply_markup:adminHome()});","saveState();try{await send(newOwner,'👑 شما به عنوان مالک جدید بات تعیین شدید. اکنون دسترسی کامل به پنل مدیریت دارید.');}catch{}try{if(Number.isInteger(promptId))return edit(chatId,promptId,'✅ مالکیت بات منتقل شد.\\n\\n👑 مالک جدید: <code>'+safe(newOwner)+'</code>',adminHome());}catch{}return send(chatId,'✅ مالکیت بات منتقل شد. شما دیگر مالک اصلی نیستید.',{reply_markup:adminHome()});");

// Add history entry points.
bot=bot.replace("const adminUsers=()=>({inline_keyboard:[[{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'}],[{text:'↩️ پنل مدیر',callback_data:'admin_home'}]]});","const adminUsers=()=>({inline_keyboard:[[{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'}],[{text:'📜 پیام‌های کاربران',callback_data:'admin_user_history'}],[{text:'↩️ پنل مدیر',callback_data:'admin_home'}]]});");
bot=bot.replace("const userKeyboard=id=>({inline_keyboard:[[{text:'👤 اطلاعات',callback_data:`user_info:${id}`}],[{text:'🟢 اعطای دسترسی',callback_data:`grant:${id}`},{text:'🔴 لغو',callback_data:`revoke:${id}`}],[{text:'📥 رسیدها',callback_data:`user_receipts:${id}`}],[{text:'🔗 ارسال دسترسی',callback_data:`user_link:${id}`}],[{text:'↩️ کاربران',callback_data:'admin_users'}]]});","const userKeyboard=id=>({inline_keyboard:[[{text:'👤 اطلاعات',callback_data:`user_info:${id}`}],[{text:'📜 پیام‌های کاربر',callback_data:`user_history:${id}:0`}],[{text:'🟢 اعطای دسترسی',callback_data:`grant:${id}`},{text:'🔴 لغو',callback_data:`revoke:${id}`}],[{text:'📥 رسیدها',callback_data:`user_receipts:${id}`}],[{text:'🔗 ارسال دسترسی',callback_data:`user_link:${id}`}],[{text:'↩️ کاربران',callback_data:'admin_users'}]]});");

// Wire history callbacks into the existing callback handler.
if(!bot.includes("action==='admin_user_history'"))bot=bot.replace("const page=(text,markup)=>edit(chatId,q.message.message_id,text,markup);","const page=(text,markup)=>edit(chatId,q.message.message_id,text,markup);if(action==='admin_user_history'&&canAdmin(from))return __showHistoryUsers(chatId);if(action.startsWith('user_history:')&&canAdmin(from)){const z=action.split(':');return __showUserHistory(chatId,z[1],z[2]||0);}if(action.startsWith('user_message:')&&canAdmin(from)){const z=action.split(':');return __showUserMessage(chatId,z[1],z[2]||0);}");

fs.writeFileSync(botFile,bot);
console.log('[telegram] admin/owner/manager/history patch applied');
require('./server.js');
