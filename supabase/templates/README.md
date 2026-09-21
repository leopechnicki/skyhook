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
python supabase/templates/apply.py          # push, then verify by reading back
python supabase/templates/apply.py --check  # read the live values, change nothing
```

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

So players still receive Supabase's stock reset mail. Unblocking it needs one
of:

1. **Custom SMTP** (Resend, Brevo, Mailjet, SES - all have a free tier big
   enough for this game). Set it under Authentication > Emails > SMTP Settings,
   then run `apply.py`. Best done with a sender on `skyhookplay.com` and SPF +
   DKIM records at the registrar, otherwise reset mail lands in spam, which is
   worse than a plain-looking mail that arrives.
2. **Supabase Pro.** Lifts the restriction without a second vendor.

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

Read from the API on 2026-09-21, not from memory:

| Setting | Value | Why it matters |
|---|---|---|
| `site_url` | `https://skyhookplay.com/` | Where a link with no `redirect_to` lands. Correct - the GitHub Pages URL in `scout/data/skyhook_supabase_task_state.json` is stale bookkeeping, not live config. |
| `uri_allow_list` | includes `https://skyhookplay.com/**` | `requestPasswordReset()` sends `redirect_to`; GoTrue drops it unless it is allow-listed. |
| `mailer_otp_exp` | `3600` | The "expires in 1 hour" line in the mail is true. |
| `rate_limit_email_sent` | `2` per hour, project-wide | Built-in SMTP. Testing resets in bulk will hit this. |
