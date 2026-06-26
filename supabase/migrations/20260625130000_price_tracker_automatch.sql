-- Use price_product_links as the auto-match cache for the "card = product"
-- model: when the tool discovers the same product on another store via search,
-- it caches the matched URL here so repeat comparisons skip the search step.
--   auto_matched  — true when the link was found automatically (vs the source
--                   link created from the URL the operator pasted)
--   matched_title — the product title as it appears on that store (the pack /
--                   size may differ from the canonical product)
ALTER TABLE price_product_links
  ADD COLUMN IF NOT EXISTS auto_matched boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS matched_title text;
