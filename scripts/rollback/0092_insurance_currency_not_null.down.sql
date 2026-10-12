-- ROLLBACK for drizzle/0092_insurance_currency_not_null.sql
-- Not a drizzle migration: drizzle-kit only runs files listed in drizzle/meta/_journal.json.
--
-- Makes "InsuranceDetails"."currency" nullable again. Loses nothing: the
-- backfilled values stay. Readers already tolerate NULL (lib/insuranceCurrency.ts).
--
-- To let `db:migrate` re-apply 0092 afterwards, remove its journal row:
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1784800000000;

ALTER TABLE "InsuranceDetails" ALTER COLUMN "currency" DROP NOT NULL;
