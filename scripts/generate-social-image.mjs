// Run npm run app:build first. Capture the actual app with a social-card overlay.
import { chromium } from 'playwright';
import { preview } from 'vite';

const server = await preview({ configFile: 'app/vite.config.ts', preview: { host: '127.0.0.1', port: 5198, strictPort: true } });
let browser;
try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:5198/?lang=en');
  await page.waitForFunction(() => window.__app?.ready);
  await page.addStyleTag({ content: `
    body > :not(#globe):not(#social-card) { display: none !important; }
    #globe { left: 200px; width: 1200px; }
    #social-card { position: fixed; inset: 0; padding: 80px 60px; pointer-events: none;
      background: linear-gradient(90deg, #101316 0%, #101316 32%, transparent 75%);
      font-family: Arial, sans-serif; color: #e5e7e8; }
    #social-card .eyebrow { color: #8ec5ff; font-size: 18px; letter-spacing: 3px; margin: 0 0 45px; }
    #social-card h1 { font-size: 80px; line-height: 1.05; letter-spacing: -3px; margin: 0 0 26px; }
    #social-card p { font-size: 25px; line-height: 1.5; color: #b7c0c7; margin: 0; }
    #social-card .footer { position: absolute; bottom: 55px; font-size: 15px; color: #8ec5ff; letter-spacing: 1px; }
  ` });
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.id = 'social-card';
    card.innerHTML = '<p class="eyebrow">INTERACTIVE 3D SIMULATOR</p><h1>Tsunami<br>Play</h1><p>Create an impact.<br>Watch the waves unfold.</p><p class="footer">EARTHQUAKES · ASTEROIDS · SEA LEVEL RISE</p>';
    document.body.append(card);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: 'app/public/og-image.png' });
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
