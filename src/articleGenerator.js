const Anthropic = require('@anthropic-ai/sdk');
const { supabase } = require('./supabase');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateDailyArticles() {
  const { data: clients, error } = await supabase.from('clients').select('*').in('status', ['active', 'trial']);
  if (error) return console.error('Failed to fetch clients:', error);
  console.log('Generating articles for ' + clients.length + ' clients');
  for (const client of clients) {
    try { await generateArticleForClient(client); await sleep(2000); }
    catch (err) { console.error('Failed for ' + client.email + ':', err.message); }
  }
  console.log('Daily article generation complete');
}

async function generateArticleForClient(client) {
  const topicRes = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 500,
    messages: [{ role: 'user', content: 'You are an SEO strategist. Website: ' + client.website_url + '. Suggest the single best SEO blog topic for today. JSON only: {"topic":"...","keyword":"...","intent":"...","word_count_target":1800}' }]
  });
  let topic;
  try { topic = JSON.parse(topicRes.content[0].text.replace(/```json|```/g, '').trim()); }
  catch { topic = { topic: 'SEO Guide for Your Business', keyword: 'SEO tips', intent: 'help rank', word_count_target: 1800 }; }

  const articleRes = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514', max_tokens: 4000,
    messages: [{ role: 'user', content: 'Write a professional 1800-word SEO article for ' + client.website_url + '. Title: ' + topic.topic + '. Keyword: "' + topic.keyword + '". Australian English. Use H2/H3 in markdown. Expert tone, no fluff. Start with H1 title.' }]
  });

  const content = articleRes.content[0].text;
  const { error } = await supabase.from('articles').insert({ client_id: client.id, title: topic.topic, keyword: topic.keyword, content, status: 'ready', word_count: content.split(' ').length, website_url: client.website_url });
  if (error) throw error;
  console.log('Article saved for ' + client.website_url);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
module.exports = { generateDailyArticles, generateArticleForClient };