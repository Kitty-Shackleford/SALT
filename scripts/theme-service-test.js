'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const themeService = require('../services/themeService');
const { renderWithCsrf } = require('../utils/renderWithCsrf');

const NOV_15 = new Date('2026-11-15T00:00:00Z'); // no window (default date)
const OCT_25 = new Date('2026-10-25T00:00:00Z'); // halloween window
const DEC_24 = new Date('2026-12-24T00:00:00Z'); // xmas (winter) window
const FEB_13 = new Date('2026-02-13T00:00:00Z'); // valentine window
const NOV_27 = new Date('2026-11-27T00:00:00Z'); // thanksgiving window
const APR_20 = new Date('2026-04-20T00:00:00Z'); // 420 window
const MAR_26 = new Date('2026-03-26T00:00:00Z'); // easter approx window (window 1)
const APR_24 = new Date('2026-04-24T00:00:00Z'); // easter approx window (window 2, end)
const JUL_4 = new Date('2026-07-04T00:00:00Z'); // 4th-of-july window
const MAY_4 = new Date('2026-05-04T00:00:00Z'); // cinco-de-mayo window

function testPackInventory() {
  const packs = themeService.loadHolidayPacks();
  const expected = ['none', 'halloween', 'xmas', 'winter', 'valentine', 'thanksgiving', '420', 'easter', '4th-of-july', 'cinco-de-mayo'];
  for (const name of expected) {
    assert.ok(packs[name], `pack "${name}" is missing from holiday-themes.json`);
  }
  assert.strictEqual(Object.keys(packs).length, expected.length, 'unexpected extra packs');
  // winter is a backward-compat alias of xmas — same window + vars.
  assert.deepStrictEqual(packs.winter.window, packs.xmas.window, 'winter alias must mirror the xmas window');
  assert.deepStrictEqual(packs.winter.vars, packs.xmas.vars, 'winter alias must mirror the xmas vars');
  // Every pack's vars must be a pure token map (no selectors/urls/script) and
  // use the --dzc- token vocabulary only.
  for (const [name, pack] of Object.entries(packs)) {
    assert.ok(typeof pack.label === 'string' && pack.label.length > 0, `pack ${name} needs a label`);
    for (const [token, value] of Object.entries(pack.vars || {})) {
      assert.ok(token.startsWith('--dzc-'), `pack ${name} emits non-token ${token}`);
      assert.ok(typeof value === 'string', `pack ${name} value for ${token} must be a string`);
      assert.ok(!value.includes('http'), `pack ${name} value for ${token} must not carry a URL`);
    }
  }
  console.log('ok: packInventory');
}

function testHolidayWindowActive() {
  // Single-window packs (backward compat with the B1.2 call shape).
  assert.strictEqual(themeService.holidayWindowActive({ month: 10, startDay: 20, endDay: 31 }, OCT_25), true);
  assert.strictEqual(themeService.holidayWindowActive({ month: 10, startDay: 20, endDay: 31 }, NOV_15), false);
  assert.strictEqual(themeService.holidayWindowActive({ month: 10, startDay: 20, endDay: 31 }, new Date('2026-10-19T00:00:00Z')), false);
  assert.strictEqual(themeService.holidayWindowActive({ month: 10, startDay: 20, endDay: 31 }, new Date('2026-10-31T00:00:00Z')), true);
  assert.strictEqual(themeService.holidayWindowActive({ month: 10, startDay: 20, endDay: 31 }, null), false);
  assert.strictEqual(themeService.holidayWindowActive(null, OCT_25), false);
  // Multi-window packs (easter approximation).
  assert.strictEqual(themeService.holidayWindowActive(themeService.loadHolidayPacks().easter.windows, MAR_26), true);
  assert.strictEqual(themeService.holidayWindowActive(themeService.loadHolidayPacks().easter.windows, APR_24), true);
  assert.strictEqual(themeService.holidayWindowActive(themeService.loadHolidayPacks().easter.windows, NOV_15), false);
  assert.strictEqual(themeService.holidayWindowActive([], OCT_25), false, 'empty windows array is never active');
  console.log('ok: holidayWindowActive');
}

function testBaseThemeNames() {
  assert.deepStrictEqual(themeService.BASE_THEMES, ['livonia', 'chernarus', 'sakhal', 'nasadra', 'high-contrast']);
  assert.strictEqual(themeService.DEFAULT_BASE_THEME, 'livonia');
  // All five base themes are valid.
  for (const t of themeService.BASE_THEMES) assert.ok(themeService.validTheme(t), `validTheme(${t})`);
  // Legacy aliases remain valid (B1.2 back-compat).
  assert.ok(themeService.validTheme('dark'));
  assert.ok(themeService.validTheme('light'));
  assert.strictEqual(themeService.normalizeThemeName('dark'), 'livonia');
  assert.strictEqual(themeService.normalizeThemeName('light'), 'sakhal');
  assert.strictEqual(themeService.normalizeThemeName('livonia'), 'livonia');
  assert.strictEqual(themeService.normalizeThemeName('high-contrast'), 'high-contrast');
  assert.strictEqual(themeService.normalizeThemeName('banana'), null);
  assert.strictEqual(themeService.normalizeThemeName(null), null);
  assert.strictEqual(themeService.normalizeThemeName(42), null);
  assert.ok(!themeService.validTheme('banana'));
  assert.ok(!themeService.validTheme(null));
  console.log('ok: baseThemeNames');
}

function rowWith(overrides = {}) {
  return Object.assign({
    theme_default: 'livonia',
    accent_color: null,
    holiday_theme: null,
    holiday_start: null,
    holiday_end: null,
    holiday_packs: {},
  }, overrides);
}

function testResolveThemePrecedence() {
  // No settings, no preference -> the new default theme.
  assert.strictEqual(themeService.resolveTheme(null, null, NOV_15).baseTheme, 'livonia');
  // User preference wins over guild default when no holiday active.
  assert.strictEqual(themeService.resolveTheme(rowWith({ theme_default: 'sakhal' }), 'chernarus', NOV_15).baseTheme, 'chernarus');
  assert.strictEqual(themeService.resolveTheme(rowWith({ theme_default: 'sakhal' }), null, NOV_15).baseTheme, 'sakhal');
  // Legacy stored values normalize to the base theme.
  assert.strictEqual(themeService.resolveTheme(rowWith({ theme_default: 'dark' }), null, NOV_15).baseTheme, 'livonia');
  assert.strictEqual(themeService.resolveTheme(rowWith({ theme_default: 'light' }), null, NOV_15).baseTheme, 'sakhal');
  assert.strictEqual(themeService.resolveTheme(rowWith({ theme_default: 'livonia' }), 'light', NOV_15).baseTheme, 'sakhal');
  // Invalid preference falls back to guild default.
  assert.strictEqual(themeService.resolveTheme(rowWith({ theme_default: 'sakhal' }), 'banana', NOV_15).baseTheme, 'sakhal');
  // Invalid guild default falls back to the default theme.
  assert.strictEqual(themeService.resolveTheme(rowWith({ theme_default: 'banana' }), null, NOV_15).baseTheme, 'livonia');
  // resolveTheme ALWAYS returns a canonical base theme name.
  for (const t of [...themeService.BASE_THEMES, 'dark', 'light']) {
    const r = themeService.resolveTheme(null, t, NOV_15);
    assert.ok(themeService.BASE_THEMES.includes(r.baseTheme), `baseTheme ${r.baseTheme} must be canonical`);
  }
  console.log('ok: resolveThemePrecedence');
}

function testResolveThemeHolidayWins() {
  const row = rowWith({
    theme_default: 'sakhal',
    accent_color: '#123456',
    holiday_theme: 'halloween',
    holiday_packs: {},
  });
  const active = themeService.resolveTheme(row, 'chernarus', OCT_25);
  assert.strictEqual(active.holidayPack, 'halloween');
  assert.deepStrictEqual(active.activePacks, ['halloween']);
  assert.ok(active.holidayVars && Object.keys(active.holidayVars).length > 0, 'holiday vars present');
  assert.ok(active.overrideCss.includes('--dzc-bg'), 'override carries holiday vars');
  // Holiday accent overrides the guild accent.
  assert.strictEqual(active.accentColor, active.holidayVars['--dzc-accent']);
  // Base theme still reflects the user preference (holiday is an additive overlay).
  assert.strictEqual(active.baseTheme, 'chernarus');

  // Same settings, out of window -> no holiday pack.
  const inactive = themeService.resolveTheme(row, 'chernarus', NOV_15);
  assert.strictEqual(inactive.holidayPack, null);
  assert.deepStrictEqual(inactive.activePacks, []);
  assert.strictEqual(inactive.holidayVars, null);
  // Guild accent still applies.
  assert.strictEqual(inactive.accentColor, '#123456');
  assert.ok(inactive.overrideCss.includes('--dzc-accent:#123456'));
  console.log('ok: resolveThemeHolidayWins');
}

function testHolidayOptInGating() {
  // Opt-in gating: a pack is NOT active just because it has a window —
  // the guild must opt in (holiday_packs map or legacy holiday_theme).
  const notOptedIn = themeService.resolveTheme(rowWith({ holiday_packs: {} }), null, OCT_25);
  assert.strictEqual(notOptedIn.holidayPack, null, 'halloween must not apply without opt-in');

  const optedIn = themeService.resolveTheme(rowWith({ holiday_packs: { halloween: true } }), null, OCT_25);
  assert.strictEqual(optedIn.holidayPack, 'halloween', 'opted-in pack applies within its window');
  assert.ok(optedIn.overrideCss.includes('--dzc-bg'), 'opted-in pack vars are emitted');

  // Disabled entry in the map does not apply.
  const disabled = themeService.resolveTheme(rowWith({ holiday_packs: { halloween: false } }), null, OCT_25);
  assert.strictEqual(disabled.holidayPack, null, 'disabled pack must not apply');

  // Unknown pack names in the map are ignored.
  const bogus = themeService.resolveTheme(rowWith({ holiday_packs: { bogus: true } }), null, OCT_25);
  assert.strictEqual(bogus.holidayPack, null);

  // Opted in but outside the window -> inactive.
  const outOfWindow = themeService.resolveTheme(rowWith({ holiday_packs: { halloween: true } }), null, NOV_15);
  assert.strictEqual(outOfWindow.holidayPack, null);

  // 'none' never enables anything.
  const none = themeService.resolveTheme(rowWith({ holiday_packs: { none: true }, holiday_theme: 'none' }), null, OCT_25);
  assert.strictEqual(none.holidayPack, null);

  // Legacy single-select still gates (migration back-compat).
  const legacy = themeService.resolveTheme(rowWith({ holiday_theme: 'halloween' }), null, OCT_25);
  assert.strictEqual(legacy.holidayPack, 'halloween');

  // Every new pack window is exercised by a faked date within it.
  const inWindow = [
    ['halloween', OCT_25], ['xmas', DEC_24], ['winter', DEC_24], ['valentine', FEB_13],
    ['thanksgiving', NOV_27], ['420', APR_20], ['easter', MAR_26], ['4th-of-july', JUL_4],
    ['cinco-de-mayo', MAY_4],
  ];
  for (const [packName, date] of inWindow) {
    const r = themeService.resolveTheme(rowWith({ holiday_packs: { [packName]: true } }), null, date);
    assert.ok(r.activePacks.includes(packName), `${packName} must be active on ${date.toISOString()}`);
    assert.ok(r.overrideCss.length > 0, `${packName} emits override css`);
  }
  // ...and the same packs are inactive on the default (no-window) date.
  for (const [packName] of inWindow) {
    const r = themeService.resolveTheme(rowWith({ holiday_packs: { [packName]: true } }), null, NOV_15);
    assert.ok(!r.activePacks.includes(packName), `${packName} must be inactive on ${NOV_15.toISOString()}`);
  }
  console.log('ok: holidayOptInGating');
}

function testPackVarsLayerOverEveryBaseTheme() {
  const packs = themeService.loadHolidayPacks();
  const activePacks = Object.keys(packs).filter((n) => n !== 'none');
  const dates = {
    halloween: OCT_25, xmas: DEC_24, winter: DEC_24, valentine: FEB_13,
    thanksgiving: NOV_27, '420': APR_20, easter: MAR_26, '4th-of-july': JUL_4,
    'cinco-de-mayo': MAY_4,
  };
  for (const base of themeService.BASE_THEMES) {
    for (const packName of activePacks) {
      const r = themeService.resolveTheme(rowWith({ theme_default: base, holiday_packs: { [packName]: true } }), null, dates[packName]);
      assert.strictEqual(r.baseTheme, base, `${base} + ${packName}: base theme must be preserved`);
      assert.ok(r.overrideCss.startsWith(':root:root{'), `${base} + ${packName}: override scoped to :root:root`);
      // Every emitted token must be a --dzc token with a literal value, so
      // nothing can be unresolved for any base theme.
      const body = r.overrideCss.slice(':root:root{'.length, -1);
      for (const decl of body.split(';').filter(Boolean)) {
        const idx = decl.indexOf(':');
        const token = decl.slice(0, idx);
        const value = decl.slice(idx + 1);
        assert.ok(token.startsWith('--dzc-'), `${base} + ${packName}: ${token} is not a --dzc token`);
        assert.ok(value.length > 0, `${base} + ${packName}: empty value for ${token}`);
      }
    }
  }

  // Multi-pack overlap (easter window overlaps 420's Apr 19-22): both apply,
  // in pack-definition order (420 before easter), deterministic merge.
  const overlap = themeService.resolveTheme(
    rowWith({ holiday_packs: { '420': true, easter: true } }),
    null,
    APR_20
  );
  assert.deepStrictEqual(overlap.activePacks, ['420', 'easter'], 'multi-pack order is pack-definition order');
  assert.ok(overlap.overrideCss.length > 0);
  // holidayPack is null when more than one pack is active (activePacks is the source).
  assert.strictEqual(overlap.holidayPack, null);
  console.log('ok: packVarsLayerOverEveryBaseTheme');
}

function testBuildOverrideCss() {
  assert.strictEqual(themeService.buildOverrideCss({ holidayVars: null, accentColor: null }), '');
  const css = themeService.buildOverrideCss({
    holidayVars: { '--dzc-bg': '#123456', 'bad-token': 'x', 'not-a-string': 42 },
    accentColor: null,
  });
  assert.ok(css.startsWith(':root:root{'), 'override scoped to :root (cascade-winning specificity)');
  assert.ok(css.includes('--dzc-bg:#123456'));
  assert.ok(!css.includes('bad-token'), 'non --dzc tokens are dropped');
  assert.ok(!css.includes('42'), 'non-string values are dropped');

  const accentCss = themeService.buildOverrideCss({ holidayVars: null, accentColor: '#abcdef' });
  assert.ok(accentCss.includes('--dzc-accent:#abcdef'));
  assert.ok(accentCss.includes('--dzc-accent-hover'), 'accent override also sets the hover token');

  // Invalid hex accent is ignored, not emitted.
  assert.strictEqual(themeService.buildOverrideCss({ accentColor: 'red' }), '');
  console.log('ok: buildOverrideCss');
}

function testNormalizeThemeSettings() {
  const clean = themeService.normalizeThemeSettings({ themeDefault: 'sakhal', accentColor: '#ABCDEF', holidayTheme: 'halloween' });
  assert.deepStrictEqual(clean, { theme_default: 'sakhal', accent_color: '#abcdef', holiday_theme: 'halloween' });

  // Legacy alias is accepted and persisted canonicalized.
  const legacy = themeService.normalizeThemeSettings({ themeDefault: 'dark' });
  assert.deepStrictEqual(legacy, { theme_default: 'livonia' });

  // Clearing accent + holiday is allowed.
  const cleared = themeService.normalizeThemeSettings({ accentColor: null, holidayTheme: null, holidayStart: null, holidayEnd: null });
  assert.deepStrictEqual(cleared, { accent_color: null, holiday_theme: null, holiday_start: null, holiday_end: null });

  assert.throws(() => themeService.normalizeThemeSettings({ themeDefault: 'blue' }), RangeError);
  assert.throws(() => themeService.normalizeThemeSettings({ themeDefault: 'dark2' }), RangeError);
  assert.throws(() => themeService.normalizeThemeSettings({ accentColor: 'red' }), RangeError);
  assert.throws(() => themeService.normalizeThemeSettings({ accentColor: '#abc' }), RangeError);
  assert.throws(() => themeService.normalizeThemeSettings({ holidayTheme: 'nope' }), RangeError);
  assert.throws(() => themeService.normalizeThemeSettings({ holidayStart: '2026-13-40' }), RangeError);
  // 'none' clears the holiday pack.
  assert.strictEqual(themeService.normalizeThemeSettings({ holidayTheme: 'none' }).holiday_theme, null);

  // holidayPacks: object map, array form, null clears, invalid names dropped.
  const packMap = themeService.normalizeThemeSettings({ holidayPacks: { halloween: true, easter: true, bogus: true, none: true, valentine: false } });
  assert.deepStrictEqual(packMap, { holiday_packs: { halloween: true, easter: true } });
  const packArr = themeService.normalizeThemeSettings({ holidayPacks: ['xmas', '420', 'nope'] });
  assert.deepStrictEqual(packArr, { holiday_packs: { xmas: true, '420': true } });
  const packClear = themeService.normalizeThemeSettings({ holidayPacks: null });
  assert.deepStrictEqual(packClear, { holiday_packs: {} });
  assert.throws(() => themeService.normalizeThemeSettings({ holidayPacks: 'halloween' }), RangeError);
  console.log('ok: normalizeThemeSettings');
}

function testOptedInPackNames() {
  assert.deepStrictEqual(themeService.optedInPackNames(null), []);
  assert.deepStrictEqual(themeService.optedInPackNames({ holiday_packs: { halloween: true, valentine: false }, holiday_theme: 'xmas' }),
    ['halloween', 'xmas']);
  assert.deepStrictEqual(themeService.optedInPackNames({ holiday_packs: { bogus: true }, holiday_theme: 'none' }), []);
  // Map values that are truthy-but-odd still count as opted-in.
  assert.deepStrictEqual(themeService.optedInPackNames({ holiday_packs: { '420': 1 } }), ['420']);
  console.log('ok: optedInPackNames');
}

function testRenderWithCsrfThemeInjection() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-theme-render-'));
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, '<!doctype html>\n<html>\n<head>\n<title>T</title>\n<link rel="stylesheet" href="/css/theme.css">\n</head>\n<body></body>\n</html>');

  const captured = [];
  const res = {
    send(html) { captured.push(html); },
  };

  // No theme set (anonymous / fail-soft) -> default livonia, no override, still has csrf meta.
  renderWithCsrf(page, { csrfToken: () => 'tok' }, res);
  assert.ok(captured[0].includes('<html data-theme="livonia"'), 'defaults to livonia data-theme');
  assert.ok(captured[0].includes('name="csrf-token"'), 'csrf meta present');
  assert.ok(!captured[0].includes('data-theme-override'), 'no override block when no override');
  assert.ok(captured[0].includes('/js/theme-toggle.js'), 'toggle script injected');
  assert.ok(captured[0].includes('dayz-theme'), 'no-flash inline script injected');

  // A new base theme name flows through unchanged.
  res.send = html => captured.push(html);
  renderWithCsrf(page, {
    csrfToken: () => 'tok',
    theme: { baseTheme: 'high-contrast', holidayPack: 'halloween', accentColor: '#ff0000', overrideCss: ':root{--dzc-bg:#150b06;--dzc-accent:#ff0000}' },
  }, res);
  assert.ok(captured[1].includes('<html data-theme="high-contrast"'), 'high-contrast data-theme applied');
  assert.ok(captured[1].includes('<style data-theme-override>'), 'override block injected');
  assert.ok(captured[1].includes('--dzc-accent:#ff0000'), 'accent override present');

  // Legacy alias in the resolved theme is emitted canonicalized.
  renderWithCsrf(page, {
    csrfToken: () => 'tok',
    theme: { baseTheme: 'light', holidayPack: null, accentColor: null, overrideCss: '' },
  }, res);
  assert.ok(captured[2].includes('<html data-theme="sakhal"'), 'legacy light alias canonicalizes to sakhal');

  // The override block must be placed BEFORE </head> so it cascades over
  // the stylesheet links above it.
  const overrideIdx = captured[1].indexOf('<style data-theme-override>');
  const headEndIdx = captured[1].indexOf('</head>');
  assert.ok(overrideIdx !== -1 && headEndIdx !== -1 && overrideIdx < headEndIdx, 'override sits inside <head>');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok: renderWithCsrfThemeInjection');
}

testPackInventory();
testHolidayWindowActive();
testBaseThemeNames();
testResolveThemePrecedence();
testResolveThemeHolidayWins();
testHolidayOptInGating();
testPackVarsLayerOverEveryBaseTheme();
testBuildOverrideCss();
testNormalizeThemeSettings();
testOptedInPackNames();
testRenderWithCsrfThemeInjection();
console.log('✅ Theme service tests passed');
