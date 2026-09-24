-- Run this LAST, after every 01_data_*.sql file has completed.

BEGIN;

-- ---- Resolve staging rows against real companies/brands/accounts ----
CREATE TEMP TABLE stg_resolved AS
SELECT so.*, ma.id AS marketplace_account_id, b.id AS brand_id, c.id AS company_id, wh.id AS warehouse_id
FROM _import_stg_orders so
JOIN companies c ON c.legal_name = (CASE so.brand_key
    WHEN 'VARDHAMATI' THEN 'Nyko Mart'
    WHEN 'ARVAGAM' THEN 'Rugara'
    WHEN 'KANJUSH' THEN 'Casa Arra'
    WHEN 'UNASSIGNED' THEN 'UNASSIGNED - NEEDS BRAND REVIEW'
  END)
JOIN brands b ON b.company_id = c.id AND b.name = (CASE so.brand_key
    WHEN 'VARDHAMATI' THEN 'Vardhamati'
    WHEN 'ARVAGAM' THEN 'Arvagam'
    WHEN 'KANJUSH' THEN 'Kanjush'
    WHEN 'UNASSIGNED' THEN 'Unassigned'
  END)
JOIN marketplace_accounts ma ON ma.brand_id = b.id AND ma.marketplace = so.marketplace::marketplace AND ma.is_active = true
LEFT JOIN warehouses wh ON wh.company_id = c.id AND wh.is_default = true;

-- Insert/refresh orders (idempotent on (marketplace_account_id, marketplace_order_id))
INSERT INTO orders (marketplace_account_id, marketplace_order_id, status, fulfillment_type, invoice_number, invoice_date, ordered_at, verified_at, raw_payload)
SELECT marketplace_account_id, marketplace_order_id, status::order_status, fulfillment_type::fulfillment_type, invoice_number, invoice_date, ordered_at, verified_at, raw_json::jsonb
FROM stg_resolved
ON CONFLICT (marketplace_account_id, marketplace_order_id) DO UPDATE
  SET status = EXCLUDED.status, verified_at = EXCLUDED.verified_at;

-- Auto-create any SKU this import needs (title = marketplace SKU code,
-- same self-mapping convention as the app's existing bulk-SKU-add), then
-- self-map it for this marketplace account.
INSERT INTO skus (brand_id, code, product_title)
SELECT DISTINCT sr.brand_id, si.marketplace_sku, si.product_title
FROM _import_stg_items si
JOIN stg_resolved sr ON sr.marketplace = si.marketplace AND sr.marketplace_order_id = si.marketplace_order_id
WHERE NOT EXISTS (SELECT 1 FROM skus WHERE brand_id = sr.brand_id AND code = si.marketplace_sku)
ON CONFLICT (brand_id, code) DO NOTHING;

INSERT INTO marketplace_sku_map (marketplace_account_id, marketplace_sku, sku_id)
SELECT DISTINCT sr.marketplace_account_id, si.marketplace_sku, sk.id
FROM _import_stg_items si
JOIN stg_resolved sr ON sr.marketplace = si.marketplace AND sr.marketplace_order_id = si.marketplace_order_id
JOIN skus sk ON sk.brand_id = sr.brand_id AND sk.code = si.marketplace_sku
ON CONFLICT (marketplace_account_id, marketplace_sku) DO NOTHING;

INSERT INTO order_items (order_id, marketplace_line_item_id, sku_id, marketplace_sku, product_title_snapshot, variant_size, quantity, unit_price, mrp, shipping_charge, invoice_amount, tax_cgst, tax_sgst, tax_igst, tax_rate, hsn_code, settlement_price_estimate)
SELECT o.id, si.line_id, msm.sku_id, si.marketplace_sku, si.product_title, si.variant_size, si.quantity, si.unit_price, si.mrp, si.shipping_charge, si.invoice_amount, si.cgst, si.sgst, si.igst, si.tax_rate, si.hsn, si.settlement_est
FROM _import_stg_items si
JOIN stg_resolved sr ON sr.marketplace = si.marketplace AND sr.marketplace_order_id = si.marketplace_order_id
JOIN orders o ON o.marketplace_account_id = sr.marketplace_account_id AND o.marketplace_order_id = sr.marketplace_order_id
LEFT JOIN marketplace_sku_map msm ON msm.marketplace_account_id = sr.marketplace_account_id AND msm.marketplace_sku = si.marketplace_sku
WHERE NOT EXISTS (
  SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.marketplace_sku = si.marketplace_sku AND (oi2.marketplace_line_item_id = si.line_id OR (oi2.marketplace_line_item_id IS NULL AND si.line_id IS NULL))
);

INSERT INTO shipments (order_id, warehouse_id, marketplace_shipment_id, package_id, packet_id, awb_number, carrier, tracking_url, service_level, recipient_name, recipient_address_line1, recipient_address_line2, recipient_city, recipient_state, recipient_pincode, dispatch_window_start, dispatch_window_end, shipped_at, delivered_at, package_length_cm, package_breadth_cm, package_height_cm, package_weight_kg)
SELECT o.id, sr.warehouse_id, ss.shipment_id, ss.package_id, ss.packet_id, ss.awb_number, ss.carrier, ss.tracking_url, ss.service_level, ss.recipient_name, ss.recipient_address1, ss.recipient_address2, ss.recipient_city, ss.recipient_state, ss.recipient_pincode, ss.dispatch_start, ss.dispatch_end, ss.shipped_at, ss.delivered_at, ss.pkg_length, ss.pkg_breadth, ss.pkg_height, ss.pkg_weight
FROM _import_stg_shipments ss
JOIN stg_resolved sr ON sr.marketplace = ss.marketplace AND sr.marketplace_order_id = ss.marketplace_order_id
JOIN orders o ON o.marketplace_account_id = sr.marketplace_account_id AND o.marketplace_order_id = sr.marketplace_order_id
WHERE NOT EXISTS (SELECT 1 FROM shipments s2 WHERE s2.order_id = o.id);

INSERT INTO returns (order_id, status, return_type, reason, initiated_at)
SELECT o.id, sret.status::return_status, sret.return_type, sret.reason, o.ordered_at
FROM _import_stg_returns sret
JOIN stg_resolved sr ON sr.marketplace = sret.marketplace AND sr.marketplace_order_id = sret.marketplace_order_id
JOIN orders o ON o.marketplace_account_id = sr.marketplace_account_id AND o.marketplace_order_id = sr.marketplace_order_id
WHERE NOT EXISTS (SELECT 1 FROM returns r2 WHERE r2.order_id = o.id);

COMMIT;

-- ================= Review after running =================
-- 1) Import summary per company/brand/marketplace:
SELECT c.display_name AS company, b.name AS brand, ma.marketplace, count(*) AS orders_imported
FROM orders o
JOIN marketplace_accounts ma ON ma.id = o.marketplace_account_id
JOIN brands b ON b.id = ma.brand_id
JOIN companies c ON c.id = b.company_id
GROUP BY 1,2,3 ORDER BY 1,2,3;

-- 2) The review queue -- everything parked under the pseudo-company
--    because no brand signal existed for it:
SELECT o.marketplace_order_id, ma.marketplace, o.status, o.ordered_at
FROM orders o JOIN marketplace_accounts ma ON ma.id = o.marketplace_account_id
JOIN brands b ON b.id = ma.brand_id JOIN companies c ON c.id = b.company_id
WHERE c.legal_name = 'UNASSIGNED - NEEDS BRAND REVIEW'
ORDER BY ma.marketplace, o.ordered_at;

-- 3) OPTIONAL cleanup once you're happy with the import -- drops the
--    staging tables (uncomment and run separately if/when you want it):
-- DROP TABLE IF EXISTS _import_stg_orders, _import_stg_items, _import_stg_shipments, _import_stg_returns;
