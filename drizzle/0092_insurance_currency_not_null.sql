-- 0092: InsuranceDetails.currency becomes NOT NULL (#1607, follow-up to #1600 / 0085).
-- spec: docs/superpowers/specs/insurance-design.md
--
-- Why: 0085 left the column nullable so old code could keep inserting NULL
-- during the rollout. Every deployed writer since v1.7.0 (actions/asset.ts
-- create + edit upsert) writes a currency, so the nullable window is over.
-- Leaving it nullable means a future writer that omits currency is accepted
-- silently and read back as the ledger's base currency. Failure looks like:
-- no error anywhere; a USD policy written without currency shows as the
-- ledger's currency.
--
-- What this migration does:
--   1. repeats the 0085 backfill for any NULL row (owning group's base
--      currency; an orphan row with no group falls back to 'twd');
--   2. SET NOT NULL on "InsuranceDetails"."currency".
-- No default is added and no grant changes (futari_app already holds
-- table-level privileges on "InsuranceDetails").
--
-- Deploy order: order-independent. Every deployed writer already writes
-- currency, and prod had 0 NULL rows on 2026-10-12 (checked before writing
-- this). A writer that still inserts NULL would fail with 23502 after this.
-- Rollback: scripts/rollback/0092_insurance_currency_not_null.down.sql
-- Idempotent: safe to re-apply (backfill only touches NULLs; SET NOT NULL on
-- an already NOT NULL column is a no-op).

UPDATE "InsuranceDetails" d
SET "currency" = g."base_currency"
FROM "Assets" a
JOIN "OikosGroups" g ON g."id" = a."group_id"
WHERE a."id" = d."asset_id" AND d."currency" IS NULL;
--> statement-breakpoint
UPDATE "InsuranceDetails" SET "currency" = 'twd' WHERE "currency" IS NULL;
--> statement-breakpoint
ALTER TABLE "InsuranceDetails" ALTER COLUMN "currency" SET NOT NULL;
