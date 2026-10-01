import { expect, test } from '@playwright/test';

interface Check {
  error?: string;
  cpu: { steps: number; maxDiff: number; floodedLand: number; maxEta: number; arrived: number };
  periodic: { maxDiff: number; maxEta: number; crossed: number; walledDiff: number };
  nested: { finite: boolean; childActive: boolean; childSteps: number; maxParentInRect: number; maxAbsDiff: number; ratio: number };
  sleepChain: { midWake: number; leafWake: number; midAsleep: number; leafAsleep: number; maxActiveS: number; leafRan: number; leafActive: boolean; midActive: boolean; t: number; tGlobal: number; dt: number };
}

test('앱의 GPU 계산부가 CPU 기준 구현과 같은 답을 내고, 경도 방향으로 이어진다', async ({ page }) => {
  await page.goto('/dev/app-gpu-check.html');
  await page.waitForFunction(() => (window as unknown as { __check?: unknown }).__check !== undefined, null, { timeout: 120_000 });
  const r = (await page.evaluate(() => (window as unknown as { __check: unknown }).__check)) as Check;
  console.log(JSON.stringify(r));
  expect(r.error).toBeUndefined();

  expect(r.cpu.steps).toBe(400);
  expect(r.cpu.floodedLand).toBeGreaterThan(0); // 젖음과 마름이 실제로 일어난 시험이다
  expect(r.cpu.maxDiff).toBeLessThan(1e-3);
  expect(r.cpu.arrived).toBeGreaterThan(1000);

  // 혹을 이음매에 두나 한가운데에 두나 결과가 같다
  expect(r.periodic.maxEta).toBeGreaterThan(0.02);
  expect(r.periodic.maxDiff).toBeLessThan(1e-5);
  expect(r.periodic.crossed).toBeGreaterThan(10);
  // 순환을 끄면 결과가 달라야 한다. 같다면 순환 경계가 아무 일도 안 하고 있는 것이다.
  expect(r.periodic.walledDiff).toBeGreaterThan(0.01);

  // 잠들어 있던 자식 격자가 파가 닿으면 깨어나고, 부모와 같은 파를 이어받는다
  expect(r.nested.finite).toBe(true);
  expect(r.nested.ratio).toBe(8);
  expect(r.nested.childActive).toBe(true);
  expect(r.nested.childSteps).toBeGreaterThan(10);
  expect(r.nested.maxParentInRect).toBeGreaterThan(0.02);
  expect(r.nested.maxAbsDiff).toBeLessThan(0.35 * r.nested.maxParentInRect + 0.01);

  // 격자 사슬이 잠드는 순서(D-045): 중간 격자가 먼저 깨지만, 해안 격자가 제 시간을 다 돌고 잠든 뒤에야 잠든다
  const s = r.sleepChain;
  expect(s.midWake).toBeGreaterThan(0);
  expect(s.leafWake).toBeGreaterThan(s.midWake);
  expect(s.leafWake).toBeLessThan(s.midWake + s.maxActiveS); // 중간 격자의 시간이 다 되기 전에 해안이 깼다
  expect(s.leafActive).toBe(false);
  expect(s.midActive).toBe(false);
  // 깨어난 시각은 부모 스텝 단위로 재므로 한 스텝의 여유를 둔다. 고치기 전에는 중간 격자가 잠들 때 같이 멈춰 절반쯤만 돌았다
  expect(s.leafRan).toBeGreaterThan(s.maxActiveS - s.dt);
  expect(s.midAsleep).toBeGreaterThanOrEqual(s.leafAsleep);
  // 격자들이 잠든 뒤에도 전체 시계는 가장 거친 격자를 따라 흐른다
  expect(s.t).toBe(s.tGlobal);
  expect(s.tGlobal).toBeGreaterThan(s.leafAsleep);
});
