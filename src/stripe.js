require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession(email, websiteUrl) {
  const customer = await stripe.customers.create({ email, metadata: { website_url: websiteUrl } });
  const session = await stripe.checkout.sessions.create({
    customer: customer.id,
    payment_method_types: ['card'],
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    mode: 'subscription',
    success_url: process.env.SITE_URL + '/success.html?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: process.env.SITE_URL + '/signup.html',
    customer_email: undefined,
    metadata: { website_url: websiteUrl, email }
  });
  return session;
}

async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  const { supabase } = require('./supabase');

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.metadata?.email;
    const websiteUrl = session.metadata?.website_url;
    const customerId = session.customer;
    const subscriptionId = session.subscription;

    console.log('Payment completed for:', email, 'website:', websiteUrl);

    if (email) {
      // Try to find existing client record
      const { data: existing } = await supabase.from('clients').select('id').eq('email', email).single();
      
      if (existing) {
        // Update existing record
        await supabase.from('clients').update({
          status: 'active',
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          trial_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
        }).eq('email', email);
      } else {
        // Create new client record
        await supabase.from('clients').insert({
          email,
          website_url: websiteUrl || '',
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          status: 'active',
          trial_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
        });
      }
      console.log('Client activated:', email);
    }
  }

  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    await supabase.from('clients').update({ status: 'cancelled' }).eq('stripe_customer_id', customerId);
    console.log('Client cancelled for customer:', customerId);
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    await supabase.from('clients').update({ status: 'payment_failed' }).eq('stripe_customer_id', customerId);
    console.log('Payment failed for customer:', customerId);
  }

  res.json({ received: true });
}

module.exports = { createCheckoutSession, handleStripeWebhook };
