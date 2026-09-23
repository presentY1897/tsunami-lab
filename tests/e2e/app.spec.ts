import { expect, test } from '@playwright/test';

interface AppProbe {
  mode: string;
  done: boolean;
  sim: {
    solver: { time: number; levels: { active: boolean; steps: number }[] };
    stats: { areaKm2: number; maxDepth: number };
    initialUp: number;
  } | null;
}

declare const window: Window & { __tsunami: AppProbe & { start(): Promise<void> } };

test('설정 화면이 뜨고, 시작하면 지형을 받아 3D 계산이 돌아간다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Shader Error|THREE\.WebGLProgram/.test(m.text())) errors.push(m.text().slice(0, 400));
  });

  await page.goto('/?preset=tohoku2011&quality=tiny&turbo=4');
  await expect(page.locator('h1')).toHaveText('쓰나미 랩');
  await expect(page.locator('#summary')).toContainText('614 × 189 km');
  await expect(page.locator('#targetInfo')).toContainText('센다이');

  await page.locator('#start').click();
  await page.waitForFunction(() => window.__tsunami.mode === 'sim', null, { timeout: 120_000 });
  await page.waitForFunction(() => (window.__tsunami.sim?.solver.time ?? 0) > 120, null, { timeout: 120_000, polling: 250 });

  const probe = await page.evaluate(() => {
    const s = window.__tsunami.sim!;
    return {
      t: s.solver.time,
      levels: s.solver.levels.map((l) => ({ active: l.active, steps: l.steps })),
      up: s.initialUp,
      area: s.stats.areaKm2,
      depth: s.stats.maxDepth,
    };
  });
  // M9.0 불균일 슬립의 최대 융기는 4~7 m
  expect(probe.up).toBeGreaterThan(4);
  expect(probe.up).toBeLessThan(7);
  expect(probe.levels.length).toBeGreaterThanOrEqual(3);
  expect(probe.levels[0].steps).toBeGreaterThan(5);
  // 파도가 닿기 전인 2분 시점에 침수가 있으면 DEM 합성에 구멍이 생긴 것이다
  expect(probe.area).toBe(0);
  expect(probe.depth).toBe(0);
  await expect(page.locator('#clock')).not.toHaveText('');
  expect(errors).toEqual([]);
});
