-- Substitution engine: per-user preferences (kosher toggle + how aggressive to
-- substitute) and a cached "product concept" per saved product (structured
-- attributes used to find equivalent products from other brands).
--
-- Access is backend-only (service role, requireSuperAdmin); RLS denies direct
-- client access like the other price_* tables.

CREATE TABLE IF NOT EXISTS price_user_prefs (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  kosher_only        boolean NOT NULL DEFAULT true,
  substitution_level text NOT NULL DEFAULT 'close'
                       CHECK (substitution_level IN ('off','exact','close','loose')),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_product_concepts (
  product_id      uuid PRIMARY KEY REFERENCES price_products(id) ON DELETE CASCADE,
  category        text,
  subtype         text,
  flavor          text,
  diet            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["kosher","gluten-free",...]
  key_ingredients jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_terms    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- brand-less queries
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE price_user_prefs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_product_concepts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "price_user_prefs_no_direct"       ON price_user_prefs;
DROP POLICY IF EXISTS "price_product_concepts_no_direct" ON price_product_concepts;
CREATE POLICY "price_user_prefs_no_direct"       ON price_user_prefs
  FOR ALL USING (false) WITH CHECK (false);
CREATE POLICY "price_product_concepts_no_direct" ON price_product_concepts
  FOR ALL USING (false) WITH CHECK (false);
