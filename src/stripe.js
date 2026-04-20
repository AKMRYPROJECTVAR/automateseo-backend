const Stripe = require('stripe');
const { supabase } = require('./supabase');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession(email, websiteUrl) {
  return await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: email,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    subscription_data: { trial_period_days: 3, metadata: { websiteUrl, email } },
    metadata: { websiteUrl, email },
    success_url: process.env.SITE_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: process.env.SITE_URL + '/#pricing',
  });
}

async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) { return res.status(400).send('Webhook Error: ' + err.message); }

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      const { websiteUrl, email } = s.metadata || {};
      if (email) await supabase.from('clients').upsert({ email, website_url: websiteUrl, stripe_customer_id: s.customer, stripe_subscription_id: s.subscription, status: 'trial', trial_ends_at: new Date(Date.now() + 3*24*60*60*1000).toISOString() }, { onConflict: 'email' });
      break;
    }
    case 'customer.subscription.updated':
      if (event.data.object.status === 'active') await supabase.from('clients').update({ status: 'active' }).eq('stripe_subscription_id', event.data.object.id);
      break;
    case 'customer.subscription.deleted':
      await supabase.from('clients').update({ status: 'cancelled' }).eq('stripe_subscription_id', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      await supabase.from('clients').update({ status: 'past_due' }).eq('stripe_customer_id', event.data.object.customer);
      break;
  }
  res.json({ received: true });
}

module.exports = { createCheckoutSession, handleStripeWebhook };