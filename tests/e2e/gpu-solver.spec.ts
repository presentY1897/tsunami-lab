import { expect, test } from '@playwright/test';

interface CheckResult {
  single: { steps: number; maxDiff: number; rms: number; maxEta: number; floodedLand: number };
  nested: { finite: boolean; childActive: boolean; childSteps: number; maxChild: number; maxParentInRect: number; maxAbsDiff: number };
}

test('GPU 솔버가 CPU 기준 구현과 같은 답을 내고 중첩 격자가 파를 이어받는다', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.goto('/dev/gpu-check.html');
  const r = (await page.evaluate(() => (window as unknown as { __gpuCheck: Promise<unknown> }).__gpuCheck)) as CheckResult;
  console.log(JSON.stringify(r, null, 2));
  if (logs.length) console.log(logs.join('\n'));

  expect(r.single.steps).toBe(400);
  expect(r.single.floodedLand).toBeGreaterThan(0);
  expect(r.single.rms).toBeLessThan(2e-3);
  expect(r.single.maxDiff).toBeLessThan(0.05);

  expect(r.nested.finite).toBe(true);
  expect(r.nested.childActive).toBe(true);
  expect(r.nested.childSteps).toBeGreaterThan(10);
  expect(r.nested.maxParentInRect).toBeGreaterThan(0.02);
  // 자식 격자의 수위가 같은 위치의 부모 격자와 비슷해야 한다
  expect(r.nested.maxAbsDiff).toBeLessThan(0.35 * r.nested.maxParentInRect + 0.01);
});
