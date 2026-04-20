require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { handleStripeWebhook, createCheckoutSession } = require('./stripe');
const { generateDailyArticles } = require('./articleGenerator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

app.get('/', (req, res) => res.json({ status: 'AutomateSEO backend running', time: new Date().toISOString() }));

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { websiteUrl, email } = req.body;
    if (!websiteUrl || !email) return res.status(400).json({ error: 'websiteUrl and email required' });
    const session = await createCheckoutSession(email, websiteUrl);
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook/stripe', async (req, res) => {
  try { await handleStripeWebhook(req, res); }
  catch (err) { res.status(400).json({ error: err.message }); }
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