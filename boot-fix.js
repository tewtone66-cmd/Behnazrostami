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

// A message or inline-button press must wake the bot immediately.
if (!bot.includes('[telegram] auto-enabled by incoming update')) {
  bot = bot.replace(
    /async function handleMessage\(m\)\{/,
    "async function handleMessage(m){ if(!botEnabled){ botEnabled=true; saveState(); console.log('[telegram] auto-enabled by incoming message'); }"
  );
  bot = bot.replace(
    /async function handleCallback\(q\)\{/,
    "async function handleCallback(q){ if(!botEnabled){ botEnabled=true; saveState(); console.log('[telegram] auto-enabled by incoming button'); }"
  );
}

// Stop duplicate polling loops by making the existing poll function a no-op.
bot = bot.replace(/async function poll\(\)\{[\s\S]*?\n  \}\n  async function startup\(\)/, "async function poll(){ return; }\n  async function startup()" );

// Register the webhook before bot startup. This guarantees Telegram delivers
// updates even if the old polling code exists elsewhere in the bot source.
const serverFile = path.join(__dirname, 'server.js');
let server = fs.readFileSync(serverFile, 'utf8');
if (!server.includes("app.post('/telegram/webhook'")) {
  const route = `\n\napp.post('/telegram/webhook', express.json({ limit: '2mb' }), async (req, res) => {\n  try {\n    if (typeof global.__behnazTelegramUpdate === 'function') await global.__behnazTelegramUpdate(req.body);\n    res.sendStatus(200);\n  } catch (e) {\n    console.error('[telegram] webhook handler:', e.message);\n    res.sendStatus(500);\n  }\n});\n`;
  server = server.replace("const PORT = process.env.PORT || 10000;", "const PORT = process.env.PORT || 10000;" + route);
  fs.writeFileSync(serverFile, server);
}

// Expose the existing handlers to the webhook without changing bot.js permanently.
if (!bot.includes('global.__behnazTelegramUpdate')) {
  bot = bot.replace(
    /async function startup\(\)\{/,
    "global.__behnazTelegramUpdate = async u => { offset = Number(u?.update_id || 0) + 1; try { if (u?.callback_query) await handleCallback(u.callback_query); else if (u?.message) await handleMessage(u.message); } catch(e) { console.error('[telegram] webhook update error:', e.message); } };\n  async function startup(){"
  );
}

// The bot file itself still performs startup. Make its startup non-destructive:
// webhook is configured first and pending updates are preserved.
bot = bot.replace(
  /async function startup\(\)\{[\s\S]*?\n  \}\n  process\.once\('SIGTERM'/,
  `async function startup(){\n    loadState();\n    try {\n      const base = String(process.env.RENDER_EXTERNAL_URL || 'https://behnazrostami.onrender.com').replace(/\\/$/, '');\n      await telegram('setWebhook',{url:base+'/telegram/webhook',allowed_updates:['message','callback_query'],drop_pending_updates:false});\n      console.log('[telegram] webhook enabled: '+base+'/telegram/webhook');\n      const me=await telegram('getMe');\n      console.log(\`[telegram] bot connected: @\${me.username||me.first_name}\`);\n    } catch(e) { console.error('[telegram] webhook startup:',e.message); }\n    if(botEnabled) await processOffline();\n  }\n  process.once('SIGTERM'`
);

fs.writeFileSync(botFile, bot);
require('./server.js');
