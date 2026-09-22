# Auth email templates

The mail a player gets when they use `Forgot password?`.

| File | What it is |
|---|---|
| `recovery.html` | The body. Source of truth - edit here, never in the dashboard. |
| `recovery.subject.txt` | The subject line. |
| `apply.py` | Pushes both onto the live project and reads them back. |
| `../../test/email_templates.mjs` | The gate. Runs in CI. |

## Applying it

```
python supabase/templates/apply.py          # push, then read back
python supabase/templates/apply.py --check  # read the live values, change nothing
```

`--check` prints the live auth config - SMTP, rate limit, subject, body size -
and exits `0` only when the mail a player receives is the one in this repo.
Exit `1` means it is not live. Run it before and after any change; that exit
code is the proof, not the console output.

It needs `SUPABASE_PAT` (a personal access token with write access to this
project's auth config) and `SUPABASE_PROJECT_REF`, from the environment or from
a `key=value` file pointed at by `SKYHOOK_SECRETS`. **No token belongs in this
repo.** Mint one at <https://supabase.com/dashboard/account/tokens>.

The dashboard's own template editor is read-only for this project, so the
Management API (`PATCH /v1/projects/{ref}/config/auth`) is the only way in.

## Blocked: the free tier will not accept a custom template

As of 2026-09-21 the PATCH is refused:

```
400 {"message":"Email template modification is not available for free tier
projects using the default email provider. Please upgrade your plan or
configure a custom SMTP provider."}
```

So players still receive Supabase's stock reset mail. Confirmed live on
2026-09-22 by `apply.py --check`: `smtp_host` is `null`, the live recovery body
is Supabase's 254-byte default, and `rate_limit_email_sent` is `2` per hour.

## Unblocking it: custom SMTP, and why Resend

Supabase Pro also lifts the restriction, but it buys nothing else this project
needs right now and the domain still ends up wanting SPF/DKIM. So: custom SMTP.
Four candidates, checked 2026-09-22:

| Provider | Free volume | Own domain needed? | Vendor logo on free? | Card to sign up? |
|---|---|---|---|---|
| **Resend** | 3,000/mo, 100/day | yes, to mail anyone but yourself | **no** | no |
| Brevo | 300/day | sender verification at minimum | **yes**, on every mail | no |
| Mailjet | 6,000/mo, 200/day | sender verification at minimum | **yes**, on every mail | no |
| Amazon SES | not free off EC2 (~$0.10/1k) | yes, plus a sandbox-exit request | no | **yes**, AWS account |

**Resend wins on the one axis this PR exists for.** Brevo and Mailjet stamp
their own logo into free-tier mail, which turns a carefully branded reset mail
into an ad for someone else. SES needs a card and a support ticket to leave the
sandbox. Resend is a plain SMTP relay that delivers the MIME body it is given,
its free ceiling is ~33x the traffic this game generates, and its credentials
are exactly the four fields Supabase's form asks for.

The one thing to check on the first real send is that Resend truly adds no
footer - their docs never mention one, but third-party review sites disagree,
so verify rather than trust: send a reset to a throwaway inbox
(`api.mail.tm`, see `_shared/free-apis-registry.md`) and read the raw body.
If a footer shows up, the same DNS records work for Mailjet - only the Supabase
host/user/pass change.

Volume sanity check: `rate_limit_email_sent` goes from 2/hour to 30/hour when
custom SMTP is on, which caps the project at 720/day against Resend's 100/day.
The Supabase limit is the wrong one to lean on; 100/day is the real ceiling and
it is far above anything this game does.

### Step 1 - DNS (Leo, at GoDaddy)

Three records on `skyhookplay.com`, written out copy-paste ready in
`atlas/data/skyhook-smtp-dns-steps.txt` in the leo-agents repo:

| Type | Name | Value | TTL |
|---|---|---|---|
| MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | 600 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | 600 |
| TXT | `resend._domainkey` | the `p=...` key Resend generates per domain | 600 |

The apex has no SPF and no MX today, and it must stay that way - these records
live on the `send` subdomain so Fly's `A`/`AAAA`/`CNAME` rows are untouched.
The existing `_dmarc` record is `v=DMARC1; p=quarantine; adkim=r; aspf=r` -
relaxed alignment, so a signature on `send.skyhookplay.com` counts as
`skyhookplay.com`. Do not edit it.

### Step 2 - Supabase SMTP form

Dashboard > Authentication > Emails > SMTP Settings, i.e.

<https://supabase.com/dashboard/project/ievfcqnyrekdixxbsite/auth/smtp>

| Field on the form | Value | API key it writes |
|---|---|---|
| Enable Custom SMTP | on | - |
| Sender email | `noreply@skyhookplay.com` | `smtp_admin_email` |
| Sender name | `SKYHOOK` | `smtp_sender_name` |
| Host | `smtp.resend.com` | `smtp_host` |
| Port number | `587` | `smtp_port` |
| Username | `resend` (the literal word) | `smtp_user` |
| Password | the `re_...` Resend API key | `smtp_pass` |
| Minimum interval between emails | leave at `60` | `smtp_max_frequency` |

Port 587 is STARTTLS and is what Supabase documents. Resend also answers on
465/2465 (implicit TLS) and 25/2587; use 587 unless it is blocked.

Then Authentication > Rate Limits: Supabase drops a 30/hour limit on a freshly
configured SMTP service to protect its reputation. Leave it there - it is 15x
the current limit and below Resend's daily cap.

### Step 3 - push the template

```
python supabase/templates/apply.py
```

The PATCH that returned 400 above now succeeds, and `--check` flips to
`VERDICT: the SKYHOOK reset mail is LIVE` with exit 0.

Nothing else in the reset flow is blocked - it has worked end to end since
PR #18.

## Rules the template keeps to

`test/email_templates.mjs` enforces all of these; it is not documentation that
can drift.

- `{{ .ConfirmationURL }}` verbatim, and it is the only link besides
  `skyhookplay.com`. GoTrue rewrites it into
  `.../auth/v1/verify?token=...&type=recovery&redirect_to=...`, and
  `type=recovery` is what `consumeRedirect()` in `js/online.js` keys off to
  tell a sign-in apart from a password recovery. Wrap it, shorten it or swap it
  for `{{ .SiteURL }}` and the reset flow breaks with no error anywhere.
- Tables and inline styles only. No `<style>`, no `<link>`, no webfont, no
  image, no JavaScript - Gmail strips the first two, Outlook blocks the rest.
- The raw URL is printed as visible text under the button. GoTrue sends a
  single `text/html` part, so that line is the whole plain-text fallback.
- ASCII only, or clients that guess the charset show mojibake.
- Colours come from `css/style.css`, and the test asserts they are still in the
  stylesheet, so "branded" cannot quietly become false.

## Live settings this template depends on

Read from the API on 2026-09-21, re-read 2026-09-22, not from memory:

| Setting | Value | Why it matters |
|---|---|---|
| `site_url` | `https://skyhookplay.com/` | Where a link with no `redirect_to` lands. Correct - the GitHub Pages URL in `scout/data/skyhook_supabase_task_state.json` is stale bookkeeping, not live config. |
| `uri_allow_list` | includes `https://skyhookplay.com/**` | `requestPasswordReset()` sends `redirect_to`; GoTrue drops it unless it is allow-listed. |
| `mailer_otp_exp` | `3600` | The "expires in 1 hour" line in the mail is true. |
| `rate_limit_email_sent` | `2` per hour, project-wide | Built-in SMTP. Testing resets in bulk will hit this. Becomes `30` with custom SMTP. |
| `smtp_host` | `null` | No custom SMTP yet. This is the field that gates everything above. |
