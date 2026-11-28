// A v2 (multi-screen) interface, installed straight into the database without the agent:
// home -> primary button -> form screen -> back to home; link row -> history -> back arrow.
import { test, expect } from '@playwright/test';

const SPEC = {
  name: 'Run Log', icon: '🏃', color: '#2b8a3e', description: 'Screens test',
  needs: [{ slot: 'runs', access: 'write', columns: [{ key: 'date', kind: 'date' }, { key: 'km', kind: 'number' }, { key: 'note', kind: 'text' }] }],
  screens: [
    { id: 'home', title: 'Run Log', blocks: [
      { type: 'stats', slot: 'runs', items: [{ agg: 'count', label: 'Runs' }, { agg: 'sum', col: 'km', label: 'Total km' }] },
      { type: 'button', label: 'Log a run', to: 'log', style: 'primary' },
      { type: 'button', label: 'History', to: 'history', style: 'link' }] },
    { id: 'log', title: 'Log a run', blocks: [
      { type: 'form', slot: 'runs', then: 'back', submit: 'Save run', fields: [{ col: 'date' }, { col: 'km' }, { col: 'note' }] }] },
    { id: 'history', title: 'History', blocks: [
      { type: 'list', slot: 'runs', cols: { title: 'note', subtitle: 'date', value: 'km' }, limit: 10 }] },
  ],
};

test('multi-screen interface: navigate, submit with then:"back", history, back arrow', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.tile[data-id]').first()).toBeVisible();

  await page.evaluate(async (spec) => {
    const db = await import('/js/db.js');
    db.createTable('runs', spec.needs[0].columns);
    const bindings = { runs: { table: 'runs', access: 'write', columns: { date: 'date', km: 'km', note: 'note' } } };
    db.batch((exec) => {
      exec('INSERT INTO _ob_interfaces (id, spec, bindings, chat, position, source) VALUES (?, ?, ?, ?, ?, ?)',
        ['iscreens', JSON.stringify(spec), JSON.stringify(bindings), '[]', 99, null]);
      exec('INSERT INTO _ob_versions (iface, spec, note, at) VALUES (?, ?, ?, ?)', ['iscreens', JSON.stringify(spec), 'Installed', new Date().toISOString()]);
    });
    await db.whenSaved();
  }, SPEC);
  await page.reload();

  await page.locator('.tile[data-id="iscreens"]').click();
  await expect(page.locator('.nav-title')).toHaveText('Run Log');
  await expect(page.locator('.screen-head')).toHaveCount(0);
  await expect(page.locator('.stat-value').first()).toHaveText('0');

  // Primary button -> log screen with a back arrow and title.
  await page.locator('[data-act="go"][data-to="log"]').click();
  await expect(page.locator('.screen-title')).toHaveText('Log a run');
  await expect(page.locator('.screen-head [data-act="go"][data-to="back"]')).toBeVisible();
  const form = page.locator('form.form[data-form="log.0"]');
  await form.locator('[name="date"]').fill('2026-11-21');
  await form.locator('[name="km"]').fill('7.5');
  await form.locator('[name="note"]').fill('Morning loop');
  await form.locator('button[type="submit"]').click();

  // then:"back" returns home, and the stats reflect the new row.
  await expect(page.locator('.screen-head')).toHaveCount(0);
  await expect(page.locator('.stat-value').first()).toHaveText('1');
  await expect(page.locator('.stat-value').nth(1)).toHaveText('7.5');

  // Link row -> history lists the row; back arrow -> home.
  await page.locator('.nav-link', { hasText: 'History' }).click();
  await expect(page.locator('.screen-title')).toHaveText('History');
  await expect(page.locator('.item-title', { hasText: 'Morning loop' })).toBeVisible();
  await page.locator('.screen-head [data-act="go"][data-to="back"]').click();
  await expect(page.locator('.screen-head')).toHaveCount(0);
  await expect(page.locator('[data-act="go"][data-to="log"]')).toBeVisible();

  expect(errors).toEqual([]);
});
