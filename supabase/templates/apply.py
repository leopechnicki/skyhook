#!/usr/bin/env python3
"""Push the versioned SKYHOOK auth email templates onto the live Supabase project.

The dashboard's template editor is READ ONLY on the built-in SMTP service
("Set up custom SMTP to edit templates"), so the Management API is the way in:

    PATCH https://api.supabase.com/v1/projects/<ref>/config/auth
        { "mailer_subjects_recovery": ..., "mailer_templates_recovery_content": ... }

Credentials are never stored in this repo. The script wants:

    SUPABASE_PAT        a personal access token (sbp_...) with write access to
                        this project's auth config
    SUPABASE_PROJECT_REF  the project ref

Either from the environment, or from a key=value file pointed at by
SKYHOOK_SECRETS (Leo's machine: C:/Users/leops/skyhook_supabase.local.txt).

    python supabase/templates/apply.py            # apply, then read back
    python supabase/templates/apply.py --check    # read back only, change nothing

Both modes end by printing the live auth config and exit 0 only if the mail a
player would receive right now is the one in this repo. Exit 1 means it is not
live - which is the honest answer while the project is still on the built-in
mailer. See README.md for how to unblock that.

The leading documentation comment in recovery.html is stripped before sending:
it is here for whoever edits the file, not for the player's inbox.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.supabase.com/v1/projects/{ref}/config/auth"


def load_secrets():
    """Environment first, then the local key=value file. Never the repo."""
    pat = os.environ.get("SUPABASE_PAT")
    ref = os.environ.get("SUPABASE_PROJECT_REF")
    path = os.environ.get("SKYHOOK_SECRETS", "C:/Users/leops/skyhook_supabase.local.txt")
    if (not pat or not ref) and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            kv = dict(
                line.split("=", 1)
                for line in fh.read().splitlines()
                if "=" in line and not line.lstrip().startswith("#")
            )
        pat = pat or kv.get("SUPABASE_PAT", "").strip()
        ref = ref or kv.get("PROJECT_REF", "").strip()
    if not pat or not ref:
        sys.exit(
            "Need SUPABASE_PAT and SUPABASE_PROJECT_REF (env, or a key=value file "
            "at $SKYHOOK_SECRETS). Mint a token at "
            "https://supabase.com/dashboard/account/tokens - do not commit it."
        )
    return pat, ref


def body_to_send(html):
    """Drop the editor-facing comment that sits above the doctype."""
    return re.sub(r"^\s*<!--.*?-->\s*", "", html, count=1, flags=re.S)


def check(name, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + name + (" - " + detail if detail else ""))
    return ok


def validate(html, subject):
    """The rules the template has to keep to survive a real mail client."""
    good = True
    good &= check("subject is non-empty", bool(subject.strip()))
    good &= check(
        "{{ .ConfirmationURL }} present",
        html.count("{{ .ConfirmationURL }}") >= 2,
        "button href + copyable text",
    )
    good &= check("ASCII only", all(ord(c) < 128 for c in html))
    good &= check("no external stylesheet", "<link" not in html.lower())
    good &= check("no <style> block Gmail can strip", "<style" not in html.lower())
    good &= check("no script", "<script" not in html.lower())
    good &= check("no remote image", not re.search(r"<img\b", html, re.I))
    good &= check(
        "no stale GitHub Pages URL", "leopechnicki.github.io" not in html
    )
    # The raw URL must be visible text somewhere, not only inside an href:
    # that line is the fallback for a client that strips the HTML.
    good &= check(
        "raw link also rendered as text",
        re.search(r">\s*\{\{ \.ConfirmationURL \}\}\s*<", html) is not None,
    )
    return good


def api(ref, pat, method="GET", payload=None):
    req = urllib.request.Request(
        API.format(ref=ref),
        method=method,
        data=json.dumps(payload).encode() if payload else None,
        headers={
            "Authorization": "Bearer " + pat,
            **({"Content-Type": "application/json"} if payload else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        sys.exit("%s %s failed: %s %s" % (method, "config/auth", exc.code, exc.read().decode()[:600]))


def report_live(cfg, subject, sending):
    """Print exactly what the project is serving to players right now.

    Run before a change to show the starting point, and after to prove the
    change landed. Everything here is read from the live config, never cached.
    """
    live_subject = cfg.get("mailer_subjects_recovery")
    live_body = cfg.get("mailer_templates_recovery_content") or ""
    custom_flags = cfg.get("mailer_subjects_custom_contents") or {}
    host = cfg.get("smtp_host")

    print("")
    print("live state of project auth config")
    print("---------------------------------")
    if host:
        print("  smtp            custom: %s:%s" % (host, cfg.get("smtp_port")))
        print("  smtp user       %s" % cfg.get("smtp_user"))
        print("  sender          %s <%s>" % (cfg.get("smtp_sender_name"),
                                             cfg.get("smtp_admin_email")))
    else:
        print("  smtp            built-in Supabase mailer (no custom SMTP)")
        print("                  -> free tier REFUSES custom templates in this")
        print("                     state; see README 'Unblocking it'.")
    print("  email rate limit%s/hour, project-wide" % str(cfg.get("rate_limit_email_sent")).rjust(3))
    print("  site_url        %s" % cfg.get("site_url"))
    print("  link expiry     %ss" % cfg.get("mailer_otp_exp"))
    print("  recovery subj   %r" % live_subject)
    print("  recovery body   %d bytes live vs %d bytes in this repo" % (len(live_body), len(sending)))
    print("  marked custom   %s" % custom_flags.get("MAILER_SUBJECTS_RECOVERY"))

    branded = live_subject == subject and live_body == sending
    print("")
    print("  VERDICT: %s" % (
        "the SKYHOOK reset mail is LIVE" if branded else
        "NOT live - players still get Supabase's stock reset mail"))
    return branded


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="read back only, change nothing")
    args = ap.parse_args()

    with open(os.path.join(HERE, "recovery.html"), encoding="utf-8") as fh:
        html = fh.read()
    with open(os.path.join(HERE, "recovery.subject.txt"), encoding="utf-8") as fh:
        subject = fh.read().strip()
    sending = body_to_send(html)

    print("recovery template: %d bytes on disk, %d sent" % (len(html), len(sending)))
    if not validate(sending, subject):
        sys.exit("template failed validation - not sending")

    pat, ref = load_secrets()

    if not args.check:
        status, _ = api(
            ref,
            pat,
            "PATCH",
            {
                "mailer_subjects_recovery": subject,
                "mailer_templates_recovery_content": sending,
            },
        )
        print("PATCH config/auth -> %s" % status)

    _, cfg = api(ref, pat)
    branded = report_live(cfg, subject, sending)
    # Exit code is the useful bit for scripts and for CI-by-hand: 0 means the
    # mail a player receives is the one in this repo, 1 means it is not.
    sys.exit(0 if branded else 1)


if __name__ == "__main__":
    main()
