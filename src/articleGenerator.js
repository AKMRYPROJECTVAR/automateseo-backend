const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── WordPress Publisher ────────────────────────────────────────────────────
async function publishToWordPress(client, title, content, excerpt) {
  const { wordpress_url, wordpress_username, wordpress_app_password } = client;
  if (!wordpress_url || !wordpress_username || !wordpress_app_password) {
    return { success: false, reason: 'no_wp_credentials' };
  }

  // Normalize: ensure URL has protocol, strip trailing slash
  let baseUrl = wordpress_url.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  baseUrl = baseUrl.replace(/\/$/, '');

  // Normalize app password: WordPress app passwords work with or without spaces
  const appPass = wordpress_app_password.trim();
  const credentials = Buffer.from(wordpress_username.trim() + ':' + appPass).toString('base64');

  const postBody = JSON.stringify({
    title: title,
    content: content,
    excerpt: excerpt || '',
    status: 'publish',
    format: 'standard'
  });

  const endpoint = baseUrl + '/wp-json/wp/v2/posts';
  console.log('WP publish attempt:', endpoint, 'user:', wordpress_username.trim());

  return new Promise((resolve) => {
    const makeRequest = (url, redirectCount) => {
      if (redirectCount > 3) { resolve({ success: false, reason: 'too_many_redirects' }); return; }
      const parsedUrl = new URL(url);
      const proto = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ''),
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + credentials,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postBody),
          'User-Agent': 'AutomateSEO/1.0'
        },
        timeout: 20000
      };
      const req = proto.request(options, (res) => {
        // Follow redirects
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : parsedUrl.origin + res.headers.location;
          console.log('WP redirect:', res.statusCode, '->', redirectUrl);
          res.resume();
          makeRequest(redirectUrl, redirectCount + 1);
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('WP response status:', res.statusCode, 'body preview:', data.substring(0, 200));
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode === 201) {
              resolve({ success: true, url: parsed.link, post_id: parsed.id, platform: 'wordpress' });
            } else {
              const reason = parsed.message || parsed.code || ('status_' + res.statusCode);
              console.error('WP publish failed:', reason, 'code:', parsed.code);
              resolve({ success: false, reason: reason, status: res.statusCode });
            }
          } catch(e) {
            console.error('WP parse error:', e.message, 'raw:', data.substring(0, 300));
            resolve({ success: false, reason: 'parse_error: ' + data.substring(0, 100) });
          }
        });
      });
      req.on('error', (e) => {
        console.error('WP request error:', e.message);
        resolve({ success: false, reason: 'request_error: ' + e.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, reason: 'timeout' });
      });
      req.write(postBody);
      req.end();
    };
    makeRequest(endpoint, 0);
  });
}

// ── Shopify Publisher ──────────────────────────────────────────────────────
async function publishToShopify(client, title, content, excerpt) {
  const { shopify_domain, shopify_access_token } = client;
  if (!shopify_domain || !shopify_access_token) return { success: false, reason: 'no_shopify_credentials' };

  const shop = shopify_domain.replace(/\.myshopify\.com.*/, '') + '.myshopify.com';
  const body = JSON.stringify({
    article: {
      title,
      body_html: content,
      summary_html: excerpt || '',
      published: true,
      published_at: new Date().toISOString()
    }
  });

  // First get or create the main blog
  return new Promise((resolve) => {
    // Get blogs list first
    const getBlogsOptions = {
      hostname: shop,
      path: '/admin/api/2024-01/blogs.json',
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': shopify_access_token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    };
    const req = https.request(getBlogsOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const blogs = parsed.blogs || [];
          const blogId = blogs.length > 0 ? blogs[0].id : null;
          if (!blogId) { resolve({ success: false, reason: 'no_blog_found' }); return; }

          // Now post article to the blog
          const articleBody = body;
          const postOptions = {
            hostname: shop,
            path: '/admin/api/2024-01/blogs/' + blogId + '/articles.json',
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': shopify_access_token,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(articleBody)
            },
            timeout: 15000
          };
          const postReq = https.request(postOptions, (postRes) => {
            let postData = '';
            postRes.on('data', chunk => postData += chunk);
            postRes.on('end', () => {
              try {
                const postParsed = JSON.parse(postData);
                if (postRes.statusCode === 201) {
                  resolve({ success: true, url: 'https://' + shop + '/blogs/' + blogs[0].handle + '/' + postParsed.article.handle, post_id: postParsed.article.id, platform: 'shopify' });
                } else {
                  resolve({ success: false, reason: JSON.stringify(postParsed.errors) || 'shopify_error', status: postRes.statusCode });
                }
              } catch(e) { resolve({ success: false, reason: 'parse_error' }); }
            });
          });
          postReq.on('error', (e) => resolve({ success: false, reason: e.message }));
          postReq.write(articleBody);
          postReq.end();
        } catch(e) { resolve({ success: false, reason: 'parse_error' }); }
      });
    });
    req.on('error', (e) => resolve({ success: false, reason: e.message }));
    req.end();
  });
}

// ── Article Generator ──────────────────────────────────────────────────────
async function generateArticleForClient(client) {
  const { supabase } = require('./supabase');

  try {
    const businessDesc = client.business_description || client.website_url;
    const services = client.services ? client.services.join(', ') : 'their services';
    const location = client.target_cities || client.country || 'Australia';
    const priorityService = client.priority_service || services.split(',')[0] || 'their main service';

    // Get recent article titles to avoid repeats
    const { data: recentArticles } = await supabase
      .from('articles')
      .select('title, keyword')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentTitles = recentArticles ? recentArticles.map(a => a.title).join(', ') : 'none';

    // Generate keyword + article
    const keywordResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: 'Business: ' + businessDesc + '. Location: ' + location + '. Focus service: ' + priorityService + '. Recent articles: ' + recentTitles + '. Give me ONE high-value SEO keyword phrase (3-6 words) someone would search to find this business. Reply with ONLY the keyword phrase, nothing else.'
      }]
    });
    const keyword = keywordResponse.content[0].text.trim();

    // Generate full article
    const articleResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: 'Write a 1500-word expert SEO blog article for this business:\n\nBusiness: ' + businessDesc + '\nLocation: ' + location + '\nTarget keyword: ' + keyword + '\nService focus: ' + priorityService + '\n\nRequirements:\n- Professional, helpful tone\n- Naturally use the keyword 4-6 times\n- Use HTML headings (h2, h3), paragraphs, and bullet lists\n- Include a clear introduction and conclusion\n- Do NOT include generic AI filler\n- Do NOT mention the business name more than 3 times\n- Write as if a human expert wrote it\n\nReturn ONLY the article HTML content starting with an h2 tag. No title tag needed.'
      }]
    });
    const articleContent = articleResponse.content[0].text.trim();

    // Generate title and excerpt
    const metaResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: 'Based on this article content, write:\n1. An SEO-optimised title (60 chars max)\n2. A meta description/excerpt (155 chars max)\n\nArticle keyword: ' + keyword + '\nBusiness location: ' + location + '\n\nReturn ONLY JSON: {"title": "...", "excerpt": "..."}'
      }]
    });
    const meta = JSON.parse(metaResponse.content[0].text.replace(/```json|```/g, '').trim());
    const title = meta.title;
    const excerpt = meta.excerpt;

    // Save to Supabase first
    const { data: articleData, error: articleError } = await supabase
      .from('articles')
      .insert({
        client_id: client.id,
        title,
        keyword,
        content: articleContent,
        excerpt,
        status: 'publishing',
        word_count: articleContent.split(' ').length,
        website_url: client.website_url
      })
      .select()
      .single();

    if (articleError) throw articleError;

    // Auto-publish based on CMS type
    let publishResult = { success: false, reason: 'no_cms_configured' };
    const cmsType = client.cms_type || 'none';

    if (cmsType === 'wordpress') {
      publishResult = await publishToWordPress(client, title, articleContent, excerpt);
    } else if (cmsType === 'shopify') {
      publishResult = await publishToShopify(client, title, articleContent, excerpt);
    }

    // Update article status
    const updateData = {
      status: publishResult.success ? 'published' : 'generated',
      published_at: publishResult.success ? new Date().toISOString() : null,
      published_url: publishResult.url || null,
      publish_error: publishResult.success ? null : publishResult.reason
    };

    await supabase.from('articles').update(updateData).eq('id', articleData.id);

    console.log('Article for', client.website_url, ':', publishResult.success ? 'published to ' + cmsType : 'saved (no CMS: ' + publishResult.reason + ')');
    return { success: true, articleId: articleData.id, published: publishResult.success };

  } catch (err) {
    console.error('Error generating article for', client.website_url, ':', err.message);
    return { success: false, error: err.message };
  }
}

// ── Daily runner ───────────────────────────────────────────────────────────
async function generateDailyArticles() {
  const { supabase } = require('./supabase');
  console.log('Starting daily article generation...');

  const { data: clients, error } = await supabase
    .from('clients')
    .select('*')
    .eq('status', 'active');

  if (error) { console.error('Error fetching clients:', error.message); return; }
  if (!clients || clients.length === 0) { console.log('No active clients.'); return; }

  console.log('Generating articles for', clients.length, 'clients...');
  const results = [];
  for (const client of clients) {
    const result = await generateArticleForClient(client);
    results.push({ clientId: client.id, ...result });
    // Small delay between clients to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('Done. Results:', JSON.stringify(results));
  return results;
}

module.exports = { generateDailyArticles, generateArticleForClient };
