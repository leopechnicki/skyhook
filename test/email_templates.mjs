/* SKYHOOK auth email gate  -  keeps the reset mail shippable and on-brand.
 *
 * supabase/templates/recovery.html is not loaded by the game, so nothing else
 * in this suite would ever notice it rotting. Two specific ways it can rot,
 * both of which are only discovered by a locked-out player who cannot get back
 * in, which is the worst possible time:
 *
 *   1. The link stops working. {{ .ConfirmationURL }} is what GoTrue rewrites
 *      into .../auth/v1/verify?token=...&type=recovery&redirect_to=... and
 *      `type=recovery` is the exact thing consumeRedirect() in js/online.js
 *      keys off. Anyone who "tidies" that placeholder, wraps it in a tracker or
 *      points the button at the site root breaks the reset flow silently.
 *
 *   2. It stops being deliverable-looking. A <style> block, a webfont or a
 *      remote image is fine in a browser and wrong in Gmail and Outlook: the
 *      style gets stripped, the image is blocked, and the mail degrades into
 *      something that looks exactly like the phishing it is competing with.
 *
 * It also asserts the mail uses the GAME's colours, read out of css/style.css
 * rather than hardcoded twice, so "branded" stays a fact instead of a claim.
 *
 * Run: node test/email_templates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TPL_DIR = path.join(ROOT, 'supabase', 'templates');

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const html = fs.readFileSync(path.join(TPL_DIR, 'recovery.html'), 'utf8');
const subject = fs.readFileSync(path.join(TPL_DIR, 'recovery.subject.txt'), 'utf8').trim();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

/* What apply.py actually sends: the editor-facing comment above the doctype is
   stripped. Every assertion below runs against THAT, not against the file, so
   a placeholder that only exists inside the comment cannot pass this suite. */
const sent = html.replace(/^\s*<!--[\s\S]*?-->\s*/, '');

check('apply strips the doc comment and leaves a document',
  /^<!DOCTYPE html/i.test(sent), sent.slice(0, 40));

/* ---------------------------------------------------------------- the link */
const urlVar = '{{ .ConfirmationURL }}';
const uses = sent.split(urlVar).length - 1;
check('sent body uses {{ .ConfirmationURL }} at least twice', uses >= 2, `found ${uses}`);
check('the CTA href IS the placeholder, unwrapped',
  sent.includes('href="' + urlVar + '"'));
check('raw link is also printed as visible text (the plain-text fallback)',
  />\s*\{\{ \.ConfirmationURL \}\}\s*</.test(sent));
check('no other auth endpoint is linked by hand',
  !/supabase\.co\/auth\/v1/.test(sent));
check('no stale GitHub Pages URL', !sent.includes('leopechnicki.github.io'));
check('the only non-template link is the live site',
  (sent.match(/href="https?:\/\/[^"]+"/g) || []).every(h => h.includes('skyhookplay.com')),
  (sent.match(/href="https?:\/\/[^"]+"/g) || []).join(' '));

/* --------------------------------------------------- survives a mail client */
check('no <script>', !/<script/i.test(sent));
check('no <style> block (Gmail strips it)', !/<style/i.test(sent));
check('no external stylesheet <link>', !/<link/i.test(sent));
check('no remote image', !/<img\b/i.test(sent));
check('no webfont import', !/fonts\.googleapis|@font-face|@import/i.test(sent));
check('table-based layout', /<table[^>]*role="presentation"/i.test(sent));
check('every layout table is role="presentation" (screen readers skip it)',
  (sent.match(/<table/gi) || []).length === (sent.match(/<table[^>]*role="presentation"/gi) || []).length);
check('ASCII only - no smart quotes or dashes to arrive as mojibake',
  [...sent].every(c => c.charCodeAt(0) < 128));
check('has an Outlook (mso) button fallback', /if mso/i.test(sent) && /v:roundrect/i.test(sent));

/* ----------------------------------------------------------------- the copy */
check('subject names the game', /skyhook/i.test(subject), subject);
check('subject says what the mail is for', /password/i.test(subject), subject);
check('body says the link expires in 1 hour', /expires in <strong[^>]*>1 hour<\/strong>|expires in 1 hour/i.test(sent));
check('body says an unrequested mail can be ignored', /did not ask for this|didn't request/i.test(sent));
check('body carries the wordmark', /SKYHOOK/.test(sent));

/* ------------------------------------------------------- actually on-brand */
/* Read the palette out of the stylesheet so this cannot drift into a mail that
   merely claims to look like the game. */
const brand = { panel: '#0c1030', cyan: '#35e6ff', onCyan: '#04121a', text: '#dff0ff' };
for (const [name, hex] of Object.entries(brand)) {
  check(`${name} ${hex} is a real game colour (present in css/style.css)`,
    css.toLowerCase().includes(hex));
  check(`${name} ${hex} is used by the email`,
    sent.toLowerCase().includes(hex));
}
check('page background matches the game shell (#060713, index.html theme-color)',
  sent.toLowerCase().includes('#060713')
  && fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('#060713'));

console.log(`\n${fails === 0 ? 'auth email templates are shippable' : fails + ' FAILURE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
