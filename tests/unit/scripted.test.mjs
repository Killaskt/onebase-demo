// The scripted fallback used when no API key is set: it must produce valid specs and never call the network.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTED_NEW, scriptedNew, scriptedEdit, scriptedSuggestions, getKey } from '../../js/agent.js';
import { validateSpec, screensOf, allBlocks } from '../../js/spec.js';

const realFetch = globalThis.fetch;
let fetches = 0;
before(() => { localStorage.clear(); globalThis.fetch = async () => { fetches++; throw new Error('network used'); }; });
after(() => { globalThis.fetch = realFetch; assert.equal(fetches, 0, 'scripted path must not use fetch'); });

describe('scriptedNew', () => {
  test('there is no key in this test', () => assert.equal(getKey(), ''));
  test('four example sessions', () => assert.equal(SCRIPTED_NEW.length, 4));
  for (const s of SCRIPTED_NEW) {
    test(`exact prompt "${s.prompt}" returns ${s.spec.name}`, () => {
      const out = scriptedNew(s.prompt);
      assert.equal(out.reply, s.reply);
      assert.deepEqual(out.spec, s.spec);
      assert.notEqual(out.spec, s.spec, 'returns a copy');
      assert.deepEqual(validateSpec(out.spec), []);
    });
  }
  test('free text matches by keyword', () => {
    assert.equal(scriptedNew('show my bowling scores').spec.name, 'Alley Leaderboard');
    assert.equal(scriptedNew('track my budget').spec.name, 'Spending Summary');
    assert.equal(scriptedNew('Track my car mileage for work trips').spec.name, 'Mileage Tracker');
    assert.equal(scriptedNew('I want to track my gym lifts').spec.name, 'Training Log');
  });
  test('the workout session returns a multi-screen spec', () => {
    const out = scriptedNew('Build me a workout tracker');
    assert.ok(screensOf(out.spec).length >= 3);
    assert.equal(out.spec.blocks, undefined);
    assert.equal(out.spec.needs[0].slot, 'workouts');
    assert.deepEqual(validateSpec(out.spec), []);
  });
  test('the mileage session is a multi-screen spec that keeps its slot and columns', () => {
    const spec = scriptedNew('Track my car mileage for work trips').spec;
    assert.deepEqual(screensOf(spec).map((s) => s.id), ['home', 'add', 'trips']);
    assert.equal(spec.needs[0].slot, 'trips');
    assert.deepEqual(spec.needs[0].columns.map((c) => c.key), ['date', 'miles', 'purpose']);
    assert.equal(allBlocks(spec).filter((x) => x.block.type === 'form' && x.block.then === 'back').length, 1);
    for (const s of screensOf(spec)) assert.ok(s.blocks.filter((b) => b.type === 'button' && b.style === 'primary').length <= 1);
  });
  test('unmatched text explains that a key is needed', () => {
    const out = scriptedNew('a recipe box');
    assert.equal(out.spec, null);
    assert.match(out.reply, /No API key is set/);
  });
  test('mutating a returned spec does not change the script', () => {
    scriptedNew(SCRIPTED_NEW[0].prompt).spec.name = 'changed';
    assert.equal(scriptedNew(SCRIPTED_NEW[0].prompt).spec.name, 'Alley Leaderboard');
  });
});

describe('scriptedSuggestions and scriptedEdit', () => {
  for (const s of SCRIPTED_NEW) {
    test(`every suggestion for ${s.spec.name} applies and keeps the spec valid`, () => {
      const chips = scriptedSuggestions(s.spec);
      assert.ok(chips.length >= 2 && chips.length <= 4, `chips: ${chips}`);
      assert.equal(chips[0], 'What does this interface do?');
      for (const chip of chips) {
        const before = JSON.stringify(s.spec);
        const out = scriptedEdit(chip, s.spec);
        assert.equal(JSON.stringify(s.spec), before, 'input spec untouched');
        assert.ok(out.reply, `${chip}: reply`);
        if (out.spec) {
          assert.deepEqual(validateSpec(out.spec), [], `${chip}: valid`);
          assert.notDeepEqual(out.spec, s.spec, `${chip}: changed something`);
          assert.ok(out.note, `${chip}: has a version note`);
        }
      }
    });
  }
  test('explain describes blocks and access', () => {
    const out = scriptedEdit('what does it do', SCRIPTED_NEW[0].spec);
    assert.equal(out.spec, undefined);
    assert.match(out.reply, /Alley Leaderboard is .*read-only access to "games"/);
  });
  test('explain of a multi-screen spec names every screen', () => {
    const spec = SCRIPTED_NEW.find((x) => x.spec.name === 'Training Log').spec;
    const out = scriptedEdit('what does it do', spec).reply;
    assert.match(out, /Training Log has 4 screens: /);
    for (const s of spec.screens) assert.ok(out.includes(s.title), s.title);
    assert.match(out, /read and write access to "workouts"/);
  });
  test('the chart-by edit on a multi-screen spec lands on the home screen', () => {
    const spec = SCRIPTED_NEW.find((x) => x.spec.name === 'Mileage Tracker').spec;
    const chip = scriptedSuggestions(spec).find((c) => /^Add a chart by/.test(c));
    assert.ok(chip, 'chip offered');
    const out = scriptedEdit(chip, spec);
    assert.equal(out.spec.screens[0].blocks.at(-1).type, 'chart');
    assert.equal(out.spec.screens[0].blocks.filter((b) => b.type === 'chart').length, 1);
    assert.equal(out.spec.screens.slice(1).flatMap((s) => s.blocks).filter((b) => b.type === 'chart').length, 0);
    assert.deepEqual(validateSpec(out.spec), []);
  });
  test('a chart edit on a multi-screen spec changes the chart on its own screen', () => {
    const spec = SCRIPTED_NEW.find((x) => x.spec.name === 'Training Log').spec;
    const out = scriptedEdit('Make the chart a bar chart', spec);
    assert.equal(out.spec.screens[3].blocks[0].kind, 'bar');
  });
  test('free-text edits match by keyword', () => {
    const out = scriptedEdit('add the lowest score', SCRIPTED_NEW[0].spec);
    assert.ok(out.spec.blocks.find((b) => b.type === 'stats').items.some((i) => i.agg === 'min'));
  });
  test('an unsupported edit explains that a key is needed', () => {
    const out = scriptedEdit('make it purple', SCRIPTED_NEW[0].spec);
    assert.equal(out.spec, undefined);
    assert.match(out.reply, /No API key is set/);
  });
});
