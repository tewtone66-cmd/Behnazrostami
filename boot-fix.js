const fs = require('fs');
const path = require('path');

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

// IMPORTANT: keep the original polling receiver. The previous webhook experiment
// caused Telegram update delivery to fail; polling is the bot's proven receiver.
// Remove only any webhook-specific runtime patch that an older boot-fix may have left.
bot = bot.replace(/global\.__behnazTelegramUpdate\s*=\s*async u => \{[\s\S]*?\};\s*/g, '');

fs.writeFileSync(botFile, bot);
require('./server.js');
