require('dotenv').config();
const axios = require('axios');

async function sendDiscord(groupName, postUrl, summary, matchedKeywords) {
  if (!process.env.DISCORD_WEBHOOK_URL) return;

  const keywords = Array.isArray(matchedKeywords)
    ? matchedKeywords.map(k => (typeof k === 'string' ? k : k.keyword)).join(', ')
    : matchedKeywords;

  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, {
      embeds: [{
        title: '🎯 Keyword Match Found',
        color: 0xFF6B00,
        fields: [
          { name: '📌 Group', value: groupName || 'Unknown Group', inline: false },
          { name: '🔑 Keywords', value: keywords, inline: true },
          { name: '🔗 Post Link', value: postUrl, inline: false },
          { name: '📝 Summary', value: summary, inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'FB Group Monitor' }
      }]
    }, { timeout: 8000 });
  } catch (e) {
    console.error('Discord notification failed:', e.message);
  }
}

async function sendTelegram(groupName, postUrl, summary, matchedKeywords) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

  const keywords = Array.isArray(matchedKeywords)
    ? matchedKeywords.map(k => (typeof k === 'string' ? k : k.keyword)).join(', ')
    : matchedKeywords;

  const message = `🎯 <b>Keyword Match Found</b>\n\n📌 <b>Group:</b> ${groupName}\n🔑 <b>Keywords:</b> ${keywords}\n📝 <b>Summary:</b> ${summary}\n\n🔗 <a href="${postUrl}">View Post</a>`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: false },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error('Telegram notification failed:', e.message);
  }
}

async function sendAlert(message) {
  // Discord alert
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await axios.post(process.env.DISCORD_WEBHOOK_URL, {
        embeds: [{
          title: '⚠️ Monitor Alert',
          description: message,
          color: 0xFF0000,
          timestamp: new Date().toISOString(),
          footer: { text: 'FB Group Monitor' }
        }]
      }, { timeout: 8000 });
    } catch {}
  }

  // Telegram alert
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { chat_id: process.env.TELEGRAM_CHAT_ID, text: `⚠️ Monitor Alert\n\n${message}`, parse_mode: 'HTML' },
        { timeout: 8000 }
      );
    } catch {}
  }
}

async function sendSessionExpiredAlert(dashUrl) {
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await axios.post(process.env.DISCORD_WEBHOOK_URL, {
        embeds: [{
          title: '🍪 Facebook Session Expired',
          description: `Cookies are no longer valid — Lead Sniper is paused.\n\nRefresh cookies in the dashboard: ${dashUrl}`,
          color: 0xFF0000,
          timestamp: new Date().toISOString(),
          footer: { text: 'FB Group Monitor' }
        }]
      }, { timeout: 8000 });
    } catch {}
  }

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `🍪 <b>Facebook session expired!</b>\n\nLead Sniper is paused — cookies need refreshing.\n\nTap the button below to auto-grab fresh cookies from Chrome on the mini PC, or paste them manually in the <a href="${dashUrl}">dashboard</a>.`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '🍪 Refresh Cookies Now', callback_data: 'refresh_cookies' }
            ]]
          }
        },
        { timeout: 8000 }
      );
    } catch {}
  }
}

module.exports = { sendDiscord, sendTelegram, sendAlert, sendSessionExpiredAlert };
