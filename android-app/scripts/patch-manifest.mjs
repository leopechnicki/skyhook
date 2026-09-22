/*
 * patch-manifest.mjs - insert the AdMob APPLICATION_ID meta-data into the
 * generated AndroidManifest.xml. Google AdMob REQUIRES this meta-data or the
 * app crashes on launch. Run once after `npx cap add android`.
 *
 * ==== TEST APP ID ONLY ====
 * ca-app-pub-3940256099942544~3347511713 is Google's public sample app id.
 * It is safe to commit and is NOT tied to any account. Replace with the real
 * app id only per RELEASE-CHECKLIST.md.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

const TEST_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
const META = `        <meta-data\n            android:name="com.google.android.gms.ads.APPLICATION_ID"\n            android:value="${TEST_APP_ID}" />`;

async function main() {
  let xml;
  try { xml = await fs.readFile(manifestPath, 'utf8'); }
  catch { console.error('patch-manifest: ' + manifestPath + ' not found. Run "npx cap add android" first.'); process.exit(1); }

  if (xml.includes('com.google.android.gms.ads.APPLICATION_ID')) {
    console.log('patch-manifest: APPLICATION_ID already present, nothing to do.');
    return;
  }
  // Insert just before the closing </application> tag.
  if (!xml.includes('</application>')) { console.error('patch-manifest: no </application> tag found.'); process.exit(1); }
  xml = xml.replace('</application>', META + '\n    </application>');
  await fs.writeFile(manifestPath, xml, 'utf8');
  console.log('patch-manifest: inserted AdMob TEST APPLICATION_ID meta-data.');
}

main().catch((e) => { console.error(e); process.exit(1); });
