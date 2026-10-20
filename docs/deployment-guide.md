# Deployment guide

How to run your own copy of the service on AWS (Lambda, SQS, CloudFront) with a Supabase Postgres database,
deployed by GitHub Actions. Allow about an hour for a first-time setup. Local development needs none of this: see the
[README](../README.md#run-it-locally).

> **Never paste secret keys, passwords or connection strings into chat, issues, commits or the README.** They belong
> only in GitHub secrets and (for local testing) in the git-ignored `.env`.

## What you need

| Account | Notes |
|---|---|
| **AWS** | The Free plan is enough. Costs are negligible at this volume. |
| **Supabase** | The free plan is enough. It must be in the **same region** as the AWS deployment. |
| **GitHub** | A public repository holding this code, with Actions enabled. |

## 1. AWS account

1. Create an account at aws.amazon.com/free with an email address never used for AWS, and choose the **Free plan**
   (about $100 in credits, ending after 6 months or when the credits are spent).
2. Secure it: turn on **MFA** for the root user, create a **budget alert** (a monthly budget of a few dollars with an
   email alert), and do day-to-day work as an admin user or role rather than root.
3. **Choose the region** (see below). This project uses `ap-southeast-2` (Sydney).

### Choosing a region (and organization restrictions)

An AWS account can sit inside an **AWS Organization** whose service control policies (SCPs) forbid some actions or
regions, and the error only appears when a deploy reaches the forbidden call: for example `not authorized to perform
… with an explicit deny in a service control policy`. Nothing inside the account can override such a rule.

Rather than discovering restrictions one failed deploy at a time, use the **Diagnose AWS access** workflow (Actions
tab, script `scripts/diagnose-aws-access.sh`). It tries every action the deployment needs, in each region you list, on
throwaway resources it deletes afterwards, and prints a table. A row is `allowed`, `BLOCKED` (the organization forbids
it), `our IAM` (missing from the deploy identity's own policy, which is fixable) or `authorized`. Pick a region where
nothing is `BLOCKED`. In the account this project was built in, only Sydney and N. Virginia qualified, and the other five
regions tried (including Mumbai) were blocked.

The probe uses its own `<stack>-probe` stack and refuses to touch anything else; a test enforces that.

## 2. Supabase project

1. Create a project in the **same region as AWS** (Sydney for `ap-southeast-2`). A database in another region adds a long
   network trip to every query and puts the 500 ms goal at risk.
2. Save the database password (letters and numbers only avoids URL-encoding problems).
3. Click **Connect** and copy two connection strings with the password filled in:
   - **Transaction pooler** (port **6543**) is `DATABASE_URL`, used by the Lambdas.
   - **Session pooler** (port **5432**) is `DATABASE_URL_DIRECT`, used for migrations.
4. Do **not** use the "Direct connection" string: it is IPv6-only on the free plan and GitHub-hosted runners are IPv4, so
   the migration step could not connect.
5. Check them: put both in `.env` (with `DB_SSL=require`) and run `npm run db:check`. It tests each string the way the
   app uses it, reports speed and whether the database is in the expected region (`EXPECTED_DB_REGION`), and never prints
   passwords. From a laptop far from the region, expect a slow first connection; the tool allows 20 s.
6. Run `npm run migrate` once if you want the tables to exist before the first deploy (the pipeline also runs it).

A free Supabase project pauses after a week of inactivity; the reconciler's regular queries prevent that once deployed.

## 3. Deploy identity for GitHub Actions (one time, by an admin)

The workflow needs AWS credentials limited to this stack's resources. Create them from the **CloudFormation console**
(no CLI or CloudShell needed; some organizations block CloudShell):

1. CloudFormation, **Create stack**, **With new resources (standard)**, **Upload a template file**:
   `infra/github-deploy-access.yaml`. Name it `transaction-webhook-service-github-access`.
2. Parameters: **DeployRegion** must be the region you deploy to (`ap-southeast-2` by default). **AccessMode** is either
   - **`oidc`**: a role GitHub assumes with short-lived tokens, **no stored keys** (preferred). Also fill in `GitHubOwner`
     and `GitHubRepository` (case-sensitive). If the stack fails with `iam:CreateOpenIDConnectProvider … explicit deny in
     a service control policy`, your organization forbids it: use `user` instead.
   - **`user`**: an IAM user plus an access key (the fallback; this project's account needed it). Leave the GitHub fields empty.
3. Tick the IAM acknowledgement and submit; wait for `CREATE_COMPLETE`.
4. **`user` mode:** open IAM, Users, `github-actions-deploy-transaction-webhook-service`, **Security credentials**,
   **Create access key** ("Application running outside AWS"), and copy the two values **straight into GitHub secrets**
   (the secret is shown only once). **`oidc` mode:** copy `DeployRoleArn` from the stack's Outputs.

The permissions are written by hand for exactly what `sam deploy` needs. If a deploy reports `AccessDenied` for an
action (an `our IAM` result), add it to `infra/github-deploy-access.yaml` and update the stack (Update stack, replace the
template; review the change set, then execute it).

## 4. GitHub

1. Push the code to your repository.
2. **Settings, Environments, New environment**: `production` (the deploy job uses it; you may add required reviewers).
3. Add these **environment secrets**:

   | Secret | Value |
   |---|---|
   | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | `user` mode: the access key from step 3 |
   | `AWS_ROLE_ARN` | `oidc` mode: the role ARN (set this **or** the two keys, never both) |
   | `DATABASE_URL` | Supabase transaction pooler string (port 6543) |
   | `DATABASE_URL_DIRECT` | Supabase session pooler string (port 5432) |
   | `ALERT_EMAIL` | where alarm emails are sent |
   | `WEBHOOK_SECRET` | optional, at least 8 characters. Unset means unsigned webhooks are accepted. |

## 5. Deploy

Push to `main`, or run **Actions, Deploy, Run workflow**. The pipeline runs lint, formatting and the tests, applies the
migrations, builds, deploys, reads the public URL from the stack outputs and runs the smoke test against it.

- **The first deploy takes about 10 to 15 minutes** (CloudFront rolls out worldwide).
- The run's **Summary** page shows the **API URL** (a `cloudfront.net` address). If a deploy fails, the Summary also lists
  the CloudFormation events that failed, with their reasons.
- AWS emails a **subscription confirmation** to `ALERT_EMAIL`. Click **Confirm subscription** or alarms will not reach you.
- A first deployment that fails leaves the stack in `ROLLBACK_COMPLETE`, which CloudFormation cannot update; the workflow
  deletes such a stack automatically before retrying.

Verify the live service yourself with `npm run smoke -- --url <api-url>` (see the README).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `explicit deny in a service control policy` | The AWS Organization forbids that action or region. Use the diagnostic workflow to find an allowed region, or an alternative way to do the same thing. It cannot be fixed from inside the account. |
| `no identity-based policy allows the … action` | The deploy identity's own policy lacks it. Add the action to `infra/github-deploy-access.yaml` and update that stack. |
| A resource fails with `AccessDenied` on an auto-named resource | CloudFormation **shortens** auto-generated names that exceed a service limit (EventBridge rules: 64 characters), so the `<stack>-*` name pattern in the policy stops matching. Give such resources explicit names; a test guards the schedule rules. |
| The migration step cannot connect | `DATABASE_URL_DIRECT` is the IPv6-only direct string. Use the **session pooler** string. |
| The Function URL answers `403` | Since late 2025 a public Function URL needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; the template states both. |
| Smoke test: end-to-end latency over 500 ms | It includes network distance from where the test runs. The test gates on the server's own time (`Server-Timing`) and prints both; `--strict-e2e` also holds the end-to-end figure to the budget. See the README's latency section. |
| `db:check` times out from your laptop | A TLS connection across continents takes many round trips. The tool allows 20 s, but the app itself keeps a strict 3 s because it runs next to the database. |

## What gets created in AWS

By the SAM stack `transaction-webhook-service`: three Lambda functions (API, worker, reconciler), a public Function URL, a
CloudFront distribution in front of it, an SQS queue and its dead-letter queue, two EventBridge schedules, three log
groups with metric filters, seven CloudWatch alarms, an SNS topic for them, and the execution roles. SAM also keeps a small
helper stack, `aws-sam-cli-managed-default`, holding the S3 bucket the deployment packages are uploaded to.

## Tear down

1. `sam delete --stack-name transaction-webhook-service --region ap-southeast-2` (or delete the stack in the console).
2. Delete the `transaction-webhook-service-github-access` stack. In `user` mode that also removes the IAM user and its key.
3. Delete the `aws-sam-cli-managed-default` stack (empty its bucket first), then the Supabase project if you no longer need it.
