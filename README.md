# Collabry

Collabry is a secure collaboration workspace for final-year project teams, supervisors, reviewers, and university groups.

## Production Deployment

1. Create a production Supabase project, apply every migration in `supabase/migrations`, and keep the `project-files` and `message-attachments` buckets **private**.
2. In Authentication settings set the Site URL to your live domain and add `https://YOUR_DOMAIN/auth/callback` as a redirect URL.
3. Set these environment variables on the host (Vercel, Docker, or similar). Never expose the service-role or Resend keys to the browser:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
GEMINI_API_KEY
GEMINI_MODEL=gemini-2.5-flash
RESEND_FROM_EMAIL
NEXT_PUBLIC_APP_URL=https://YOUR_DOMAIN
CRON_SECRET
```

4. Verify Resend with a domain you own, then confirm `GET /api/health` reports `database: connected`, `email: connected` **and** `emailSender: verified`. A verified API key with an unverified sender still fails every send, which is why both are reported.
5. Schedule `/api/jobs/run`. The route accepts `GET` (Vercel Cron) and `POST` (external schedulers) and authenticates with `x-cron-secret` or `Authorization: Bearer $CRON_SECRET`. `vercel.json` ships a once-daily schedule because the Vercel **Hobby** plan rejects anything more frequent; for timely reminders on Hobby, point a free external scheduler (cron-job.org, Upstash QStash, or a GitHub Actions schedule) at `https://YOUR_DOMAIN/api/jobs/run` every minute with the bearer header. On Pro the schedule can be `* * * * *`.
6. Smoke-test the real artifact before switching DNS: `npm run build && npm run start`, then sign in, open a task and a meeting, and confirm `/api/health` is green.

### Routes

Public: `/login` (sign-in and account creation), `/invite/[token]`, `/auth/callback`.
Authenticated: `/` (dashboard), `/projects`, `/timeline`, `/tasks/[id]`, `/meetings/[id]`, `/team`, `/reports`, `/files`, `/messages`, `/settings`.

### Live deployment: collabryy.tech

Canonical app URL: `https://collabryy.tech` (`www` redirects here). Transactional email is sent from `mail.collabryy.tech`, a send-only subdomain verified in Resend, so the root domain keeps its own inbox/SPF untouched.

DNS at the registrar (web records come from Vercel → Settings → Domains; email records from Resend → Domains; copy the exact names/values each dashboard shows):

| Type | Name | Value | Purpose |
| --- | --- | --- | --- |
| A | `@` | Vercel's A record | serves the app |
| CNAME | `www` | `cname.vercel-dns.com` | Vercel redirects to the apex |
| MX | `send.mail` | `feedback-smtp.<region>.amazonses.com` (priority 10) | Resend bounces |
| TXT | `send.mail` | `v=spf1 include:amazonses.com ~all` | SPF for the sending subdomain |
| TXT | `resend._domainkey.mail` | `p=...` | DKIM signature |
| TXT | `_dmarc` | `v=DMARC1; p=none; sp=none; rua=mailto:dmarc@collabryy.tech` | DMARC reporting |

Production environment:

```text
NEXT_PUBLIC_APP_URL=https://collabryy.tech
RESEND_FROM_EMAIL=Collabry <notifications@mail.collabryy.tech>
```

Supabase Auth: Site URL `https://collabryy.tech`, redirect URL `https://collabryy.tech/auth/callback`. Custom SMTP: `smtp.resend.com`, port `465`, username `resend`, password = Resend API key, sender `notifications@mail.collabryy.tech`, name `Collabry`. Without custom SMTP, confirmation emails stay on Supabase's shared sender and a few-per-hour limit.

### Email Resend sends

`src/lib/email.ts` renders one branded layout for every message, and `src/lib/notify.ts` fans them out to the people each event concerns:

| Event | Recipients | Subject |
| --- | --- | --- |
| Project invitation | The invited address | `<inviter> invited you to join <project> on Collabry` |
| Meeting scheduled | Attendees, minus the organiser | `Meeting scheduled: <title> — <weekday, date>` |
| Meeting rescheduled | Attendees | `Meeting rescheduled: <title> — <weekday, date>` |
| Meeting cancelled | Attendees | `Meeting cancelled: <title>` (no time table, no button) |
| Attendee added | The new attendee | `You've been added to <title> — <weekday, date>` |
| Reminder, 24 hours before | Team members | `Reminder: <title> starts tomorrow at <time>` |

Meeting times use the time zone stored on the meeting, so a session scheduled in `Asia/Karachi` prints Karachi time for everyone. Each send honours the recipient's stored `email_invitations` / `email_meetings` preference. Delivery never blocks the action that triggered it: an invitation is still created and the owner is shown the shareable link plus which of the three causes applied — `not-configured` (this deployment has no sender), `opted-out` (the recipient turned invitation email off in their own settings) or `provider` (Resend refused it, e.g. an unverified sender). Blaming the recipient for a server gap is the one answer the UI must never give. A meeting is still saved even when the provider is unreachable. Reminder emails need `NEXT_PUBLIC_APP_URL`; without a canonical host there is nothing to link to, so the job records the in-app notification and logs the skip.

`npm run test:integration` boots the server with a deliberately invalid Resend key so the suite can never send live mail to its throwaway `@example.com` accounts; it asserts the rejected-key reason reaches the API response. The unit suite (`npm run test:unit`) covers the copy, escaping, time-zone formatting and every provider failure message.


## Local Development

Requirements:

- Node.js 20+
- A Supabase project
- Optional Resend account for transactional email

Install and run:

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Configure `.env.local` with the values listed in [.env.example](.env.example). Never expose `SUPABASE_SERVICE_ROLE_KEY` or `RESEND_API_KEY` to browser code.

## Supabase Setup

1. Create a Supabase project.
2. Add the local callback URL in Authentication settings:

```text
http://localhost:3000/auth/callback
```

3. Apply the migrations in order through Supabase SQL Editor or the Supabase CLI:

```powershell
npx supabase db push
```

Migration order:

- `202610290001_foundation.sql`
- `202610300002_collaboration_modules.sql`
- `202610300003_invitation_acceptance.sql`
- `202610300004_storage_policies.sql`
- `202610300005_workflow_extensions.sql`
- `202610310006_workflow_extensions_backfill.sql`
- `202610310007_fix_conversation_rls_recursion.sql`

> Migration 5 must be applied before the task workflow, chat reactions, meeting
> action items, file quotas/submissions and the new screens will work. Migration 6
> is an idempotent re-application of migration 5 for databases that were provisioned
> before it landed; running both on a fresh project is safe.
> Migration 7 replaces the chat RLS policies that read their own protected tables
> (`conversation_members` and `conversations`), which made every authenticated
> conversation query fail with "infinite recursion detected in policy" and blocked
> new channels with "new row violates row-level security policy". Membership and
> ownership are now resolved through the `security definer` functions
> `is_conversation_member` and `is_conversation_creator`, the same pattern used by
> `is_team_member`. When writing policies, never read an RLS-protected table from
> inside that table's own policy (or from a policy on a table it guards) unless the
> read goes through a `security definer` helper.

4. Keep the `project-files` and `message-attachments` Storage buckets private.
5. Verify the Resend sender domain before enabling invitation email delivery.

## Validation

```powershell
npm run lint
npm run typecheck
npm run build
npm run verify:db        # checks all migrations, RLS and private buckets
npm run test:unit        # validation, authorization and date/time field helpers
npm run test:integration # boots the app: 82 checks with 3 throwaway users, then cleans up
npm test                 # unit + integration
```

`test:integration` requires a fresh `npm run build` first and creates/deletes real
users in the configured Supabase project. It covers cross-team isolation, private
files, invitations, rate limiting, the audit trail, team chat, and the task/meeting
detail endpoints (author-only comment edits, reviewer roles, assignee-scoped action
items, manager-only minutes and attendance) and the scheduled-job endpoint (a due meeting
reminder, the notification it produces, and the cron secret guard) when `CRON_SECRET` is
set. The suite boots its own server with a Resend key that cannot deliver, so it never
sends live mail. The Resend probe in `verify:db` needs
outbound HTTPS; on a network that cannot reach `api.resend.com` it reports a single
network failure while every database check still runs. `verify:db` also confirms that the
domain in `RESEND_FROM_EMAIL` is one of the verified sending domains on the Resend account.

## Implemented

- [x] Next.js App Router foundation with strict TypeScript.
- [x] Premium responsive Collabry visual system.
- [x] Collabry purple C logo and favicon.
- [x] Login, signup, email verification callback, logout, and Supabase SSR session handling.
- [x] Protected dashboard redirect for unauthenticated users.
- [x] Transaction-safe team creation with owner membership.
- [x] Team-scoped roles and RLS policies.
- [x] Invitation creation with role validation, expiration, hashed tokens, and recipient checks.
- [x] Invitation acceptance API and branded invitation page.
- [x] Live team loading on the authenticated dashboard.
- [x] Task list and task creation API/UI.
- [x] Meeting list and meeting scheduling API/UI with timezone-aware timestamps.
- [x] Conversation and message APIs with membership enforcement.
- [x] Realtime message subscription in the chat workspace.
- [x] Protected private-file upload, listing, and signed-download APIs.
- [x] Private Storage bucket policies and file-library UI.
- [x] Notifications API, unread state, and mark-as-read UI.
- [x] Server-only Resend invitation email integration.
- [x] Resend meeting emails: scheduled, rescheduled, cancelled, added and the 24-hour reminder, with preference enforcement and provider reasons surfaced.
- [x] Team member directory and protected member removal.
- [x] PWA manifest and production service-worker shell.
- [x] Navigation to dashboard, messages, files, and team routes.
- [x] TypeScript diagnostics and ESLint validation during implementation.
- [x] Task detail screen (`/tasks/[id]`) with editing, assignment, checklist, comments, review decisions, file linking, activity history and delete.
- [x] Meeting detail screen (`/meetings/[id]`) with RSVP, rescheduling, minutes and decisions, task-linked action items, and attendance.
- [x] Dashboard, timeline and notification entries deep-link to the task and meeting detail screens.
- [x] Mobile burger navigation (≤900 px) with separate Workspace and Communication groups, so Messages and Files are no longer workspace tabs.
- [x] Dedicated Projects screen with search, filtering, pagination and owner project settings.
- [x] Dedicated Timeline/calendar screen with day grouping, attendee selection and RSVP controls.
- [x] Calendar and clock-dial pickers for every date and time field (meetings, task due dates, project start and target dates): defaults to the next clean half-hour slot, keeps the meeting length when the start moves, offers Today/Tomorrow/Next week and 30 min–2 h chips, and blocks an end time that is not after the start. Below 700 px the panel opens as a bottom sheet with a pinned Done row.
- [x] Dedicated Reports screen computed from live database figures, with CSV export.
- [x] Dedicated Settings screen for profile and notification preferences.
- [x] Task editing, assignment, comments, checklists, reviews and status history.
- [x] Meeting cancellation, rescheduling, minutes, decisions, attendance and linked action items.
- [x] Conversation member management, message pagination, edit/delete, reactions and typing indicators.
- [x] Message attachments with signed downloads and attachment previews in chat.
- [x] File search, category/status filtering, storage quotas and submission/review status.
- [x] Announcement API plus timeline display.
- [x] Notification preference enforcement, browser notification permission and service-worker push handlers.
- [x] Durable scheduled jobs with optimistic locking, retries, backoff and deduplication.
- [x] Rate limiting on invitations, uploads, messages, task/meeting/conversation creation and profile changes.
- [x] Security headers and a production Content Security Policy.
- [x] Audit logging for role, membership, project, invitation, file, task, meeting and profile changes.
- [x] Server-only service-role client used for audit, notifications and job queues.
- [x] Authenticated integration test suite covering cross-team isolation, invitations, storage, chat and the task/meeting detail endpoints.

## Required For Production Completion

### External Setup

- [ ] Add production Supabase and Resend environment variables in the deployment platform.
- [ ] Apply and verify all seven Supabase migrations in the production project.
- [ ] Verify Resend sender domain and production email delivery. `mail.collabryy.tech` is verified; the deployment must send from it, so `RESEND_FROM_EMAIL=Collabry <notifications@mail.collabryy.tech>` has to match (a sender on any other domain fails every send with HTTP 403).
- [ ] Set `NEXT_PUBLIC_APP_URL=https://collabryy.tech` in production. Without it, invitation links take the host of whichever request created them (`www` before the apex redirect) and scheduled reminder emails are skipped for lack of a canonical link.
- [ ] Configure production Supabase Auth site URL and redirect URLs.
- [ ] Confirm private Storage buckets and Storage policies in production.
- [ ] Rotate any secrets that were exposed during development or chat.

### Product Features

- [x] Add dedicated Projects screen with search, filtering, pagination, and project settings.
- [x] Add dedicated Timeline/calendar screen with meeting attendee selection and RSVP.
- [x] Add dedicated Reports screen using real database figures and export options.
- [x] Add Settings screen for profile and notification preferences.
- [x] Complete task editing, assignment, comments, checklists, reviews, and status history.
- [x] Add a task attachment picker UI (files can be linked to tasks directly in the files library upload UI with linked task badges).
- [x] Complete meeting cancellation, rescheduling, minutes, decisions, attendance, and task-linked action items.
- [x] Complete conversation creation/member management, pagination, message editing/deletion, reactions, typing indicators, and attachment previews.
- [x] Add file search, categories, quotas, submission/review status (task linking available through the upload API).
- [x] Add a dedicated announcement composer screen (broadcast announcements directly from the Timeline screen).
- [x] Add notification preference enforcement and browser push permissions.
- [ ] Add server-side web push subscriptions (VAPID/web-push) for notifications while the tab is closed.
- [x] Add durable scheduled jobs for reminders with retries and deduplication.

### Security And Reliability

- [x] Add authenticated integration tests for two separate users (`npm run test:integration`).
- [x] Test cross-team IDOR and RLS isolation for tasks, teams, members, files, reports and audit logs.
- [x] Test invitation expiration, revocation, duplicate prevention, and wrong-recipient rejection.
- [x] Test private Storage access, signed URL expiry, and file signature/type restrictions.
- [x] Add rate limiting for invitations, uploads, messages, comments and sensitive mutations (sign-in is handled by Supabase Auth).
- [x] Add security headers and a production-compatible Content Security Policy.
- [x] Add audit-log assertions for role, membership, project, and permission changes.
- [x] Add error monitoring, backups, and deployment health checks (`GET /api/health` and `GET /api/jobs/run`).
- [ ] Set `CRON_SECRET` in the deployment platform and schedule `/api/jobs/run` at least every five minutes (Vercel Hobby caps native crons at once per day; use an external scheduler there).

### Quality

- [x] Add unit tests for validation, authorization and email helpers (`npm run test:unit`).
- [x] Add Supabase integration tests for RLS and cross-team isolation.
- [ ] Add Playwright end-to-end tests for signup, team creation, invitation acceptance, task creation, meetings, chat, and private files.
- [ ] Run accessibility checks with keyboard navigation and screen readers.
- [x] Mobile layout verified in the browser at 524 px, including the burger drawer.
- [ ] Desktop and tablet layout pass in a real browser at ≥1024 px before launch (the stylesheet is desktop-first; only the ≤900 px and ≤700 px rules change).
- [x] Run a clean production build locally (`npm run build`) and smoke-test `npm run start` across every screen.
- [x] Add a CI pipeline that runs lint, typecheck, unit tests and build (`.github/workflows/ci.yml`).
- [x] Resolve remaining Next.js/package-lock workspace warnings before deployment.

## Security Notes

- `.env.local` is ignored by Git and must never be committed.
- The service-role key and Resend key are server-only secrets; `CRON_SECRET` guards the job runner.
- Private files must never be served through public Storage URLs.
- Authorization must remain enforced by Supabase RLS and server-side checks, not only hidden UI controls.
- Do not use mock data to represent a completed backend feature.
- PostgREST cannot embed `profiles` through `user_id` foreign keys; use `loadProfiles`/`attachProfiles` from `src/lib/profiles.ts` instead.

## Next-Agent Prompt

Copy the prompt below into another coding agent to continue the project:

```text
You are continuing the Collabry project in the current workspace.

First read README.md, .env.example, the current Supabase migrations, and the existing route files. Do not claim features are complete without testing them. Do not replace real backend work with mock data.

Current implemented areas include:
- Next.js App Router and strict TypeScript
- Supabase SSR authentication and protected dashboard
- Team creation, roles, invitations, and RLS
- Tasks (detail screen with checklist, comments, reviews, file links), meetings (detail screen with minutes, decisions, action items, attendance), conversations with realtime messages
- Private files, signed downloads, Storage policies
- Notifications, Resend emails for invitations and meeting changes/reminders
- Team directory, Projects/Timeline/Reports/Settings screens, PWA shell, and premium responsive UI with a mobile burger drawer

Remaining work before launch:
1. Apply the seven migrations and set the environment variables in the production Supabase project and host.
2. Verify the Resend sender domain and confirm `GET /api/health` returns `email: connected` and `emailSender: verified`.
3. Set `CRON_SECRET` and schedule `POST /api/jobs/run` every minute.
4. Add Playwright coverage for signup, invitations, task/meeting detail screens, chat and file upload.
5. Run an accessibility pass with keyboard navigation and a screen reader.
6. Do a desktop/tablet visual pass at ≥1024 px in a real browser.
7. Add server-side web push (VAPID/web-push) for notifications while the tab is closed.

Then re-run `npm run lint && npm run typecheck && npm run build && npm test` and update the checklists in README.md accurately.

Preserve the Collabry visual language and do not break the existing home page UI. Do not introduce mock data. Keep all private data protected by server authorization and Supabase RLS.
``` 
