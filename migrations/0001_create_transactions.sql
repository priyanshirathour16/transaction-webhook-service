-- Transactions received via webhook. `transaction_id` is the idempotency key.
CREATE TABLE transactions (
  transaction_id       text PRIMARY KEY,
  source_account       text NOT NULL,
  destination_account  text NOT NULL,
  amount               numeric(20, 4) NOT NULL,
  currency             char(3) NOT NULL,
  status               text NOT NULL DEFAULT 'PROCESSING',
  created_at           timestamptz NOT NULL DEFAULT now(),
  enqueued_at          timestamptz,
  processed_at         timestamptz,
  attempts             integer NOT NULL DEFAULT 0,
  last_error           text,

  CONSTRAINT transactions_amount_positive CHECK (amount > 0),
  CONSTRAINT transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT transactions_status_valid CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
  CONSTRAINT transactions_processed_at_consistent CHECK (
    (status = 'PROCESSED' AND processed_at IS NOT NULL) OR (status <> 'PROCESSED')
  )
);

-- Reconciler scans only rows that are still in flight.
CREATE INDEX transactions_processing_created_at_idx
  ON transactions (created_at)
  WHERE status = 'PROCESSING';
