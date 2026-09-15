const fs = require('fs');
const path = require('path');

const botFile = path.join(__dirname, 'bot.js');
let bot = fs.readFileSync(botFile, 'utf8');

if (!bot.includes('const isConfiguredAdmin = u =>')) {
  bot = bot.replace('const canAdmin = u => isOwner(u) || isManager(u);', "const isConfiguredAdmin = u => Boolean(u?.username && String(u.username).toLowerCase() === ADMIN_USERNAME);\n  const canAdmin = u => isOwner(u) || isManager(u) || isConfiguredAdmin(u);");
}

// Bot wake-up: match both handleMessage(m) and handleMessage(m,queued=false).
bot = bot.replace(
  /async function handleMessage\(m(?:,\s*queued=false)?\)\s*\{/,
  "async function handleMessage(m,queued=false){if(!botEnabled){botEnabled=true;saveState();console.log('[telegram] auto-enabled by incoming message');}"
);
bot = bot.replace(
  /async function handleCallback\(q(?:,\s*queued=false)?\)\s*\{/,
  "async function handleCallback(q,queued=false){if(!botEnabled){botEnabled=true;saveState();console.log('[telegram] auto-enabled by incoming button');}"
);

if (!bot.includes('function __recordUserHistory')) {
  const helper = `function __recordUserHistory(m){try{const id=String(m.from?.id||m.chat?.id||'');const u=users.get(id);if(!u)return;u.messages=u.messages||[];u.messages.push({messageId:m.message_id,type:m.text?'text':m.photo?'photo':m.video?'video':m.document?'document':m.voice?'voice':m.audio?'audio':m.sticker?'sticker':'other',text:String(m.text||m.caption||''),summary:messageSummary(m),at:new Date().toISOString()});if(u.messages.length>500)u.messages.splice(0,u.messages.length-500);saveState();}catch(e){console.error('[telegram] history:',e.message);}}\nasync function __showUserHistory(chatId,userId){const u=users.get(String(userId)),list=u?.messages||[];if(!list.length)return send(chatId,'📭 برای این کاربر پیامی ثبت نشده است.',{reply_markup:adminUsers()});let out='<b>📜 پیام‌های کاربر</b>\\n\\n👤 '+safe(u.name||'کاربر')+'\\n🆔 <code>'+safe(userId)+'</code>\\n\\n';for(const [i,x] of list.entries()){out+=(i+1)+'. <b>'+safe(new Date(x.at).toLocaleString('fa-IR'))+'</b> | '+safe(x.summary||'پیام')+'\\n';if(x.text)out+='↳ '+safe(x.text)+'\\n';out+='\\n';}const parts=[];while(out.length>3800){const cut=out.lastIndexOf('\\n',3800);parts.push(out.slice(0,cut>500?cut:3800));out=out.slice(cut>500?cut:3800);}parts.push(out);for(const p of parts)await send(chatId,p,{reply_markup:adminBack()});}\nasync function __showHistoryUsers(chatId){const list=[...users.values()].filter(u=>(u.messages||[]).length);if(!list.length)return send(chatId,'📭 هنوز پیامی ثبت نشده است.',{reply_markup:adminUsers()});const rows=list.slice(0,50).map(u=>[{text:'📨 '+String(u.name||'کاربر').slice(0,22)+' | '+u.userId,callback_data:'user_history:'+u.userId}]);rows.push([{text:'↩️ کاربران',callback_data:'admin_users'}]);return send(chatId,'<b>📜 پیام‌های کاربران</b>\\n\\nیک کاربر را انتخاب کن:',{reply_markup:{inline_keyboard:rows}});}\n`;
  bot = bot.replace('function messageSummary(m){', helper + 'function messageSummary(m){');
}

// Record every incoming message before the normal bot logic.
bot = bot.replace(
  /async function handleMessage\(m(?:,\s*queued=false)?\)\s*\{/, 
  "async function handleMessage(m,queued=false){if(!botEnabled){botEnabled=true;saveState();console.log('[telegram] auto-enabled by incoming message');}getOrCreateUser(m);__recordUserHistory(m);"
);

// Manager and ownership text flows. Match the real function signature with queued=false.
bot = bot.replace(
  /async function handleMessage\(m(?:,\s*queued=false)?\)\{[^\n]*/,
  match => match + `\nconst __aid=String(m.from?.id||''),__txt=String(m.text||'').trim();\nif(canAdmin(m.from)&&waitingForManager.has(__aid)){const id=__txt.replace(/\\D/g,'');if(!/^\\d{5,20}$/.test(id))return send(m.chat.id,'❌ فقط آیدی عددی معتبر بفرست.',{reply_markup:adminManagers()});managers.set(id,{userId:id,permissions:defaultPerms(),addedAt:new Date().toISOString()});waitingForManager.delete(__aid);saveState();return send(m.chat.id,'✅ مدیر با موفقیت اضافه شد.\\n🆔 <code>'+safe(id)+'</code>',{reply_markup:managerKeyboard(id)});}\nif(isOwner(m.from)&&waitingForOwnership.has(__aid)){const id=__txt.replace(/\\D/g,'');if(!/^\\d{5,20}$/.test(id))return send(m.chat.id,'❌ فقط آیدی عددی معتبر بفرست.',{reply_markup:adminOwnership()});ownerId=id;waitingForOwnership.delete(__aid);saveState();return send(m.chat.id,'👑 مالکیت منتقل شد.\\n🆔 <code>'+safe(id)+'</code>',{reply_markup:adminOwnership()});}`
);

bot = bot.replace("const adminUsers=()=>({inline_keyboard:[[{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'}],[{text:'↩️ پنل مدیر',callback_data:'admin_home'}]]});", "const adminUsers=()=>({inline_keyboard:[[{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'}],[{text:'📜 پیام‌های کاربران',callback_data:'admin_user_history'}],[{text:'↩️ پنل مدیر',callback_data:'admin_home'}]]});");
bot = bot.replace("const userKeyboard=id=>({inline_keyboard:[[{text:'👤 اطلاعات',callback_data:`user_info:${id}`}],[{text:'🟢 اعطای دسترسی',callback_data:`grant:${id}`},{text:'🔴 لغو',callback_data:`revoke:${id}`}],[{text:'📥 رسیدها',callback_data:`user_receipts:${id}`}],[{text:'🔗 ارسال دسترسی',callback_data:`user_link:${id}`}],[{text:'↩️ کاربران',callback_data:'admin_users'}]]});", "const userKeyboard=id=>({inline_keyboard:[[{text:'👤 اطلاعات',callback_data:`user_info:${id}`}],[{text:'📜 پیام‌های کاربر',callback_data:`user_history:${id}`}],[{text:'🟢 اعطای دسترسی',callback_data:`grant:${id}`},{text:'🔴 لغو',callback_data:`revoke:${id}`}],[{text:'📥 رسیدها',callback_data:`user_receipts:${id}`}],[{text:'🔗 ارسال دسترسی',callback_data:`user_link:${id}`}],[{text:'↩️ کاربران',callback_data:'admin_users'}]]});");
bot = bot.replace(/const chatId=String\(q\.message\.chat\.id\),action=String\(q\.data\|\|''\),from=q\.from;try\{/, "const chatId=String(q.message.chat.id),action=String(q.data||''),from=q.from;try{if(!botEnabled){botEnabled=true;saveState();console.log('[telegram] auto-enabled by incoming button');}if(action==='manager_add'&&canAdmin(from)){waitingForManager.set(String(from.id),true);return send(chatId,'🆔 آیدی عددی مدیر جدید را بفرست.',{reply_markup:adminManagers()});}if(action==='transfer_owner'&&isOwner(from)){waitingForOwnership.set(String(from.id),true);return send(chatId,'👑 آیدی عددی مالک جدید را بفرست.',{reply_markup:adminOwnership()});}if(action==='admin_user_history'&&canAdmin(from))return __showHistoryUsers(chatId);if(action.startsWith('user_history:')&&canAdmin(from))return __showUserHistory(chatId,action.slice(13));");

fs.writeFileSync(botFile, bot);
require('./boot-fix.js');
