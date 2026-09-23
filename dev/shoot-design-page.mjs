// 비교 페이지의 장면/표현 전환을 확인하고 공유용 화면을 저장한다.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1040 }, locale: 'ko-KR', deviceScaleFactor: 1 });
  await page.goto('http://localhost:5193/design-comparison.html');
  const loaded = () => page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
  for (const scene of ['regional', 'coast']) {
    await page.locator(`[data-scene="${scene}"]`).click();
    await loaded();
    if (!(await page.locator('#lines').getAttribute('src')).endsWith(`${scene}-wireframe.png`)) throw new Error('Wrong comparison image');
    await page.screenshot({ path: `dev/shots/design-wireframe-comparison-${scene}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Comparison page overflows phone viewport');
  const live = await browser.newPage({ locale: 'ko-KR' });
  await live.goto('http://localhost:5190/?style=wireframe');
  await live.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
  const button = live.getByRole('button', { name: /^표현:/ });
  for (const label of ['와이어', '색상', '와이어']) {
    if ((await button.textContent()) !== `표현: ${label}`) throw new Error('Wrong live style');
    await button.click();
  }
  console.log('Comparison scenes, style switching, mobile layout, and live style cycle passed.');
} finally { await browser.close(); }
