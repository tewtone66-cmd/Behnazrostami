const fs = require('fs');
const path = require('path');
const https = require('https');

const botFile = path.join(__dirname, 'bot.js');
let bot = fs.readFileSync(botFile, 'utf8');

// Preserve configured admin access.
if (!bot.includes('const isConfiguredAdmin = u =>')) {
  bot = bot.replace(
    'const canAdmin = u => isOwner(u) || isManager(u);',
    "const isConfiguredAdmin = u => Boolean(u?.username && String(u.username).toLowerCase() === ADMIN_USERNAME);\n  const canAdmin = u => isOwner(u) || isManager(u) || isConfiguredAdmin(u);"
  );
}

// The Telegram receiver must NEVER stop when botEnabled=false.
// The first incoming message/button wakes the logical bot and then continues normally.
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

// Remove only the old webhook bridge. Keep the original polling receiver.
bot = bot.replace(/global\.__behnazTelegramUpdate\s*=\s*async u => \{[\s\S]*?\};\s*/g, '');
fs.writeFileSync(botFile, bot);

// Telegram does not allow getUpdates polling while a webhook is configured.
// Clear the old webhook before loading the original bot.
const token = process.env.BOT_TOKEN;
function clearWebhook() {
  if (!token) return Promise.resolve();
  return new Promise(resolve => {
    const url = new URL(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);
    https.get(url, { family: 4, timeout: 10000 }, res => { res.resume(); res.on('end', resolve); }).on('error', resolve).on('timeout', resolve);
  });
}

clearWebhook().finally(() => require('./server.js'));
