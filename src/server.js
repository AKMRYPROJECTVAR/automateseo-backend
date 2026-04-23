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

// Scrape website
function scrapeWebsite(url) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(''), 8000);
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutomateSEOBot/1.0)', 'Accept': 'text/html' },
      timeout: 8000
    }, (res) => {
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
        const text = data
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
          .trim().substring(0, 8000);
        resolve(text);
      });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(''); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve(''); });
  });
}

// ── Stripe checkout ──────────────────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { websiteUrl, email } = req.body;
    if (!websiteUrl || !email) return res.status(400).json({ error: 'websiteUrl and email required' });
    const session = await createCheckoutSession(email, websiteUrl);
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Analyse website ──────────────────────────────────────────────────────────
app.post('/api/analyse-website', async (req, res) => {
  try {
    const { websiteUrl } = req.body;
    if (!websiteUrl) return res.status(400).json({ error: 'websiteUrl required' });
    let scrapedText = '';
    try {
      const urlToScrape = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl;
      scrapedText = await scrapeWebsite(urlToScrape);
    } catch(e) { console.log('Scrape failed:', e.message); }
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = scrapedText
      ? 'Analyse this business website: ' + websiteUrl + '\n\nScraped content:\n---\n' + scrapedText + '\n---\n\nReturn ONLY a JSON object with: description (2-3 sentence description from real content), services (array of 5 specific services they actually offer), exclusions (array of 2-3 things they do NOT offer), competitors (array of 3 objects with {domain, desc}). No markdown.'
      : 'Analyse this business website: ' + websiteUrl + '. Return ONLY JSON with: description, services (5 items), exclusions (3 items), competitors (3 objects with domain and desc). No markdown.';
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (err) { console.error('Analyse error:', err.message); res.status(500).json({ error: err.message }); }
});

// ── Save onboarding data ─────────────────────────────────────────────────────
app.post('/api/onboarding', async (req, res) => {
  try {
    const { supabase } = require('./supabase');
    const data = req.body;
    if (!data.websiteUrl) return res.status(400).json({ error: 'websiteUrl required' });
    await supabase.from('clients').upsert({
      email: data.email || ('pending_' + Date.now() + '@automateseo.com.au'),
      website_url: data.websiteUrl,
      brand_name: data.brandName || null,
      language: data.language || 'en-AU',
      country: data.country || 'AU',
      target_cities: data.targetCities || null,
      business_description: data.businessDesc || null,
      exclusions: data.exclusions || [],
      services: data.services || [],
      priority_service: data.priorityService || null,
      competitors: data.competitors || [],
      status: 'pending'
    }, { onConflict: 'email' });
    res.json({ success: true });
  } catch (err) { console.error('Onboarding error:', err.message); res.status(500).json({ error: err.message }); }
});

// ── Save CMS credentials ─────────────────────────────────────────────────────
app.post('/api/connect-cms', async (req, res) => {
  try {
    const { supabase } = require('./supabase');
    const { email, cms_type, wordpress_url, wordpress_username, wordpress_app_password, shopify_domain, shopify_access_token } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const updateData = { cms_type: cms_type || 'none' };
    if (cms_type === 'wordpress') {
      updateData.wordpress_url = wordpress_url;
      updateData.wordpress_username = wordpress_username;
      updateData.wordpress_app_password = wordpress_app_password;
    } else if (cms_type === 'shopify') {
      updateData.shopify_domain = shopify_domain;
      updateData.shopify_access_token = shopify_access_token;
    }
    const { error } = await supabase.from('clients').update(updateData).eq('email', email);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { console.error('Connect CMS error:', err.message); res.status(500).json({ error: err.message }); }
});

// ── Get client dashboard data ────────────────────────────────────────────────
app.get('/api/dashboard/:email', async (req, res) => {
  try {
    const { supabase } = require('./supabase');
    const email = decodeURIComponent(req.params.email);
    const { data: client, error: clientErr } = await supabase.from('clients').select('*').eq('email', email).single();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });
    const { data: articles } = await supabase.from('articles').select('id, title, keyword, status, word_count, published_at, published_url, created_at').eq('client_id', client.id).order('created_at', { ascending: false }).limit(50);
    res.json({ client: { id: client.id, email: client.email, website_url: client.website_url, brand_name: client.brand_name, status: client.status, cms_type: client.cms_type || 'none', created_at: client.created_at }, articles: articles || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stripe webhook ───────────────────────────────────────────────────────────
app.post('/webhook/stripe', async (req, res) => {
  try { await handleStripeWebhook(req, res); } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Get articles for client ──────────────────────────────────────────────────
app.get('/api/articles/:clientId', async (req, res) => {
  try {
    const { supabase } = require('./supabase');
    const { data, error } = await supabase.from('articles').select('*').eq('client_id', req.params.clientId).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    res.json({ articles: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Manual trigger ───────────────────────────────────────────────────────────
app.post('/api/trigger-articles', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ message: 'Article generation started' });
  generateDailyArticles().catch(console.error);
});


// ── Trigger article for one specific client ──────────────────────────────────
app.post('/api/trigger-one', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    const { supabase } = require('./supabase');
    const { data: client, error } = await supabase.from('clients').select('*').eq('id', clientId).single();
    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Article generation started for ' + client.email });
    const { generateArticleForClient } = require('./articleGenerator');
    generateArticleForClient(client).catch(console.error);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Test WordPress credentials ────────────────────────────────────────────────
app.post('/api/test-wp', async (req, res) => {
  const { wordpress_url, wordpress_username, wordpress_app_password } = req.body;
  if (!wordpress_url || !wordpress_username || !wordpress_app_password) {
    return res.status(400).json({ error: 'wordpress_url, wordpress_username, wordpress_app_password required' });
  }
  const https = require('https');
  const http = require('http');
  let baseUrl = wordpress_url.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  baseUrl = baseUrl.replace(/\/$/, '');
  const credentials = Buffer.from(wordpress_username.trim() + ':' + wordpress_app_password.trim()).toString('base64');

  // First check if WP REST API is reachable
  const checkUrl = baseUrl + '/wp-json/wp/v2/users/me';
  const parsedUrl = new URL(checkUrl);
  const proto = parsedUrl.protocol === 'https:' ? https : http;

  const result = await new Promise((resolve) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + credentials, 'User-Agent': 'AutomateSEO/1.0' },
      timeout: 10000
    };
    const req = proto.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (response.statusCode === 200) {
            resolve({ success: true, user: parsed.name, roles: parsed.roles, capabilities: Object.keys(parsed.capabilities || {}).slice(0, 5) });
          } else {
            resolve({ success: false, status: response.statusCode, error: parsed.message || parsed.code || 'auth_failed' });
          }
        } catch(e) {
          resolve({ success: false, error: 'parse_error', raw: data.substring(0, 200) });
        }
      });
    });
    req.on('error', e => resolve({ success: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
    req.end();
  });

  res.json(result);
});

// ── Daily cron 9am AEST (11pm UTC) ──────────────────────────────────────────
cron.schedule('0 23 * * *', () => {
  console.log('Running daily article generation...');
  generateDailyArticles().catch(console.error);
}, { timezone: 'UTC' });

app.listen(PORT, () => console.log('AutomateSEO backend running on port ' + PORT));
