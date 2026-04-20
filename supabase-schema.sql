-- Run in Supabase SQL editor

CREATE TABLE clients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  website_url TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','cancelled')),
  trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE articles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  keyword TEXT,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'ready' CHECK (status IN ('ready','published','rejected')),
  word_count INTEGER,
  website_url TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX articles_client_id_idx ON articles(client_id);
CREATE INDEX clients_status_idx ON clients(status);