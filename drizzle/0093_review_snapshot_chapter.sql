-- 0093: the monthly review snapshot counts only the chapter's own rows (#1621).
-- positioning: docs/superpowers/specs/after-leaving-design.md (a chapter
-- belongs to the relationship that wrote it).
--
-- Why: rows belong to a chapter by `created_at` (GroupEpochs window), but
-- 0089's compute_monthly_review_snapshot picked a month's rows by
-- `transacted_at` / `occurred_at` alone, and `transacted_at` can be any date
-- (lib/validators.ts checks only the format). A former partner's future-dated
-- row (left in the ledger by removePartner / account deletion) therefore
-- landed in a month that lies entirely inside the NEXT chapter: cards 1
-- (top category total), 2 (largest expense amount, description, category),
-- 3 (recurring events) and 4 (per-asset totals). #1618 removed only the
-- payer's name from card 2. The reverse direction leaked too: a row created
-- in a later chapter and backdated into a closed chapter's month changed the
-- earlier chapter's review.
-- Failure looks like: nothing errors. C opens a month of the A+C chapter and
-- reads an amount and description that B recorded.
--
-- What changes (body is 0089's otherwise, verbatim):
--   1. The containing chapter: the group's GroupEpochs row whose window holds
--      the WHOLE Asia/Taipei month. Same comparisons as isMonthInChapter
--      (lib/monthlyReview.ts) — month start >= started_at AND (ended_at IS
--      NULL OR next month start <= ended_at) — on millisecond-truncated
--      bounds, because the app compares JS Dates (millisecond precision,
--      truncated). So SQL and the review page agree on which months are
--      "inside" a chapter, even for a started_at a fraction of a millisecond
--      after a month start.
--   2. If there is one, every card's base rows (card 1, card 2, card 3's
--      CashTransactions and IncomeTransactions, card 4) also need
--      `created_at >= started_at AND (ended_at IS NULL OR created_at <
--      ended_at)` on the FULL-precision bounds — the strict rule every
--      in-chapter money read uses (epochClause, lib/db/queries/_predicates.ts).
--      The upper bound is exact: acceptInvite writes trip-fold rows at
--      boundary − 1µs (actions/invite.ts), which must stay in the old chapter.
--      The predicate is inline. Never call viewer_in_chapter here: it keys on
--      auth.uid(), which is NULL under pg_cron, and its EXECUTE is revoked
--      from service_role (0080) — the cron would compute empty snapshots.
--   3. If there is none (a month straddling two chapters, or a group without
--      any GroupEpochs row), the cards stay unfiltered, as before. The review
--      page never shows a straddling month (isMonthInChapter), and a legacy
--      group has no chapters to separate.
--   4. v_is_solo follows the containing chapter (its member_b_id IS NULL), not
--      today's OikosGroups.member_b: a duo chapter's month keeps counting only
--      `half` rows on card 1 after the partner left. Without a chapter, the
--      group-row rule stays.
--   5. The upsert and its write-once gate are unchanged.
--
-- Security mode is unchanged: SECURITY INVOKER, plpgsql, same signature and
-- parameter names (a new signature would add a PUBLIC-executable overload the
-- cron never calls), `SET search_path = public, pg_temp` (0077's header: a
-- CREATE OR REPLACE without SET silently drops the pin). REVOKE / GRANT are
-- repeated below (tests/migration-grant-guard.test.ts, migrations after
-- 0080). CREATE OR REPLACE keeps the OID and ACL; never DROP + CREATE.
--
-- Stored snapshots are write-once and are not recomputed. Prod count on
-- 2026-10-13: 0 stored snapshots contain an out-of-chapter row, so no
-- backfill (#1621 plan).
--
-- Apply window (prod): OUTSIDE 16:00-17:30 UTC (monthly snapshot cron
-- `5 16 1 * *` UTC; deletion cron 16:30 UTC). Ships with v1.7.3, after 0092.
-- Old code works with this function unchanged (no schema change).
--
-- Idempotent: CREATE OR REPLACE, REVOKE and GRANT can be re-run.
--
-- Rollback: revert the code; to restore 0089's function body run
-- scripts/rollback/0093_review_snapshot_chapter.down.sql.

CREATE OR REPLACE FUNCTION public.compute_monthly_review_snapshot(
  p_group_id  uuid,
  p_year      integer,
  p_month     integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member_a               uuid;
  v_member_b               uuid;
  v_is_solo                boolean;
  v_month_start            timestamptz;
  v_next_month_start       timestamptz;
  v_in_chapter             boolean;
  v_ch_started_at          timestamptz;
  v_ch_ended_at            timestamptz;
  v_ch_member_b            uuid;
  v_top_category           text;
  v_top_category_total     integer;
  v_largest_amount         integer;
  v_largest_description    text;
  v_largest_category       text;
  v_largest_paid_by        uuid;
  v_recurring_events       jsonb;
  v_recurring_in_total     integer;
  v_recurring_ex_total     integer;
  v_asset_breakdown        jsonb;
BEGIN
  SELECT member_a, member_b INTO v_member_a, v_member_b
    FROM "OikosGroups" WHERE id = p_group_id;
  IF v_member_a IS NULL THEN RETURN; END IF;

  v_month_start      := make_timestamptz(p_year, p_month, 1, 0, 0, 0, 'Asia/Taipei');
  v_next_month_start := v_month_start + INTERVAL '1 month';

  -- #1621: the chapter that holds the whole month, compared like
  -- isMonthInChapter (millisecond-truncated bounds). Chapters do not overlap;
  -- ORDER BY only makes the pick deterministic.
  SELECT e.started_at, e.ended_at, e.member_b_id
    INTO v_ch_started_at, v_ch_ended_at, v_ch_member_b
    FROM "GroupEpochs" e
   WHERE e.group_id = p_group_id
     AND v_month_start >= date_trunc('milliseconds', e.started_at)
     AND (e.ended_at IS NULL OR v_next_month_start <= date_trunc('milliseconds', e.ended_at))
   ORDER BY e.started_at DESC
   LIMIT 1;
  v_in_chapter := FOUND;

  IF v_in_chapter THEN
    v_is_solo := v_ch_member_b IS NULL;
  ELSE
    v_is_solo := v_member_b IS NULL;
  END IF;

  -- card 1: top category. Dyad → only `half` rows (joint spend); solo → all.
  SELECT category, SUM(amount)::integer
    INTO v_top_category, v_top_category_total
    FROM "CashTransactions"
    WHERE group_id = p_group_id
      AND deleted_at IS NULL
      AND transacted_at >= v_month_start
      AND transacted_at <  v_next_month_start
      AND (NOT v_in_chapter OR (created_at >= v_ch_started_at
           AND (v_ch_ended_at IS NULL OR created_at < v_ch_ended_at)))
      AND (v_is_solo OR split_type = 'half')
    GROUP BY category
    ORDER BY SUM(amount) DESC
    LIMIT 1;

  -- card 2: largest single expense (any split_type). Stores WHO paid (the
  -- payer id), never their name (#1618): the review page resolves the name
  -- within the viewed chapter. Tie-breaker is deterministic.
  SELECT t.amount,
         t.description,
         t.category,
         t.paid_by
    INTO v_largest_amount,
         v_largest_description,
         v_largest_category,
         v_largest_paid_by
    FROM "CashTransactions" t
    WHERE t.group_id = p_group_id
      AND t.deleted_at IS NULL
      AND t.transacted_at >= v_month_start
      AND t.transacted_at <  v_next_month_start
      AND (NOT v_in_chapter OR (t.created_at >= v_ch_started_at
           AND (v_ch_ended_at IS NULL OR t.created_at < v_ch_ended_at)))
    ORDER BY t.amount DESC, t.transacted_at ASC, t.created_at ASC, t.id ASC
    LIMIT 1;

  -- card 3: recurring events (resolved pendings → tx). Aggregate into a list
  -- and totals. Direction is set per-source.
  WITH expense_evts AS (
    SELECT r.description AS name,
           t.amount AS amount,
           'expense'::text AS direction,
           t.transacted_at AS occurred_at
      FROM "PendingExpenseOccurrences" p
      JOIN "CashTransactions" t ON t.id = p.resolved_tx_id AND t.group_id = p_group_id
      JOIN "RecurringExpenseRules" r ON r.id = p.rule_id
     WHERE p.group_id = p_group_id
       AND t.deleted_at IS NULL
       AND t.transacted_at >= v_month_start
       AND t.transacted_at <  v_next_month_start
       AND (NOT v_in_chapter OR (t.created_at >= v_ch_started_at
            AND (v_ch_ended_at IS NULL OR t.created_at < v_ch_ended_at)))
  ),
  income_evts AS (
    SELECT COALESCE(NULLIF(r.source, ''), r.category) AS name,
           t.amount AS amount,
           'income'::text AS direction,
           (t.occurred_at::timestamp AT TIME ZONE 'Asia/Taipei') AS occurred_at
      FROM "PendingIncomeOccurrences" p
      JOIN "IncomeTransactions" t ON t.id = p.resolved_tx_id AND t.group_id = p_group_id
      JOIN "RecurringIncomeRules" r ON r.id = p.rule_id
     WHERE p.group_id = p_group_id
       AND t.deleted_at IS NULL
       AND t.occurred_at >= (v_month_start AT TIME ZONE 'Asia/Taipei')::date
       AND t.occurred_at <  (v_next_month_start AT TIME ZONE 'Asia/Taipei')::date
       AND (NOT v_in_chapter OR (t.created_at >= v_ch_started_at
            AND (v_ch_ended_at IS NULL OR t.created_at < v_ch_ended_at)))
  ),
  all_evts AS (
    SELECT * FROM expense_evts UNION ALL SELECT * FROM income_evts
  )
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'name', name,
             'amount', amount,
             'direction', direction,
             'occurredAt', to_char(occurred_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD')
           )
           ORDER BY occurred_at ASC, name ASC
         ), '[]'::jsonb),
         COALESCE(SUM(amount) FILTER (WHERE direction = 'income'), 0)::integer,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'expense'), 0)::integer
    INTO v_recurring_events, v_recurring_in_total, v_recurring_ex_total
    FROM all_evts;

  -- card 4: top-3 愛物 by spend; NULL asset_id is excluded (spec: 「愛物進度」).
  WITH per_asset AS (
    SELECT t.asset_id,
           SUM(t.amount)::integer AS total
      FROM "CashTransactions" t
     WHERE t.group_id = p_group_id
       AND t.deleted_at IS NULL
       AND t.asset_id IS NOT NULL
       AND t.transacted_at >= v_month_start
       AND t.transacted_at <  v_next_month_start
       AND (NOT v_in_chapter OR (t.created_at >= v_ch_started_at
            AND (v_ch_ended_at IS NULL OR t.created_at < v_ch_ended_at)))
     GROUP BY t.asset_id
     ORDER BY SUM(t.amount) DESC
     LIMIT 3
  )
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'assetName', COALESCE(a.name, ''),
             'total', pa.total
           )
           ORDER BY pa.total DESC
         ), '[]'::jsonb)
    INTO v_asset_breakdown
    FROM per_asset pa
    LEFT JOIN "Assets" a ON a.id = pa.asset_id AND a.group_id = p_group_id;

  INSERT INTO "MonthlyReviewSnapshots" (
    group_id, year, month,
    top_category, top_category_total,
    largest_expense_amount, largest_expense_description,
    largest_expense_category, largest_expense_paid_by, largest_expense_paid_by_name,
    recurring_events, recurring_total_income, recurring_total_expense,
    asset_breakdown
  ) VALUES (
    p_group_id, p_year, p_month,
    v_top_category, v_top_category_total,
    v_largest_amount, v_largest_description,
    v_largest_category, v_largest_paid_by, NULL,
    v_recurring_events, v_recurring_in_total, v_recurring_ex_total,
    v_asset_breakdown
  )
  ON CONFLICT (group_id, year, month) DO UPDATE SET
    computed_at                  = NOW(),
    top_category                 = EXCLUDED.top_category,
    top_category_total           = EXCLUDED.top_category_total,
    largest_expense_amount       = EXCLUDED.largest_expense_amount,
    largest_expense_description  = EXCLUDED.largest_expense_description,
    largest_expense_category     = EXCLUDED.largest_expense_category,
    largest_expense_paid_by      = EXCLUDED.largest_expense_paid_by,
    largest_expense_paid_by_name = NULL,
    recurring_events             = EXCLUDED.recurring_events,
    recurring_total_income        = EXCLUDED.recurring_total_income,
    recurring_total_expense      = EXCLUDED.recurring_total_expense,
    asset_breakdown              = EXCLUDED.asset_breakdown
  WHERE "MonthlyReviewSnapshots".top_category IS NULL
    AND "MonthlyReviewSnapshots".largest_expense_amount IS NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.compute_monthly_review_snapshot(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.compute_monthly_review_snapshot(uuid, integer, integer) TO postgres, service_role;
