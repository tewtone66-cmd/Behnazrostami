const fs = require('fs');
const path = require('path');

const botFile = path.join(__dirname, 'bot.js');
let bot = fs.readFileSync(botFile, 'utf8');

// The configured Telegram username is the initial admin/owner fallback.
bot = bot.replace(
  'const canAdmin = u => isOwner(u) || isManager(u);',
  "const isConfiguredAdmin = u => Boolean(u?.username && String(u.username).toLowerCase() === ADMIN_USERNAME);\n  const canAdmin = u => isOwner(u) || isManager(u) || isConfiguredAdmin(u);"
);

// Keep the bot OFF when disabled, but answer immediately with the offline notice.
// This is intentionally not an auto-enable: the user asked for the notice while OFF.
bot = bot.replace(
  /async function handleMessage\(m(?:,\s*queued=false)?\)\s*\{/,
  "async function handleMessage(m,queued=false){if(!botEnabled){try{await send(m.chat.id,'⚠️ <b>بات در حال حاضر خاموش است.</b>\\n\\nلطفاً بعداً دوباره تلاش کنید.');}catch(e){console.error('[telegram] offline notice:',e.message);}return;}if(isConfiguredAdmin(m.from)&&!ownerId){ownerId=String(m.from.id);saveState();}getOrCreateUser(m);__recordUserHistory(m);"
);

bot = bot.replace(
  /async function handleCallback\(q(?:,\s*queued=false)?\)\s*\{/,
  "async function handleCallback(q,queued=false){const chatId=String(q.message?.chat?.id||'');const action=String(q.data||'');const from=q.from;if(!botEnabled){try{await send(chatId,'⚠️ <b>بات در حال حاضر خاموش است.</b>\\n\\nلطفاً بعداً دوباره تلاش کنید.');}catch(e){console.error('[telegram] offline notice:',e.message);}return;}if(isConfiguredAdmin(from)&&!ownerId){ownerId=String(from.id);saveState();}"
);

// Save a complete per-user message history for admin viewing.
if (!bot.includes('function __recordUserHistory')) {
  const helper = `function __recordUserHistory(m){try{const id=String(m.from?.id||m.chat?.id||'');const u=users.get(id);if(!u)return;u.messages=u.messages||[];const type=m.text?'text':m.photo?'photo':m.video?'video':m.document?'document':m.voice?'voice':m.audio?'audio':m.sticker?'sticker':m.animation?'animation':m.location?'location':m.contact?'contact':'other';const fileId=m.photo?.[m.photo.length-1]?.file_id||m.video?.file_id||m.document?.file_id||m.voice?.file_id||m.audio?.file_id||m.sticker?.file_id||m.animation?.file_id||'';u.messages.push({messageId:m.message_id,chatId:String(m.chat?.id||id),type,fileId,text:String(m.text||m.caption||''),summary:messageSummary(m),at:new Date().toISOString()});if(u.messages.length>2000)u.messages.splice(0,u.messages.length-2000);saveState();}catch(e){console.error('[telegram] history:',e.message);}}\nasync function __showHistoryUsers(chatId){const list=[...users.values()].filter(u=>(u.messages||[]).length);if(!list.length)return send(chatId,'📭 هنوز پیامی ثبت نشده است.',{reply_markup:adminUsers()});const rows=list.slice(0,50).map(u=>[{text:'📨 '+String(u.name||'کاربر').slice(0,22)+' | '+u.userId,callback_data:'user_history:'+u.userId+':0'}]);rows.push([{text:'↩️ کاربران',callback_data:'admin_users'}]);return send(chatId,'<b>📜 پیام‌های کاربران</b>\\n\\nیک کاربر را انتخاب کن:',{reply_markup:{inline_keyboard:rows}});}\nasync function __showUserHistory(chatId,userId,page=0){const u=users.get(String(userId)),list=u?.messages||[];if(!list.length)return send(chatId,'📭 برای این کاربر پیامی ثبت نشده است.',{reply_markup:adminUsers()});const size=8,total=Math.ceil(list.length/size),p=Math.max(0,Math.min(Number(page)||0,total-1)),items=list.slice(p*size,p*size+size);let out='<b>📜 پیام‌های کاربر</b>\\n\\n👤 '+safe(u.name||'کاربر')+'\\n🆔 <code>'+safe(userId)+'</code>\\n📄 صفحه '+(p+1)+'/'+total+'\\n\\n';for(const [i,x] of items.entries()){out+=(p*size+i+1)+'. <b>'+safe(new Date(x.at).toLocaleString('fa-IR'))+'</b> | '+safe(x.summary||x.type||'پیام')+'\\n';if(x.text)out+='↳ '+safe(x.text.slice(0,500))+'\\n';out+='\\n';}const nav=[];if(p>0)nav.push({text:'⬅️ قبلی',callback_data:'user_history:'+userId+':'+(p-1)});if(p<total-1)nav.push({text:'بعدی ➡️',callback_data:'user_history:'+userId+':'+(p+1)});const rows=[];if(nav.length)rows.push(nav);for(let i=0;i<items.length;i++)rows.push([{text:'👁 پیام '+(p*size+i+1),callback_data:'user_message:'+userId+':'+(p*size+i)}]);rows.push([{text:'↩️ پیام‌های کاربران',callback_data:'admin_user_history'}]);return send(chatId,out,{reply_markup:{inline_keyboard:rows}});}\nasync function __showUserMessage(chatId,userId,index){const u=users.get(String(userId)),x=u?.messages?.[Number(index)];if(!u||!x)return send(chatId,'❌ پیام پیدا نشد.',{reply_markup:adminUsers()});const back={reply_markup:{inline_keyboard:[[{text:'↩️ تاریخچه کاربر',callback_data:'user_history:'+userId+':'+Math.floor(Number(index)/8)}]]}};try{await copyMessage(chatId,x.chatId||u.chatId,x.messageId,back);}catch(e){await send(chatId,'⚠️ این پیام دیگر از تلگرام قابل کپی نیست.\\n\\n'+safe(x.text||x.summary||'پیام رسانه‌ای'),back);}}\n`;
  bot = bot.replace('function messageSummary(m){', helper + 'function messageSummary(m){');
}

// Add history to the admin user menus.
bot = bot.replace(
  /const adminUsers=\(\)=>\(\{inline_keyboard:\[\[\{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'\}\],\[\{text:'↩️ پنل مدیر',callback_data:'admin_home'\}\]\]\}\);/,
  "const adminUsers=()=>({inline_keyboard:[[{text:'🔎 جستجوی کاربر با ID',callback_data:'user_lookup'}],[{text:'📜 پیام‌های کاربران',callback_data:'admin_user_history'}],[{text:'↩️ پنل مدیر',callback_data:'admin_home'}]]});"
);

// Add a history button to each user card when possible.
bot = bot.replace(
  /const userKeyboard=id=>\(\{inline_keyboard:\[\[\{text:'👤 اطلاعات',callback_data:`user_info:\$\{id\}`\}\],\[\{text:'🟢 اعطای دسترسی',callback_data:`grant:\$\{id\}`\},\{text:'🔴 لغو',callback_data:`revoke:\$\{id\}`\}\],\[\{text:'📥 رسیدها',callback_data:`user_receipts:\$\{id\}`\}\],\[\{text:'🔗 ارسال دسترسی',callback_data:`user_link:\$\{id\}`\}\],\[\{text:'↩️ کاربران',callback_data:'admin_users'\}\]\]\}\);/,
  "const userKeyboard=id=>({inline_keyboard:[[{text:'👤 اطلاعات',callback_data:`user_info:${id}`}],[{text:'📜 پیام‌های کاربر',callback_data:`user_history:${id}:0`}],[{text:'🟢 اعطای دسترسی',callback_data:`grant:${id}`},{text:'🔴 لغو',callback_data:`revoke:${id}`}],[{text:'📥 رسیدها',callback_data:`user_receipts:${id}`}],[{text:'🔗 ارسال دسترسی',callback_data:`user_link:${id}`}],[{text:'↩️ کاربران',callback_data:'admin_users'}]]});"
);

// Handle history buttons before the existing callback switch.
const callbackNeedle = "const action=String(q.data||''),from=q.from;try";
if (bot.includes(callbackNeedle)) {
  bot = bot.replace(callbackNeedle,"const action=String(q.data||''),from=q.from;try{if(action==='admin_user_history'&&canAdmin(from))return __showHistoryUsers(chatId);if(action.startsWith('user_history:')&&canAdmin(from)){const z=action.split(':');return __showUserHistory(chatId,z[1],z[2]||0);}if(action.startsWith('user_message:')&&canAdmin(from)){const z=action.split(':');return __showUserMessage(chatId,z[1],z[2]||0);");
}

// Manager/ownership ID entry: edit the existing panel message instead of sending a new one.
bot = bot.replace(
  /async function handleMessage\(m,queued=false\)\{if\(!botEnabled\)\{try\{await send\(m\.chat\.id,'⚠️ <b>بات در حال حاضر خاموش است\.<\/b>[\s\S]*?getOrCreateUser\(m\);__recordUserHistory\(m\);/,
  m => m
);

// Keep the webhook receiver and configure it without the old cold-start outage message.
bot = bot.replace(
  /let coldStart=true;global\.__(?:behnazTelegramUpdate) = async u=>\{[\s\S]*?\};\s*\}/,
  "global.__behnazTelegramUpdate=async u=>{if(!u)return;try{if(u.callback_query)await handleCallback(u.callback_query);else if(u.message)await handleMessage(u.message);}catch(e){console.error('[telegram] webhook update:',e.message);}};"
);

// If startup was previously rewritten, remove the cold-start notice from it.
bot = bot.replace("let coldStart=true;",'');
bot = bot.replace(/if\(coldStart&&chatId\)\{[\s\S]*?\}\s*/,'');

fs.writeFileSync(botFile, bot);
console.log('[telegram] admin controls/history patch applied');
require('./server.js');
