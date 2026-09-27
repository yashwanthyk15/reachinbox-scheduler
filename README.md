# ReachInbox Email Scheduler

A small full-stack email operations dashboard with a TypeScript/Express API, PostgreSQL, BullMQ/Redis, Elasticsearch, Ethereal SMTP, Google sign-in, and Slack rate-limit alerts.

## Run Locally

Prerequisites: Node.js 20+, npm, Docker Desktop, a Google OAuth client, a Slack app, and one or more Ethereal Email accounts.

1. Copy `.env.example` to `.env` and fill in the credentials described below. Keep `.env` private.
2. Start PostgreSQL, Redis, and Elasticsearch:

   ```powershell
   docker compose --profile search up -d
   ```

   If a default port is already in use, change `POSTGRES_PORT`, `REDIS_PORT`, or `ELASTICSEARCH_PORT` in `.env` and update the corresponding connection URL above it to the same port.

3. Install packages and create the database schema and sender records:

   ```powershell
   npm install
   npm run db:generate
   npm run db:migrate
   npm run db:seed
   ```

4. Start the API, BullMQ worker, and frontend together:

   ```powershell
   npm run dev
   ```

   Open [http://localhost:5173](http://localhost:5173). The API health check is at [http://localhost:4000/health](http://localhost:4000/health). After Google sign-in, the live BullMQ view is at [http://localhost:4000/admin/queues](http://localhost:4000/admin/queues).

For separate processes use `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web`. Production builds with `npm run build`; run `npm --workspace backend run start:api` and `npm --workspace backend run start:worker` after setting the same environment variables. Serve the frontend build from `frontend/dist` and set `VITE_API_URL` to the API origin at build time.

## Credentials

### Ethereal SMTP

Create one or more test accounts at [ethereal.email](https://ethereal.email/create). Add each account to `ETHEREAL_ACCOUNTS` as a JSON array in `.env`:

```dotenv
ETHEREAL_ACCOUNTS=[{"name":"Primary","email":"sender@ethereal.email","host":"smtp.ethereal.email","port":587,"secure":false,"user":"ethereal-user","pass":"ethereal-password","maxPerHour":200}]
```

Use a separate object for each sender. `npm run db:seed` stores the sender configuration in PostgreSQL; SMTP passwords are encrypted using a key derived from `SESSION_SECRET`. Keep that secret stable between restarts or stored SMTP and Slack credentials cannot be decrypted. Ethereal captures mail for inspection and does not deliver to real recipients. Successful sends print an Ethereal preview URL in the worker output.

### Google Login

Create a Google OAuth 2.0 Web client. Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` in `.env`. Production deployments must use HTTPS callback URLs and secure cookie settings. There is no mock or local bypass login.

### Slack Alerts

Create a Slack app and enable OAuth. Set its redirect URL to `http://localhost:4000/auth/slack/callback`; add bot token scopes `chat:write`, `users:read`, and `im:write`. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_CALLBACK_URL`. The dashboard's **Connect Slack** control starts Slack's OAuth flow. The bot token is stored encrypted per signed-in user. The worker opens a DM with the installing user and posts when a sender's hourly cap is reached. Disconnect removes the stored integration. If Slack is not connected, delivery continues without an alert; a later connection can receive a notification on a subsequent rate-limit hit in the same hour.

### Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | BullMQ and session store connection |
| `ELASTICSEARCH_URL` | Email search index endpoint |
| `SESSION_SECRET` | Express session signing and credential-encryption key material |
| `WORKER_CONCURRENCY` | Concurrent BullMQ jobs per worker process (default `10`) |
| `MIN_SEND_DELAY_MS` | Cross-worker minimum sender gap (default `2000`, or 2 seconds) |
| `RATE_LIMIT_WINDOW_MS` | UTC-aligned rate-limit window (default `3600000`, or 1 hour) |
| `MAX_EMAILS_PER_HOUR` | Global ceiling applied to sender limits (default `200`) |
| `ETHEREAL_ACCOUNTS` | JSON array of sender credentials and sender-specific caps |
| `PORT`, `FRONTEND_URL` | API port and browser origin |
| `GOOGLE_*`, `SLACK_*` | OAuth client IDs, secrets, and callback URLs |

See `.env.example` for the complete template. Never commit real values.

## Architecture

- **Scheduling and persistence:** `POST /api/emails` validates recipients, persists one `Email` row per recipient and an idempotency-keyed batch in PostgreSQL, bulk-adds delayed BullMQ jobs, and indexes the scheduled records in Elasticsearch. Retrying a request with the same `Idempotency-Key` returns the same email IDs; reusing that key with a different payload returns `409`. Jobs also use stable email-derived IDs. No cron process or cron library is used. BullMQ's Redis-backed delayed set controls when work becomes eligible.
- **Restart recovery:** Redis AOF and Docker volumes persist queue state. On worker startup, a reconciliation scan finds database rows still marked `SCHEDULED` and restores missing queue jobs at their original `scheduledAt`. Existing waiting, delayed, or active jobs are left alone. PostgreSQL conditional state changes guard duplicate concurrent job execution; `SENT` and `FAILED` rows are not enqueued again.
- **SMTP delivery:** A worker loads the sender account from PostgreSQL and sends through Nodemailer to Ethereal SMTP. Job retries use BullMQ exponential backoff. On success it records `SENT` and `sentAt`; exhausted delivery attempts become `FAILED` and retain the SMTP error.
- **Concurrency and send spacing:** `WORKER_CONCURRENCY` controls each worker. A Redis Lua script atomically reserves a sender-wide send slot, counter, and next-send timestamp across worker processes. The spacing is at least `MIN_SEND_DELAY_MS` and respects the batch's requested delay. For example, the defaults enforce at least 2 seconds between individual sends from the same sender, even when multiple jobs are active.
- **Rate-limit window:** Each sender has a persisted `maxPerHour`, initially populated from its sender configuration. The compose form's requested cap updates that sender-wide setting; the effective cap is the smaller of it and `MAX_EMAILS_PER_HOUR`. Redis counters are keyed by sender and UTC-aligned `RATE_LIMIT_WINDOW_MS` windows. The default is one hour. For a faster local demo only, set this to `300000` (5 minutes) in `backend/.env` and set `VITE_RATE_LIMIT_WINDOW_MS=300000` in `frontend/.env`; the dashboard label reflects the shorter window. Restore both to the 1-hour default for production. Once a bucket is full, the active BullMQ job is moved to the next window with `moveToDelayed`; it is not discarded or marked failed. Slot reservations follow worker acquisition order, so ordering is best-effort under concurrency rather than a strict FIFO guarantee. Use separate sender accounts for independent rate policies.
- **Slack rate alerts:** A rate-limit hit triggers a real Slack Web API DM (`conversations.open`, then `chat.postMessage`) to the user who installed the app. Redis suppresses duplicate notices for that sender and window after a successful notification. Slack failures are logged without failing email delivery.
- **Search:** Scheduled, sent, and failed email records are indexed in Elasticsearch and searched through `GET /api/emails/search?q=...`, scoped to the signed-in user. Queue/database work succeeds even if indexing temporarily fails; an indexing error is logged. Elasticsearch should be monitored as a separate dependency.
- **Queue visibility:** Bull Board is mounted at `/admin/queues` and requires Google-authenticated access.
- **Frontend:** React, TypeScript, and Vite provide OAuth entry, sender selection, CSV/text lead parsing, schedule controls, scheduled/sent views, search, Slack connection management, and loading/empty/error states.

### Delivery Semantics and Trade-offs

PostgreSQL conditional claims prevent normal concurrent duplicate sends, and completed database rows are not automatically restarted. SMTP does not support a transaction shared with PostgreSQL: if a process dies after the SMTP server accepted a message but before the `SENT` update commits, the external outcome is unknowable. To avoid automatic duplicate delivery, that in-flight row remains `SENDING` and is visible for operator review rather than being blindly resent. This is the unavoidable boundary of exactly-once delivery over ordinary SMTP. A future production extension could add an explicit reconciliation action or use a provider with idempotency keys.

## API

- `GET /api/me` returns the signed-in user.
- `GET /api/senders` lists configured active senders.
- `POST /api/emails` schedules a batch. Include an `Idempotency-Key` request header. Body: `{ "recipients": ["person@example.com"], "senderId": "...", "subject": "...", "body": "...", "scheduledAt": "2026-09-27T12:00:00.000Z", "delayMs": 2000, "hourlyLimit": 200 }`.
- `GET /api/emails?folder=scheduled|sent` lists the current user's email activity.
- `GET /api/emails/search?q=...` searches indexed email activity.
- `GET /api/slack` and `DELETE /api/slack` inspect/disconnect Slack; `GET /auth/slack` begins OAuth.
- `GET /health` checks PostgreSQL and Redis connectivity.

All `/api` endpoints except `/api/me`'s authentication probe require a Google-authenticated session.

## Demo Checklist

1. Sign in with Google and connect the Slack workspace.
2. Compose a message, upload a CSV/text file with several addresses, set a future start time, delay, and hourly cap, then schedule it.
3. Show the scheduled table and Bull Board. After due time, show the sent table and Ethereal preview URL.
4. Schedule another message for the future, stop the API and worker, restart them with Redis/PostgreSQL still running, and show that the job remains delayed and later sends.
5. For a rate-limit demonstration, configure a low sender cap, queue more emails than fit in the current hour, then show the Slack DM and delayed BullMQ jobs.

Do not run `docker compose down -v` during the restart demonstration; `-v` deletes the persisted database, Redis queue, and search data.