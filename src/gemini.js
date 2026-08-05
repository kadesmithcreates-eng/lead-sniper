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

  const prompt = `You are an assistant helping a diesel truck parts dealer monitor Facebook groups.
They want notifications when someone is looking to buy, asking about, or actively discussing parts related to these keywords: ${keywordList}

Here is the Facebook post:
"""
${postText.slice(0, 700)}
"""

Decide:
1. Is this post genuinely relevant? (Someone buying, selling, asking for help, or actively discussing these parts — not just a random mention)
2. If yes, write ONE concise sentence explaining why it's relevant and what the person needs.

Reply with valid JSON only, no markdown:
{"relevant": true/false, "summary": "one sentence here"}`;

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
