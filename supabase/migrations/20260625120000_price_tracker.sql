-- Price tracker — a personal (super-admin only) tool for comparing the
-- real price-per-ounce of products the operator buys regularly across
-- multiple online stores (Amazon, Amazon Fresh, Walmart, Costco, Costco
-- Same-Day).
--
-- All access is mediated by the Express backend using the service-role
-- client, gated by requireAuth + requireSuperAdmin. RLS is therefore set
-- to deny every direct (anon/authenticated) client — exactly like the
-- super_admins table — so an accidental browser-side read returns nothing.

-- ── products: the saved catalogue ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  brand         text,
  image_url     text,
  -- normalized size used for the per-oz calculation
  size_value    numeric,          -- e.g. 64
  size_unit     text,             -- canonical: 'oz' (weight or fluid) or 'count'
  size_label    text,             -- the human string we parsed, e.g. "4x16 Fl Oz"
  -- kosher verdict — deliberately three-state; "unclear" is the honest default
  kosher_status text NOT NULL DEFAULT 'unclear'
                  CHECK (kosher_status IN ('kosher','not_kosher','unclear')),
  kosher_note   text,
  source_url    text,             -- the original link the product was created from
  source_store  text,             -- which store that link belonged to
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_products_user ON price_products (user_id, created_at DESC);

-- ── per-store links: where to read each product's live price ─────────────────
CREATE TABLE IF NOT EXISTS price_product_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES price_products(id) ON DELETE CASCADE,
  store       text NOT NULL
                CHECK (store IN ('amazon','amazon_fresh','walmart','costco','costco_sameday')),
  url         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- one link per store per product
  UNIQUE (product_id, store)
);

CREATE INDEX IF NOT EXISTS idx_price_links_product ON price_product_links (product_id);

-- ── checks: history of real-time price reads ─────────────────────────────────
CREATE TABLE IF NOT EXISTS price_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES price_products(id) ON DELETE CASCADE,
  store          text NOT NULL
                   CHECK (store IN ('amazon','amazon_fresh','walmart','costco','costco_sameday')),
  url            text NOT NULL,
  ok             boolean NOT NULL DEFAULT false,
  price          numeric,
  currency       text DEFAULT 'USD',
  size_value     numeric,
  size_unit      text,
  size_label     text,
  price_per_oz   numeric,
  in_stock       boolean,
  raw_title      text,
  error          text,
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_checks_product ON price_checks (product_id, checked_at DESC);

-- ── RLS: deny all direct client access; backend uses service role ────────────
ALTER TABLE price_products      ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_product_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_checks        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "price_products_no_direct"      ON price_products;
DROP POLICY IF EXISTS "price_product_links_no_direct" ON price_product_links;
DROP POLICY IF EXISTS "price_checks_no_direct"        ON price_checks;

CREATE POLICY "price_products_no_direct"      ON price_products
  FOR ALL USING (false) WITH CHECK (false);
CREATE POLICY "price_product_links_no_direct" ON price_product_links
  FOR ALL USING (false) WITH CHECK (false);
CREATE POLICY "price_checks_no_direct"        ON price_checks
  FOR ALL USING (false) WITH CHECK (false);
