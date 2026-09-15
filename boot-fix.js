const fs = require('fs');
const path = require('path');

const botFile = path.join(__dirname, 'bot.js');
let bot = fs.readFileSync(botFile, 'utf8');

const adminPatch = "const isConfiguredAdmin = u => Boolean(u?.username && String(u.username).toLowerCase() === ADMIN_USERNAME);\n  const canAdmin = u => isOwner(u) || isManager(u) || isConfiguredAdmin(u);";
if (!bot.includes('const isConfiguredAdmin = u =>')) {
  bot = bot.replace("const canAdmin = u => isOwner(u) || isManager(u);", adminPatch);
}
bot = bot.replace(
  "const chatId=String(m.chat.id),text=String(m.text||'').trim(),admin=canAdmin(m.from),owner=isOwner(m.from);",
  "const chatId=String(m.chat.id),text=String(m.text||'').trim(); if(isConfiguredAdmin(m.from) && !ownerId){ownerId=String(m.from.id);saveState();} const admin=canAdmin(m.from),owner=isOwner(m.from);"
);
bot = bot.replace(
  "const chatId=String(q.message.chat.id),action=String(q.data||''),from=q.from;try",
  "const chatId=String(q.message.chat.id),action=String(q.data||''),from=q.from; if(isConfiguredAdmin(from) && !ownerId){ownerId=String(from.id);saveState();} try"
);

if (!bot.includes('global.__behnazTelegramUpdate')) {
  bot = bot.replace(
    "\n  async function poll(){while(!stopped){",
    "\n  global.__behnazTelegramUpdate = async u => {\n    offset = Number(u?.update_id || 0) + 1;\n    saveState();\n    try {\n      if (u?.callback_query) await handleCallback(u.callback_query);\n      else if (u?.message) await handleMessage(u.message);\n    } catch (e) {\n      console.error('[telegram] webhook update error:', e.message);\n    }\n  };\n\n  async function poll(){return;}\n  async function legacyPollDisabled(){while(!stopped){"
  );
  bot = bot.replace(/  async function legacyPollDisabled\(\)\{while\(!stopped\)\{[\s\S]*?\n  \}\n  async function startup\(\)/, "  async function startup()" );
}

bot = bot.replace(
  /  async function startup\(\)\{[\s\S]*?\n  \}\n  process\.once\('SIGTERM'/,
  `  async function startup(){\n    loadState();\n    try {\n      const base = String(process.env.RENDER_EXTERNAL_URL || 'https://behnazrostami.onrender.com').replace(/\\/$/, '');\n      await telegram('setWebhook',{url: base + '/telegram/webhook', allowed_updates:['message','callback_query'], drop_pending_updates:false});\n      console.log('[telegram] webhook enabled: ' + base + '/telegram/webhook');\n    } catch(e) {\n      console.error('[telegram] setWebhook:',e.message);\n    }\n    try {\n      const me=await telegram('getMe');\n      console.log(\`[telegram] bot connected: @\${me.username||me.first_name}\`);\n    } catch(e) {\n      console.error('[telegram] getMe failed:',e.message);\n    }\n    if(botEnabled) await processOffline();\n  }\n  process.once('SIGTERM'`
);

fs.writeFileSync(botFile, bot);

const serverFile = path.join(__dirname, 'server.js');
let server = fs.readFileSync(serverFile, 'utf8');
if (!server.includes("app.post('/telegram/webhook'")) {
  const route = `\n\napp.post('/telegram/webhook', express.json({ limit: '2mb' }), async (req, res) => {\n  try {\n    if (typeof global.__behnazTelegramUpdate === 'function') await global.__behnazTelegramUpdate(req.body);\n    res.sendStatus(200);\n  } catch (e) {\n    console.error('[telegram] webhook handler:', e.message);\n    res.sendStatus(500);\n  }\n});\n`;
  server = server.replace("const PORT = process.env.PORT || 10000;", "const PORT = process.env.PORT || 10000;" + route);
  fs.writeFileSync(serverFile, server);
}

require('./server.js');
