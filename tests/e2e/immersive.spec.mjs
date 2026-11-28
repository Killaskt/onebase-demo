// Inside an interface the only OneBase UI is the edge tab. Everything else is in the drawer.
import { test, expect } from '@playwright/test';

test('immersive interface: edge tab, drawer, agent overlay, back to Home', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('.tile[data-id]', { hasText: 'Bowling Scorer' }).click();

  for (const sel of ['.flip', '.navbar', '.topbar', '.tabbar', '.foot-note']) await expect(page.locator(sel)).toHaveCount(0);
  const tab = page.locator('[data-act="drawer"]');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-label', 'OneBase menu');
  await expect(page.locator('.iface-head .large-title')).toBeVisible();

  await tab.click();
  const drawer = page.locator('.drawer');
  await expect(drawer.getByText('Edit with agent')).toBeVisible();
  await expect(drawer.getByText('Home', { exact: true })).toBeVisible();
  await expect(drawer).toContainText('Deleting this interface keeps the data');

  await drawer.locator('[data-act="agent-open"]').click();
  const sheet = page.locator('.sheet.tall');
  await expect(sheet.locator('form[data-form="chat"] [name="msg"]')).toBeVisible();
  await expect(page.locator('.iface-scroll')).toBeAttached();

  await sheet.locator('[data-act="close-sheet"]').click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  await expect(page.locator('.iface-scroll')).toBeVisible();

  await tab.click();
  await page.locator('.drawer [data-act="back"]').click();
  await expect(page.locator('.tile[data-id]').first()).toBeVisible();
  await expect(page.locator('.tabbar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('reload resumes the open interface on the same screen', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.tile[data-id]').first()).toBeVisible();

  await page.locator('[data-act="tab"][data-tab="market"]').click();
  await page.locator('.market-row', { hasText: 'Training Log' }).locator('[data-act="get"]').click();
  const sheet = page.locator('.sheet');
  await sheet.locator('select[data-change="bind-table"]').selectOption('__new__');
  await sheet.locator('[data-act="bind-allow"]').click();
  await expect(page.locator('.iface-head .large-title')).toHaveText('Training');

  await page.locator('[data-act="go"][data-to="history"]').click();
  await expect(page.locator('.screen-title')).toHaveText('History');
  expect(await page.evaluate(async () => (await import('/js/db.js')).whenSaved())).toBe(true);

  await page.reload();
  await expect(page.locator('.screen-title')).toHaveText('History');
  await expect(page.locator('.tabbar')).toHaveCount(0);

  await page.locator('.screen-head [data-act="go"][data-to="back"]').click();
  await expect(page.locator('.iface-head .large-title')).toHaveText('Training');
  expect(errors).toEqual([]);
});
