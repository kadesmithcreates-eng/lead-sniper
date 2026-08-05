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

module.exports = { sendDiscord, sendTelegram, sendAlert };
