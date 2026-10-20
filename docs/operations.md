# Operations and reference

Settings, tools and day-to-day commands. For setting up AWS, Supabase and GitHub from nothing, see the
[deployment guide](deployment-guide.md).

## Configuration

Environment variables are validated when the process starts. If one is wrong, it refuses to start and says which.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. On AWS use Supabase's transaction pooler (port 6543). |
| `DATABASE_URL_DIRECT` | none | Used by migrations. Use Supabase's session pooler string (IPv4); the direct connection is IPv6 only. |
| `DB_SSL` | `require` | `disable` for the local Docker database |
| `DB_POOL_MAX` | `1` | Connections per container. Lambda concurrency bounds the total. |
| `QUEUE_DRIVER` | `sqs` | `memory` for local runs and tests only |
| `QUEUE_URL` | none | Required when `QUEUE_DRIVER=sqs` |
| `PROCESS_DELAY_SECONDS` | `30` | Delay before processing (SQS allows at most 900) |
| `MAX_RECEIVE_COUNT` | `5` | Attempts before the dead-letter queue. Must equal the queue's redrive policy. |
| `WEBHOOK_SECRET` | none | Turns on the HMAC signature check (at least 8 characters) |
| `REPAIR_GRACE_SECONDS` | `10` | A duplicate younger than this is assumed to be racing the original request |
| `RECONCILE_AFTER_SECONDS` | `120` | Re-queue stuck transactions older than this (must be more than the delay) |
| `RECONCILE_RETRYING_AFTER_SECONDS` | `1800` | The same, for transactions that are already being retried |
| `RECONCILE_BATCH_SIZE` | `100` | Rows per reconciler run |
| `LOG_LEVEL` | `info` | `fatal` down to `trace`, or `silent` |

## Manual deploy

The normal way is to push to `main`, which runs `.github/workflows/deploy.yml`. To deploy from your own machine:

```bash
npm install -g esbuild
sam build
sam deploy --guided        # first time; afterwards just: sam deploy
# parameters: DatabaseUrl=…  AlertEmail=…  [WebhookSecret=…]
```

To tear everything down, see the end of the deployment guide.

## Alarms

Seven CloudWatch alarms send an email: dead-letter queue not empty, queue backlog older than 5 minutes, a transaction
marked `FAILED`, an unhandled API error, API throttling, and worker or reconciler crashes. After the first deploy AWS
emails a confirmation link to `ALERT_EMAIL`; click it or the alarms won't reach you.

## When something fails

```sql
-- what failed, and why
SELECT transaction_id, attempts, last_error FROM transactions WHERE status = 'FAILED';
```

After fixing the cause, redrive the dead-letter queue so the failed transactions run again:

```bash
DLQ_URL=$(aws cloudformation describe-stacks --stack-name transaction-webhook-service \
  --query "Stacks[0].Outputs[?OutputKey=='DeadLetterQueueUrl'].OutputValue" --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)
aws sqs start-message-move-task --source-arn "$DLQ_ARN"
```

Logs are structured JSON in CloudWatch under `/aws/lambda/transaction-webhook-service-{api,worker,reconciler}`. A
useful Logs Insights query: `fields @timestamp, event, transaction_id, request_id | filter event = "txn.failed"`. The
`x-request-id` response header ties a response to its log lines.

## Checking the database connection

`npm run db:check` tests both connection strings the way the app uses them (from the environment or `.env`): whether
each one connects, how fast it answers, whether a multi-statement transaction works through the pooler, whether the
schema exists, and whether the database is in the same region as the application (`EXPECTED_DB_REGION`, default
`ap-southeast-2`). It never prints passwords. Run it before the first deploy and whenever a connection problem is
suspected.

## Finding out what your AWS account allows

Some AWS accounts sit inside an AWS Organization whose service control policies forbid certain actions or regions, and
each restriction only shows up as a failed deploy. The manual workflow **Actions, Diagnose AWS access** (script
`scripts/diagnose-aws-access.sh`) tries every action the deployment needs, on throwaway resources it deletes again, and
reports each as `ALLOWED`, `BLOCKED BY ORGANIZATION (SCP)` (nothing in the account can undo this) or
`DENIED BY OUR IAM POLICY` (fixable in `infra/github-deploy-access.yaml`).

## Money and Supabase notes

- Amounts are `numeric(20,4)` in the database and exact decimal strings in the code. They only become JSON numbers at
  the API edge.
- Supabase exposes tables in the `public` schema through an automatic REST API. This service never uses it (it connects
  to Postgres directly), so migration `0002` turns on row-level security with no policies. The API roles can then read
  and write nothing, and the service's own connection is unaffected. A test checks that a low-privilege role sees zero
  rows.
