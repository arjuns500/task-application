'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../public/shared.js');

test('date arithmetic', () => {
  assert.strictEqual(S.addMonths('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(S.addMonths('2028-01-31', 1), '2028-02-29');
  assert.strictEqual(S.addInterval('2026-12-30', 1, 'w'), '2027-01-06');
  assert.strictEqual(S.diffDays('2026-10-28', '2026-10-30'), 2);
  assert.ok(!S.isValidDate('2026-02-30'));
});

test('org repeaters', () => {
  // done on 2026-10-30, task was scheduled 2026-10-10
  assert.strictEqual(S.nextRepeat('2026-10-10', '+1w', '2026-10-30'), '2026-10-17');   // shift once
  assert.strictEqual(S.nextRepeat('2026-10-10', '++1w', '2026-10-30'), '2026-10-31');  // next future, same weekday
  assert.strictEqual(S.nextRepeat('2026-10-10', '.+1w', '2026-10-30'), '2026-11-06');  // from completion
  assert.strictEqual(S.nextRepeat('2026-01-31', '+1m', '2026-01-31'), '2026-02-28');
  assert.deepStrictEqual(S.occurrences('2026-10-01', '+1w', '2026-10-01', '2026-10-31'), ['2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']);
  assert.strictEqual(S.describeRepeat('.+2d'), 'every 2 days after done');
  assert.strictEqual(S.parseRepeat('+1x'), null);
});

test('quick-add parsing', () => {
  const today = '2026-10-30'; // a Friday
  assert.deepStrictEqual(S.parseQuickAdd('Pay rent @tom ^11-05 -3d +1m !high', today),
    { title: 'Pay rent', scheduled_date: '2026-10-31', deadline_date: '2026-11-05', warning_days: 3, repeat: '+1m', priority: 'high' });
  assert.deepStrictEqual(S.parseQuickAdd('Standup 9:30 .+1d', today),
    { title: 'Standup', scheduled_time: '09:30', repeat: '.+1d', scheduled_date: today });
  assert.strictEqual(S.parseQuickAdd('x @fri', today).scheduled_date, '2026-11-06'); // next Friday, not today
  assert.strictEqual(S.parseQuickAdd('x @mon 2pm', today).scheduled_time, '14:00');
  assert.strictEqual(S.parseQuickAdd('x @+2w', today).scheduled_date, '2026-11-13');
  assert.strictEqual(S.parseQuickAdd('x @01-15', today).scheduled_date, '2027-01-15'); // past month-day rolls to next year
  assert.deepStrictEqual(S.parseQuickAdd('Email bob@example.com about @home 3 things', today),
    { title: 'Email bob@example.com about @home 3 things' });
});

test('tags', () => {
  assert.strictEqual(S.normalizeTag('#Work'), 'work');
  assert.strictEqual(S.normalizeTag('home/garden'), 'home/garden');
  assert.strictEqual(S.normalizeTag('123'), '');
  assert.deepStrictEqual(S.parseQuickAdd('Fix bug #123 #work #Work #errands', '2026-10-30'),
    { title: 'Fix bug #123', tags: ['work', 'errands'] });
});
