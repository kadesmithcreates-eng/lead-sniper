require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

async function filterAndSummarize(postText, matchedKeywords) {
  if (!ai) {
    return {
      relevant: true,
      summary: `Post matched keywords: ${matchedKeywords.map(k => k.keyword).join(', ')}`
    };
  }

  const keywordList = matchedKeywords.map(k => k.keyword).join(', ');

  const prompt = `You are filtering Facebook posts for a diesel truck tuning and delete kit business. They ONLY want leads — people who need to hire someone or buy something RIGHT NOW.

Keywords that triggered this post: ${keywordList}

Post:
"""
${postText.slice(0, 700)}
"""

Mark relevant=true ONLY if the post clearly shows someone who:
- Is looking for a shop, tuner, or installer to do delete/tune work on their truck
- Is asking for a price, quote, or recommendation for these services
- Wants to BUY a tune, delete kit, or related part
- Is asking "who does X" or "where can I get X done"

Mark relevant=false if the post is:
- Someone showing off or bragging about work already completed
- General discussion, news, or information about these topics
- A meme, video, or article share
- Someone selling the same products (competitor post)
- A casual mention of the keyword with no buying intent
- Asking a technical question (not looking to hire anyone)
- Anything where the person is NOT actively seeking to spend money

Be strict. When in doubt, mark false. A false negative (missing a lead) is better than a false positive (spamming the client).

Reply with valid JSON only, no markdown:
{"relevant": true/false, "summary": "one sentence — what they need and where they are if mentioned"}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: prompt,
    });
    const text = response.text.trim();
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) return JSON.parse(match[0]);
    return { relevant: true, summary: `Matched: ${keywordList}` };
  } catch {
    return { relevant: true, summary: `Matched keywords: ${keywordList}` };
  }
}

module.exports = { filterAndSummarize };
