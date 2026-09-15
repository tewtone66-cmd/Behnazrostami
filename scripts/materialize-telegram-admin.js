const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'bot.js');
let bot = fs.readFileSync(file, 'utf8');

// Owner is authoritative: only ADMIN_CHAT_ID / persisted ownerId grants owner access.
bot = bot.replace(
  /const canAdmin = u => isOwner\(u\) \|\| isManager\(u\);/,
  'const canAdmin = u => isOwner(u) || isManager(u);'
);

// Direct auto-wake in the real handler, not a runtime source patch.
bot = bot.replace(
  /async function handleMessage\(m(?:,\s*queued=false)?\)\s*\{/,
  'async function handleMessage(m,queued=false){if(!botEnabled){botEnabled=true;saveState();console.log(\'[telegram] auto-enabled by incoming message\');}'
);
bot = bot.replace(
  /async function handleCallback\(q(?:,\s*queued=false)?\)\s*\{/,
  'async function handleCallback(q,queued=false){if(!botEnabled){botEnabled=true;saveState();console.log(\'[telegram] auto-enabled by incoming button\');}'
);

if (!bot.includes('function __recordUserHistory')) {
  const helper = `function __recordUserHistory(m){try{const id=String(m.from?.id||m.chat?.id||'');const u=users.get(id);if(!u)return;u.messages=u.messages||[];const type=m.text?'text':m.photo?'photo':m.video?'video':m.document?'document':m.voice?'voice':m.audio?'audio':m.sticker?'sticker':m.animation?'animation':m.location?'location':m.contact?'contact':'other';const fileId=m.photo?.[m.photo.length-1]?.file_id||m.video?.file_id||m.document?.file_id||m.voice?.file_id||m.audio?.file_id||m.sticker?.file_id||m.animation?.file_id||'';u.messages.push({messageId:m.message_id,chatId:String(m.chat?.id||id),type,fileId,text:String(m.text||m.caption||''),summary:messageSummary(m),at:new Date().toISOString()});if(u.messages.length>1000)u.messages.splice(0,u.messages.length-1000);saveState();}catch(e){console.error('[telegram] history:',e.message);}}\nasync function __showHistoryUsers(chatId){const list=[...users.values()].filter(u=>(u.messages||[]).length);if(!list.length)return send(chatId,'📭 هنوز پیامی ثبت نشده است.',{reply_markup:adminUsers()});const rows=list.slice(0,50).map(u=>[{text:'📨 '+String(u.name||'کاربر').slice(0,22)+' | '+u.userId,callback_data:'user_history:'+u.userId+':0'}]);rows.push([{text:'↩️ کاربران',callback_data:'admin_users'}]);return send(chatId,'<b>📜 پیام‌های کاربران</b>\\n\\nیک کاربر را انتخاب کن:',{reply_markup:{inline_keyboard:rows}});}\nasync function __showUserHistory(chatId,userId,page=0){const u=users.get(String(userId)),list=u?.messages||[];if(!list.length)return send(chatId,'📭 برای این کاربر پیامی ثبت نشده است.',{reply_markup:adminUsers()});const size=8,total=Math.ceil(list.length/size),p=Math.max(0,Math.min(Number(page)||0,total-1)),items=list.slice(p*size,p*size+size);let out='<b>📜 پیام‌های کاربر</b>\\n\\n👤 '+safe(u.name||'کاربر')+'\\n🆔 <code>'+safe(userId)+'</code>\\n📄 صفحه '+(p+1)+'/'+total+'\\n\\n';for(const [i,x] of items.entries()){out+=(p*size+i+1)+'. <b>'+safe(new Date(x.at).toLocaleString('fa-IR'))+'</b> | '+safe(x.summary||x.type||'پیام')+'\\n';if(x.text)out+='↳ '+safe(x.text.slice(0,500))+'\\n';out+='\\n';}const nav=[];if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'user_history:'+userId+':'+(p-1)});if(p<total-1)nav.push({text:'بعدی ➡️',callback_data:'user_history:'+userId+':'+(p+1)});const rows=[];if(nav.length)rows.push(nav);for(let i=0;i<items.length;i++)rows.push([{text:'👁 پیام '+(p*size+i+1),callback_data:'user_message:'+userId+':'+(p*size+i)}]);rows.push([{text:'↩️ پیام‌های کاربران',callback_data:'admin_user_history'}]);return send(chatId,out,{reply_markup:{inline_keyboard:rows}});}\nasync function __showUserMessage(chatId,userId,index){const u=users.get(String(userId)),x=u?.messages?.[Number(index)];if(!u||!x)return send(chatId,'❌ پیام پیدا نشد.',{reply_markup:adminUsers()});try{await copyMessage(chatId,x.chatId||u.chatId,x.messageId,{reply_markup:{inline_keyboard:[[{text:'↩️ تاریخچه کاربر',callback_data:'user_history:'+userId+':'+Math.floor(Number(index)/8)}]]}});}catch(e){await send(chatId,'⚠️ این پیام دیگر از تلگرام قابل کپی نیست.\\n\\n'+safe(x.text||x.summary||'پیام رسانه‌ای'),{reply_markup:{inline_keyboard:[[{text:'↩️ تاریخچه کاربر',callback_data:'user_history:'+userId+':'+Math.floor(Number(index)/8)}]]}});}}\n`;
  bot = bot.replace('function messageSummary(m){', helper + 'function messageSummary(m){');
}

// Record every incoming message before normal routing.
bot = bot.replace(
  /async function handleMessage\(m(?:,\s*queued=false)?\)\s*\{/,
  'async function handleMessage(m,queued=false){if(!botEnabled){botEnabled=true;saveState();console.log(\'[telegram] auto-enabled by incoming message\');}getOrCreateUser(m);__recordUserHistory(m);'
);

// Text input state: manager addition and ownership transfer. Ownership edits the original panel message.
bot = bot.replace(
  /async function handleMessage\(m(?:,\s*queued=false)?\)\{[^\n]*/,
  match => match + `\nconst __aid=String(m.from?.id||''),__txt=String(m.text||'').trim();\nif(canAdmin(m.from)&&waitingForManager.has(__aid)){const id=__txt.replace(/\\D/g,'');if(!/^\\d{5,20}$/.test(id)){const st=waitingForManager.get(__aid);if(st?.messageId)try{await edit(m.chat.id,st.messageId,'❌ فقط آیدی عددی معتبر بفرست.\\n\\n🆔 آیدی مدیر جدید را دوباره بفرست.',adminManagers());catch{}else return send(m.chat.id,'❌ فقط آیدی عددی معتبر بفرست.',{reply_markup:adminManagers()});return;}managers.set(id,{userId:id,permissions:defaultPerms(),addedAt:new Date().toISOString()});const st=waitingForManager.get(__aid);waitingForManager.delete(__aid);saveState();if(st?.messageId){try{return await edit(m.chat.id,st.messageId,'✅ مدیر با موفقیت اضافه شد.\\n🆔 <code>'+safe(id)+'</code>',managerKeyboard(id));}catch{}}return send(m.chat.id,'✅ مدیر با موفقیت اضافه شد.\\n🆔 <code>'+safe(id)+'</code>',{reply_markup:managerKeyboard(id)});}\nif(isOwner(m.from)&&waitingForOwnership.has(__aid)){const id=__txt.replace(/\\D/g,'');const st=waitingForOwnership.get(__aid);if(!/^\\d{5,20}$/.test(id)){if(st?.messageId)try{await edit(m.chat.id,st.messageId,'❌ فقط آیدی عددی معتبر بفرست.\\n\\n👑 آیدی مالک جدید را دوباره بفرست.',adminOwnership());catch{}else return send(m.chat.id,'❌ فقط آیدی عددی معتبر بفرست.',{reply_markup:adminOwnership()});return;}ownerId=id;waitingForOwnership.delete(__aid);saveState();if(st?.messageId){try{return await edit(m.chat.id,st.messageId,'✅ <b>انتقال مالکیت انجام شد.</b>\\n\\n👑 مالک جدید: <code>'+safe(id)+'</code>',adminOwnership());catch{}}return send(m.chat.id,'✅ <b>انتقال مالکیت انجام شد.</b>\\n🆔 <code>'+safe(id)+'</code>',{reply_markup:adminOwnership()});}`
);

bot = bot.replace(
  "const adminUsers=()=>({inline_keyboard:[[{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'}],[{text:'↩️ پنل مدیر',callback_data:'admin_home'}]]});",
  "const adminUsers=()=>({inline_keyboard:[[{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'}],[{text:'📜 پیام‌های کاربران',callback_data:'admin_user_history'}],[{text:'↩️ پنل مدیر',callback_data:'admin_home'}]]});"
);
bot = bot.replace(
  "const userKeyboard=id=>({inline_keyboard:[[{text:'👤 اطلاعات',callback_data:`user_info:${id}`}],[{text:'🟢 اعطای دسترسی',callback_data:`grant:${id}`},{text:'🔴 لغو',callback_data:`revoke:${id}`}],[{text:'📥 رسیدها',callback_data:`user_receipts:${id}`}],[{text:'🔗 ارسال دسترسی',callback_data:`user_link:${id}`}],[{text:'↩️ کاربران',callback_data:'admin_users'}]]});",
  "const userKeyboard=id=>({inline_keyboard:[[{text:'👤 اطلاعات',callback_data:`user_info:${id}`}],[{text:'📜 پیام‌های کاربر',callback_data:`user_history:${id}:0`}],[{text:'🟢 اعطای دسترسی',callback_data:`grant:${id}`},{text:'🔴 لغو',callback_data:`revoke:${id}`}],[{text:'📥 رسیدها',callback_data:`user_receipts:${id}`}],[{text:'🔗 ارسال دسترسی',callback_data:`user_link:${id}`}],[{text:'↩️ کاربران',callback_data:'admin_users'}]]});"
);

bot = bot.replace(
  /const chatId=String\(q\.message\.chat\.id\),action=String\(q\.data\|\|''\),from=q\.from;try\{/,
  "const chatId=String(q.message.chat.id),action=String(q.data||''),from=q.from;try{if(!botEnabled){botEnabled=true;saveState();console.log('[telegram] auto-enabled by incoming button');}if(action==='manager_add'&&canAdmin(from)){waitingForManager.set(String(from.id),{messageId:q.message.message_id});return edit(chatId,q.message.message_id,'🛡 <b>افزودن مدیر</b>\\n\\n🆔 آیدی عددی مدیر جدید را بفرست:',adminManagers());}if(action==='transfer_owner'&&isOwner(from)){waitingForOwnership.set(String(from.id),{messageId:q.message.message_id});return edit(chatId,q.message.message_id,'👑 <b>انتقال مالکیت</b>\\n\\n🆔 آیدی عددی مالک جدید را بفرست:',adminOwnership());}if(action==='admin_user_history'&&canAdmin(from))return __showHistoryUsers(chatId);if(action.startsWith('user_history:')&&canAdmin(from)){const z=action.split(':');return __showUserHistory(chatId,z[1],z[2]||0);}if(action.startsWith('user_message:')&&canAdmin(from)){const z=action.split(':');return __showUserMessage(chatId,z[1],z[2]||0);}"
);

fs.writeFileSync(file, bot);
console.log('[materialize] bot.js updated');
