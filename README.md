# Healthcare follow-up backend

NestJS service for WhatsApp patient follow-up, staff review, and ClinOps integration.

## Local setup

Use Node 22, PostgreSQL, and Redis. Copy `.env.example` to `.env`, set `DATABASE_URL`, `REDIS_URL`, and a strong `JWT_SECRET`, then run:

```sh
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm test -- --runInBand
npm run start:prod
```

The seed command (`node dist/src/platform/database/seed.js`) requires `SEED_ADMIN_EMAIL` and a unique `SEED_ADMIN_PASSWORD` of at least 16 characters to create an admin account. It does not rotate existing passwords.

`CLINOPS_MODE` may be `mock` or `live`. When blank, all three ClinOps settings (`CLINOPS_BASE_URL`, `CLINOPS_USERNAME`, `CLINOPS_PASSWORD`) select live mode; none select mock mode. Partial credentials cause startup to fail. Explicit `mock` keeps local fixtures even when WhatsApp credentials are configured. **Mock mode can still send real WhatsApp messages** if Meta credentials are configured; use only approved test recipients and templates.

Live requests use the methods and paths in [the external ClinOps reference](docs/clinops-api-external.html). The client does not discover endpoints. Contract tests use fake transport responses; they do not prove the deployed ClinOps service accepts the requests. Live booking confirmation requires a verified patient ID, specialty ID, motif, and available doctor. An uncertain upstream booking result is marked `RECONCILE` and must be checked in ClinOps before any retry.

Inbound booking asks for the patient's name and brief reason, then records a specialty, doctor, date, and time selected from the available options. Follow-up rebooking records a reason, doctor or specialty, and date and time preferences for staff review. A rebooking request leaves the prior confirmed appointment active: the documented ClinOps API has no cancellation operation. Staff must review and resolve the old appointment in ClinOps before confirming the new request. Model-extracted preferences and phone matches still require staff verification; they are not proof of patient identity or clinical suitability.

Campaign jobs are persisted before they are queued. The scheduler rediscovers pending jobs after a crash. An opening send is reserved as `SENDING` before contacting Meta; an uncertain send stays there for staff reconciliation. Reminders require `CAMPAIGN_REMINDER_TEMPLATE_NAME`, an approved Meta template with patient name and visit date as its two body parameters. An uncertain reminder sets `reminderAttemptState=RECONCILE`. These states deliberately block automatic retry. Explicit STOP, unsubscribe, and supported French/Arabic equivalents create a persistent clinic-level suppression record and block future campaign contact. Staff must verify any ambiguous opt-out or send result before resetting it.

The same local Ollama model handles classification and campaign conversation. The default tag is `qwen3.5:4b` with an 8192-token context budget. This small model is for local development evaluation only; latency, French/Arabic/Darija quality, and clinical safety require measured tests before patient use. The backend repository does not download the model automatically.

## Verification and deployment

The `Backend CI` GitHub Actions workflow runs on every pushed branch and pull request. It installs locked dependencies, audits them, generates Prisma, enforces import boundaries, builds, runs tests, and builds the Docker image. Production deployment runs only after CI succeeds on `main`. It stops on migration failure and waits for database and Redis health through the container health check.

Do not merge solely because CI passes. Before patient use, validate the ClinOps contract with authorized staging credentials; update the separate dashboard to supply verified booking fields and show `RECONCILE` and `SENDING` states; obtain clinic-approved consent, opt-out, emergency escalation, retention, and WhatsApp template policies; and test restart/retry behavior with a non-patient staging account. Reconciliation is currently a manual operator task, with no dashboard workflow to resolve an uncertain outcome.
