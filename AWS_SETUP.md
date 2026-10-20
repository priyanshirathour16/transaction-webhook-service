# AWS & Supabase Setup Guide (do this before coding starts)

Goal: end up with a safe AWS account, a Supabase database, and a short list of values to hand over so the service can be built and deployed.
**Never paste secret keys or passwords into chat, GitHub, or the README.**

---

## Part 1 — Create the AWS account (Free plan)

1. **Use a brand-new email** that has never been used for AWS (a fresh Gmail is fine). Accounts created before July 2025 may get no credits.
2. Go to **aws.amazon.com/free** → *Create a Free Account*.
3. Enter email + account name (e.g. `walnut-assessment`), verify the email code, set a root password.
4. Account type: **Personal**. Fill in name, phone, address.
5. **Add a payment card** (identity verification only; on the Free plan, usage comes out of credits, not your card). A small temporary charge/hold may appear and be reversed.
6. Verify your phone (SMS/voice code).
7. **Choose the Free plan** when asked (not Paid). It lasts up to 6 months or until credits run out.
8. Wait for activation (minutes, sometimes hours). If it is delayed, you can still continue with the Supabase part.
9. Sign in to the console → open **Billing → Credits** and confirm about **$100**. On the console home, the **Explore AWS** widget lists tasks that earn up to **$100 more** (e.g. launching a Lambda, setting a budget).

## Part 2 — Secure the account (10 minutes)

1. **Root MFA**: top-right account menu → *Security credentials* → *Assign MFA device* (authenticator app).
2. **Budget alert**: Billing → *Budgets* → create a monthly cost budget of **$1–5** with an email alert (also counts as an onboarding task).
3. **Set the region** to **Asia Pacific (Mumbai) `ap-south-1`** (top-right selector). Everything we deploy lives here.
4. **Create an IAM user for daily work** (never use root again):
   - IAM → Users → *Create user* → name `dev-admin` → allow console access.
   - Attach policy **AdministratorAccess** (acceptable for a throwaway assessment account; mention in the README that production would use least privilege).
   - Enable MFA on this user too.
   - After creating: *Security credentials* → *Create access key* → use case **CLI** → download/save the key ID + secret somewhere private. You will use them only on your own machine.
5. Sign out of root; sign in with the IAM user (note your 12-digit **Account ID** on the sign-in page / top-right menu).

## Part 3 — Install tools on your laptop

| Tool | Why | Check |
|---|---|---|
| Node.js 22 LTS | runtime | `node -v` |
| Git | source control | `git --version` |
| VS Code | editor | — |
| **AWS CLI v2** | talk to AWS | `aws --version` |
| **AWS SAM CLI** | build + deploy | `sam --version` |
| **Docker Desktop** | local Postgres for tests | `docker --version` |
| **esbuild** (global) | SAM bundles the Lambdas with it and looks for it on your PATH | `npm install -g esbuild` then `esbuild --version` |

Then run `aws configure` and enter: the IAM user's access key ID, secret, region `ap-south-1`, output `json`.
Verify with `aws sts get-caller-identity` → it should print your Account ID and the `dev-admin` user.

## Part 4 — Supabase (database)

1. supabase.com → sign in with GitHub → *New project*.
2. Name: `walnut-transactions`; **Region: South Asia (Mumbai)**; choose a strong DB password and **save it**.
3. Wait until the project is ready. Do this **1–2 days before the interview** and keep it active (free projects pause after ~1 week idle).
4. Open **Project → Connect** and copy two connection strings (password filled in):
   - **Transaction pooler** (port **6543**) — used by the Lambdas. This is `DATABASE_URL`.
   - **Session pooler** (port **5432** on the pooler host) — used for migrations. This is `DATABASE_URL_DIRECT`.
5. **Do not use the "Direct connection" string for migrations from GitHub Actions.** It is IPv6-only on the free
   plan and GitHub-hosted runners are IPv4, so the migration step would fail to connect. The session pooler works over IPv4.
6. If your password contains special characters (`@ : / ? # %`), URL-encode them inside the connection string.

## Part 5 — GitHub

1. Create a **public repo** (e.g. `transaction-webhook-service`) and push this project to it.
2. **Create the deploy identity in AWS (once, as an admin) — from the CloudFormation console.**
   (CloudShell and the CLI are not needed; some organizations block CloudShell.) This gives GitHub Actions a
   least-privilege identity that can deploy only this application's resources.
   - CloudFormation → **Create stack → With new resources (standard) → Upload a template file** →
     `infra/github-deploy-access.yaml`.
   - Stack name: `transaction-webhook-service-github-access`.
   - Region: any region works for creating this stack (the console may open in a different one than you expect). The
     permissions it grants always target `DeployRegion`, which defaults to `ap-south-1` (Mumbai).
   - **AccessMode:** pick the mode your account allows:
     - **`oidc`** (preferred, no stored keys): also fill in `GitHubOwner` and `GitHubRepository`
       (**case-sensitive**). If this fails with *"not authorized to perform: iam:CreateOpenIDConnectProvider … explicit deny
       in a service control policy"*, your organization forbids OIDC providers: use `user` instead.
     - **`user`**: an IAM user plus an access key. Leave the GitHub fields empty.
   - Tick the IAM acknowledgement on the last page and **Submit**. Wait for `CREATE_COMPLETE`.
   - **`user` mode only — create the access key:** IAM → Users → `github-actions-deploy-transaction-webhook-service` →
     **Security credentials → Create access key → "Application running outside AWS"**. Copy the **Access key ID** and
     **Secret access key** straight into GitHub secrets (step 4). The secret is shown only once. Never paste it into chat.
   - **`oidc` mode only:** copy `DeployRoleArn` from the stack's **Outputs** tab.
3. In the GitHub repo: **Settings → Environments → New environment → `production`** (the deploy job uses it;
   you can add "required reviewers" there if you want a manual approval before each deploy).
4. Add these as **secrets of the `production` environment** (Settings → Environments → production → Secrets):

   | Secret | Value |
   |---|---|
   | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | **`user` mode:** the access key from step 2 |
   | `AWS_ROLE_ARN` | **`oidc` mode:** the role ARN from step 2 (set this **or** the two keys, never both) |
   | `DATABASE_URL` | Supabase **transaction pooler** string (port 6543) |
   | `DATABASE_URL_DIRECT` | Supabase **session pooler** string (port 5432) |
   | `ALERT_EMAIL` | where alarms are sent |
   | `WEBHOOK_SECRET` | optional; at least 8 characters. Leave it out to accept unsigned webhooks (simplest for the evaluator's tests) |

5. After the first deploy, **click the confirmation link** in the email AWS SNS sends to `ALERT_EMAIL`.

> The identity's permissions were written by hand for exactly what `sam deploy` needs. If the first deploy reports
> `AccessDenied` for an action, that is expected feedback: add the action to `infra/github-deploy-access.yaml`, update the
> stack (CloudFormation → the stack → Update → replace the template), and re-run the workflow.
>
> **When you are finished:** delete the access stack. In `user` mode that also removes the IAM user and its key.
---

## What to give me (checklist)

Safe to share in chat:
- [ ] AWS **Account ID** (12 digits) and confirmation that `aws sts get-caller-identity` works
- [ ] Region confirmation: `ap-south-1`
- [ ] AWS account **creation date** and whether ~$100 credits show on the billing page
- [ ] GitHub **repo URL** (public) and your GitHub username
- [ ] The **email** to receive alarm notifications
- [ ] Supabase project region + project ref (the short ID in the dashboard URL)
- [ ] Output of `node -v`, `aws --version`, `sam --version`, `docker --version`

**Keep private (put only into `.env` locally / GitHub secrets / SAM parameters, never in chat or Git):**
- AWS access key ID + secret
- Supabase database password and both connection strings (transaction pooler + session pooler)
- `WEBHOOK_SECRET`

## What I will set up in AWS during Phase 5–7 (so nothing surprises you)

- CloudFormation stack (via SAM) containing: 3 Lambdas, SQS queue + DLQ, EventBridge schedules, Function URL, CloudWatch alarms, SNS email topic, IAM roles
- An S3 bucket SAM creates automatically for deployment artifacts
- A **deploy identity** for GitHub Actions (an OIDC role, or an IAM user if the organization blocks OIDC) — defined in
  `infra/github-deploy-access.yaml`, created once by you (Part 5, step 2)
- After deploy, you must **click the confirmation link** in the SNS subscription email, or alarms won't reach you

## Known unknowns to verify on first deploy
- The Free plan restricts some services; Lambda, SQS, EventBridge, CloudWatch, SNS and CloudFormation are expected to work, but the first `sam deploy` will confirm it.
- New accounts can have a low Lambda concurrency limit (~10); we cap worker concurrency accordingly.
- Cleanup when finished: `sam delete` removes everything we created.
