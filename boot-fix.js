const fs = require('fs');
const path = require('path');

const botFile = path.join(__dirname, 'bot.js');
let bot = fs.readFileSync(botFile, 'utf8');

// Keep the configured admin usable without overriding a transferred owner.
if (!bot.includes('const isConfiguredAdmin = u =>')) {
  bot = bot.replace(
    'const canAdmin = u => isOwner(u) || isManager(u);',
    "const isConfiguredAdmin = u => Boolean(u?.username && String(u.username).toLowerCase() === ADMIN_USERNAME);\n  const canAdmin = u => isOwner(u) || isManager(u) || isConfiguredAdmin(u);"
  );
}

// IMPORTANT: bot.js is heavily minified. Do not depend on newlines in regexes.
// Every incoming Telegram update must wake the bot before any botEnabled guard.
if (!bot.includes("auto-enabled by incoming message")) {
  bot = bot.replace(
    /async function handleMessage\(m\)\s*\{/,
    "async function handleMessage(m){ if(!botEnabled){ botEnabled=true; saveState(); console.log('[telegram] auto-enabled by incoming message'); }"
  );
}
if (!bot.includes("auto-enabled by incoming button")) {
  bot = bot.replace(
    /async function handleCallback\(q\)\s*\{/,
    "async function handleCallback(q){ if(!botEnabled){ botEnabled=true; saveState(); console.log('[telegram] auto-enabled by incoming button'); }"
  );
}

// Disable ALL getUpdates polling. Telegram must deliver updates through the webhook.
bot = bot.replace(
  /async function poll\(\)\{[\s\S]*?\}\s*async function startup\(\)/,
  "async function poll(){ return; } async function startup()"
);

// Expose handlers to the HTTP webhook exactly once.
if (!bot.includes('global.__behnazTelegramUpdate')) {
  bot = bot.replace(
    /async function startup\(\)\s*\{/,
    "global.__behnazTelegramUpdate = async u => { try { if (u?.callback_query) await handleCallback(u.callback_query); else if (u?.message) await handleMessage(u.message); } catch(e) { console.error('[telegram] webhook update error:', e.message); } }; async function startup(){"
  );
}

// Replace the original startup body regardless of minification/newline layout.
bot = bot.replace(
  /async function startup\(\)\{[\s\S]*?\}\s*process\.once\(['\"]SIGTERM['\"]/, 
  "async function startup(){ loadState(); try { const base=String(process.env.RENDER_EXTERNAL_URL || 'https://behnazrostami.onrender.com').replace(/\\/$/,''); await telegram('deleteWebhook',{drop_pending_updates:false}).catch(()=>{}); await telegram('setWebhook',{url:base+'/telegram/webhook',allowed_updates:['message','callback_query'],drop_pending_updates:false}); console.log('[telegram] webhook enabled: '+base+'/telegram/webhook'); const me=await telegram('getMe'); console.log('[telegram] bot connected: @'+(me.username||me.first_name)); } catch(e) { console.error('[telegram] webhook startup:',e.message); } if(botEnabled) await processOffline(); } process.once('SIGTERM'"
);

const serverFile = path.join(__dirname, 'server.js');
let server = fs.readFileSync(serverFile, 'utf8');
if (!server.includes("app.post('/telegram/webhook'")) {
  const route = `\n\napp.post('/telegram/webhook', express.json({ limit: '2mb' }), async (req, res) => {\n  try {\n    if (typeof global.__behnazTelegramUpdate === 'function') await global.__behnazTelegramUpdate(req.body);\n    res.sendStatus(200);\n  } catch (e) {\n    console.error('[telegram] webhook handler:', e.message);\n    res.sendStatus(500);\n  }\n});\n`;
  const marker = "const PORT = process.env.PORT || 10000;";
  if (server.includes(marker)) server = server.replace(marker, marker + route);
  else server += route;
  fs.writeFileSync(serverFile, server);
}

fs.writeFileSync(botFile, bot);
require('./server.js');
