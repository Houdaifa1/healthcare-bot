# Healthcare follow-up backend

NestJS service for WhatsApp patient follow-up, staff review, and ClinOps integration.

## Local setup

Use Node 20, PostgreSQL, and Redis. Copy `.env.example` to `.env`, set `DATABASE_URL`, `REDIS_URL`, and a strong `JWT_SECRET`, then run:

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

The same local Ollama model handles classification and campaign conversation. The default tag is `qwen3.5:9b` with an 8192-token context budget. The 16 GB Mac recommendation is for development evaluation only; latency, French/Arabic/Darija quality, and clinical safety require measured tests before patient use. The default model is not downloaded by setup.

## Verification and deployment

The `Backend CI` GitHub Actions workflow runs on every pushed branch and pull request. It installs locked dependencies, audits them, generates Prisma, enforces import boundaries, builds, runs tests, and builds the Docker image. Production deployment runs only after CI succeeds on `main`. It stops on migration failure and waits for database and Redis health through the container health check.

Do not merge solely because CI passes. Before patient use, validate the ClinOps contract with authorized staging credentials; update the separate dashboard to supply verified booking fields and show `RECONCILE` state; obtain clinic-approved consent, opt-out, emergency escalation, retention, and WhatsApp template policies; and test restart/retry behavior with a non-patient staging account. Campaign sends and reminders still need durable delivery reconciliation to prevent missed or duplicate contact after crashes.
