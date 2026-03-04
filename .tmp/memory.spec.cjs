const { test } = require('@playwright/test');

test('idle memory sample', async ({ page }) => {
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const values = [];
  for (let i = 0; i < 20; i++) {
    const mem = await page.evaluate(() => {
      const p = performance.memory;
      return p ? p.usedJSHeapSize : null;
    });
    values.push(mem);
    await page.waitForTimeout(1000);
  }
  console.log('MEM_SAMPLES', JSON.stringify(values));
});
