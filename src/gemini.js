require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

async function filterAndSummarize(postText, matchedKeywords, postTs = null) {
  if (!ai) {
    return {
      relevant: true,
      summary: `Post matched keywords: ${matchedKeywords.map(k => k.keyword).join(', ')}`
    };
  }

  const keywordList = matchedKeywords.map(k => k.keyword).join(', ');

  let ageContext = '';
  if (postTs) {
    const daysOld = Math.floor((Date.now() - postTs) / (1000 * 60 * 60 * 24));
    ageContext = `\nPost age: ${daysOld === 0 ? 'today' : daysOld === 1 ? '1 day ago' : `${daysOld} days ago`}`;
  }

  const prompt = `You are filtering Facebook posts for a diesel truck tuning and delete kit business. They ONLY want leads — people who need to hire someone or buy something.

Keywords that triggered this post: ${keywordList}${ageContext}

Post:
"""
${postText.slice(0, 700)}
"""

Mark relevant=true if the post shows someone who:
- Is looking for a shop, tuner, or installer to do delete/tune work on their truck
- Is asking for a price, quote, or recommendation for these services
- Wants to BUY a tune, delete kit, or related part
- Is asking "who does X", "where can I get X done", "anyone know a good tuner", "looking for someone to"
- Is asking a question that clearly shows they want to find and pay someone (even if not stated directly)

Mark relevant=false if the post is:
- Someone showing off or bragging about work already completed
- A dumb or generic curiosity question ("what is a DPF delete", "is deleting worth it", "how does EGR work")
- General discussion, news, memes, videos, or article shares
- Someone selling the same products (competitor post)
- A casual mention of the keyword with no buying intent
- A technical question where they just want info, not a service provider
- Anything older than 5 days (stale lead, not worth it)

Be strict. When in doubt, mark false.

Reply with valid JSON only, no markdown:
{"relevant": true/false, "summary": "one sentence — what they need and where they are if mentioned${postTs ? '. Start the summary with the post age like: 4 days old —' : ''}"}`;

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
