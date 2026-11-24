// End to end, no API key: create an interface from a scripted prompt, install it on a new
// table, add a row, reload, and check the row is still there.
import { test, expect } from '@playwright/test';

test('create, install, add a row, reload: the row persists', async ({ page }) => {
  const errors = [];
  const anthropic = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.url().includes('api.anthropic.com')) anthropic.push(r.url()); });

  await page.goto('/');
  await expect(page.locator('.tile[data-id]').first()).toBeVisible();

  // New interface through the scripted (no key) agent.
  await page.locator('[data-act="new"]').first().click();
  const msg = page.locator('form[data-form="chat"] [name="msg"]');
  await msg.fill('Track my car mileage for work trips');
  await msg.press('Enter');
  await expect(page.locator('.msg.them .bubble').last()).toContainText('Mileage', { timeout: 15_000 });

  // Install: bind the "trips" slot to a new table.
  await page.locator('[data-act="draft-bind"]').click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toContainText('Connect data');
  await sheet.locator('select[data-change="bind-table"]').selectOption('__new__');
  await sheet.locator('input[data-input="bind-name"]').fill('work_trips');
  await sheet.locator('[data-act="bind-allow"]').click();
  await expect(page.getByText('Mileage Tracker installed')).toBeVisible();

  // Add a row through the interface's form.
  const form = page.locator('form.form[data-form]').first();
  await form.locator('[name="date"]').fill('2026-11-20');
  await form.locator('[name="miles"]').fill('42.5');
  await form.locator('[name="purpose"]').fill('E2E client visit');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.item-title', { hasText: 'E2E client visit' })).toBeVisible();

  // Wait for the IndexedDB write, then reload.
  expect(await page.evaluate(async () => (await import('/js/db.js')).whenSaved())).toBe(true);
  await page.reload();
  await expect(page.locator('.tile[data-id]').first()).toBeVisible();
  await page.locator('.tile[data-id]', { hasText: 'Mileage Tracker' }).click();
  await expect(page.locator('.item-title', { hasText: 'E2E client visit' })).toBeVisible();
  await expect(page.locator('.item-value').first()).toContainText('42.5');

  // The row is in the table the user created.
  const rows = await page.evaluate(async () => (await import('/js/db.js')).query('SELECT date, miles, purpose FROM work_trips'));
  expect(rows).toEqual([{ date: '2026-11-20', miles: 42.5, purpose: 'E2E client visit' }]);

  expect(anthropic, 'no key set, so nothing goes to the API').toEqual([]);
  expect(errors).toEqual([]);
});
