require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const https = require('https');
const http = require('http');
const { handleStripeWebhook, createCheckoutSession } = require('./stripe');
const { generateDailyArticles } = require('./articleGenerator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

app.get('/', (req, res) => res.json({ status: 'AutomateSEO backend running', time: new Date().toISOString() }));

// Scrape a website and return its text content
function scrapeWebsite(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(''), 8000);
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (compatible; AutomateSEOBot/1.0)',
        'Accept': 'text/html'
      },
      timeout: 8000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        const redirectUrl = res.headers.location.startsWith('http') ? res.headers.location : url + res.headers.location;
        scrapeWebsite(redirectUrl).then(resolve).catch(() => resolve(''));
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 100000) req.destroy(); });
      res.on('end', () => {
        clearTimeout(timeout);
        // Strip HTML tags and extract readable text
        const text = data
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .replace(/&#[0-9]+;/g, '')
          .trim()
          .substring(0, 8000);
        resolve(text);
      });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(''); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve(''); });
  });
}

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { websiteUrl, email } = req.body;
    if (!websiteUrl || !email) return res.status(400).json({ error: 'websiteUrl and email required' });
    const session = await createCheckoutSession(email, websiteUrl);
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/analyse-website', async (req, res) => {
  try {
    const { websiteUrl } = req.body;
    if (!websiteUrl) return res.status(400).json({ error: 'websiteUrl required' });

    // Scrape the website first
    let scrapedText = '';
    try {
      const urlToScrape = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl;
      scrapedText = await scrapeWebsite(urlToScrape);
    } catch(e) { console.log('Scrape failed:', e.message); }

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = scrapedText
      ? `Analyse this business website: ${websiteUrl}

Here is the actual scraped content from their website:
---
${scrapedText}
---

Based on this REAL content, return ONLY a JSON object with:
- description: A 2-3 sentence description of what this business actually does (use specific details from the scraped content)
- services: Array of 5 specific services/products they actually offer (from the scraped content)
- exclusions: Array of 2-3 related things they do NOT offer (infer from their niche)
- competitors: Array of 3 objects with {domain, desc} of real competitors in their specific industry

Return ONLY valid JSON, no markdown.`
      : `Analyse this business website: ${websiteUrl}

I could not scrape the site. Based on the domain name and URL, make your best guess and return ONLY a JSON object with:
- description: A 2-3 sentence description of what this business likely does
- services: Array of 5 likely services/products
- exclusions: Array of 2-3 things they likely do NOT offer
- competitors: Array of 3 objects with {domain, desc}

Return ONLY valid JSON, no markdown.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (err) {
    console.error('Analyse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/onboarding', async (req, res) => {
  try {
    const { supabase } = require('./supabase');
    const data = req.body;
    if (!data.websiteUrl) return res.status(400).json({ error: 'websiteUrl required' });
    await supabase.from('clients').upsert({
      email: data.email || ('pending_' + Date.now() + '@automateseo.com.au'),
      website_url: data.websiteUrl,
      status: 'pending'
    }, { onConflict: 'email' });
    res.json({ success: true });
  } catch (err) { console.error('Onboarding error:', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/webhook/stripe', async (req, res) => {
  try { await handleStripeWebhook(req, res); } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/articles/:clientId', async (req, res) => {
  try {
    const { supabase } = require('./supabase');
    const { data, error } = await supabase.from('articles').select('*')
      .eq('client_id', req.params.clientId).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    res.json({ articles: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/trigger-articles', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ message: 'Article generation started' });
  generateDailyArticles().catch(console.error);
});

cron.schedule('0 23 * * *', () => {
  console.log('Running daily article generation...');
  generateDailyArticles().catch(console.error);
}, { timezone: 'UTC' });

app.listen(PORT, () => console.log('AutomateSEO backend running on port ' + PORT));
