// Run from repository root against tests/e2e-server.ts only.
const auditUrl = process.env.UI_AUDIT_URL || 'http://127.0.0.1:4191';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(auditUrl).hostname)) throw new Error('Use a disposable loopback E2E fixture.');
const auditOutput = process.env.UI_AUDIT_OUTPUT || require('node:path').join(process.cwd(), '.tmp-ui-audit');
require('node:fs').mkdirSync(auditOutput, { recursive: true });
const fs = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(process.cwd() + '/package.json');
const { chromium, devices } = req('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const c = await b.newContext({ ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, baseURL: auditUrl, reducedMotion: 'reduce' });
  const p = await c.newPage();
  await p.route('**/api/ai/status', r => r.fulfill({ json: { enabled: true, streaming: true } }));
  await p.goto('/tree');
  await p.getByRole('button', { name: 'Открыть ИИ-исследователя' }).click();
  await p.waitForTimeout(150);
  const output = { initial: await p.evaluate(() => ({ tag: document.activeElement.tagName, cls: document.activeElement.className })), tabs: [] };
  await p.locator('.research-assistant textarea').focus();
  for (let i = 0; i < 4; i++) {
    await p.keyboard.press('Tab');
    output.tabs.push(await p.evaluate(() => ({ tag: document.activeElement.tagName, cls: document.activeElement.className, inside: !!document.activeElement.closest('.research-assistant') })));
  }
  fs.writeFileSync(auditOutput + '/ai-focus-mobile.json', JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
