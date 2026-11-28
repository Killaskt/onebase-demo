// An agent edit that needs a new column must keep the interface on its existing table:
// the sheet offers to add the column, and no row is lost.
import { test, expect } from '@playwright/test';

test('an edit that needs a new column extends the bound table instead of re-binding to an empty one', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.locator('.tile[data-id]').first()).toBeVisible();

  // Install Mileage Tracker on a new table and add a row.
  await page.locator('[data-act="new"]').first().click();
  const msg = page.locator('form[data-form="chat"] [name="msg"]');
  await msg.fill('Track my car mileage for work trips');
  await msg.press('Enter');
  await expect(page.locator('.msg.them .bubble').last()).toContainText('Mileage', { timeout: 15_000 });
  await page.locator('[data-act="draft-bind"]').click();
  const sheet = page.locator('.sheet');
  await sheet.locator('select[data-change="bind-table"]').selectOption('__new__');
  await sheet.locator('input[data-input="bind-name"]').fill('work_trips');
  await sheet.locator('[data-act="bind-allow"]').click();
  await expect(page.getByText('Mileage Tracker installed')).toBeVisible();
  // The Mileage Tracker opens on its home screen; the form is one tap away.
  await page.locator('[data-act="go"][data-to="add"]').click();
  const form = page.locator('form.form[data-form]').first();
  await form.locator('[name="date"]').fill('2026-11-20');
  await form.locator('[name="miles"]').fill('42.5');
  await form.locator('[name="purpose"]').fill('Before the edit');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('.item-title', { hasText: 'Before the edit' })).toBeVisible();

  // Ask for a change that adds a column to the interface's needs.
  await page.locator('[data-act="drawer"]').click();
  await page.locator('[data-act="agent-open"]').click();
  const chat = page.locator('form[data-form="chat"] [name="msg"]');
  await chat.fill('Add a notes field');
  await chat.press('Enter');

  // The bind sheet preselects the existing table and says it will add the column.
  const bind = page.locator('.sheet');
  await expect(bind).toContainText('This change needs data access', { timeout: 15_000 });
  const select = bind.locator('select[data-change="bind-table"]');
  await expect(select).toHaveValue('work_trips');
  await expect(select.locator('option[value="work_trips"]')).toContainText('(adds notes');
  await expect(bind).toContainText('Adds column notes (text) to work_trips');
  await bind.locator('[data-act="bind-allow"]').click();
  await expect(page.getByText('Change applied')).toBeVisible();

  // Same table, new column, nothing lost.
  expect(await page.evaluate(async () => (await import('/js/db.js')).whenSaved())).toBe(true);
  const info = await page.evaluate(async () => {
    const d = await import('/js/db.js');
    return { cols: d.query('PRAGMA table_info(work_trips)').map((c) => c.name), rows: d.query('SELECT purpose, miles, notes FROM work_trips'), tables: d.userTables() };
  });
  expect(info.cols).toContain('notes');
  expect(info.tables.filter((t) => t.startsWith('trips') || t === 'work_trips_2'), 'no replacement table').toEqual([]);
  expect(info.tables).toContain('work_trips');
  expect(info.rows).toEqual([{ purpose: 'Before the edit', miles: 42.5, notes: null }]);

  // The interface still lists the earlier row.
  await expect(page.locator('.item-title', { hasText: 'Before the edit' })).toBeVisible();
  expect(errors).toEqual([]);
});
