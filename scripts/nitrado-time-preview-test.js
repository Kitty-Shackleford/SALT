'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.listeners = {};
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  set innerHTML(value) { this.children = []; this.html = value; }
  get innerHTML() { return this.html || ''; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

function harness() {
  const ids = [
    'serverSelect', 'resetBtn', 'saveBtn', 'generalSettings', 'configSettings',
    'savegameSettings', 'settingsContainer', 'loadingIndicator', 'noServerMessage',
    'timePreviewCard', 'timePreviewCurrent', 'timePreviewDraft',
    'saveDisplayNameBtn', 'saveHostnameBtn', 'invisibleHostname',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements.serverSelect.value = 'service-a';
  elements.serverSelect.selectedIndex = 0;
  elements.serverSelect.options = [{ dataset: { guildId: 'guild-a', internalServerId: '1' } }];
  const listeners = {};
  const requests = [];
  const alerts = [];
  const context = vm.createContext({
    document: {
      getElementById: id => elements[id] || null,
      createElement: tag => new Element(tag),
      querySelectorAll: selector => selector === '.setting-input'
        ? ['generalSettings', 'configSettings', 'savegameSettings'].flatMap(id => elements[id].children)
          .flatMap(row => row.children).filter(child => child.classList.contains('setting-input'))
        : [],
      addEventListener: (name, listener) => { listeners[name] = listener; },
    },
    console: { log() {}, warn() {}, error() {} },
    alert: message => alerts.push(message),
    confirm: () => true,
    fetch: (...args) => { requests.push(args); throw new Error('Unexpected fetch'); },
    fetchWithCsrf: (...args) => { requests.push(args); throw new Error('Unexpected mutation'); },
  });
  const timeModule = path.join(root, 'public/js/dayz-time.js');
  if (fs.existsSync(timeModule)) vm.runInContext(fs.readFileSync(timeModule, 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/nitrado-settings.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  const load = config => {
    run(`currentSettings = { config: ${JSON.stringify(config)} }; originalSettings = JSON.parse(JSON.stringify(currentSettings)); changedSettings = {}; renderSettings();`);
  };
  const input = key => elements.configSettings.children.flatMap(row => row.children)
    .find(child => child.dataset?.key === key);
  return { elements, listeners, requests, alerts, context, run, load, input };
}

function testTimeMultipliersAreNumericEvenAtOneOrZero() {
  const h = harness();
  h.load({ serverTimeAcceleration: '1', serverNightTimeAcceleration: '0', enableWhitelist: '1' });
  for (const key of ['serverTimeAcceleration', 'serverNightTimeAcceleration']) {
    assert.strictEqual(h.input(key).tagName, 'INPUT', `${key} must not become a boolean selector`);
    assert.strictEqual(h.input(key).type, 'number');
  }
  assert.strictEqual(h.input('serverTimeAcceleration').value, '1');
  assert.strictEqual(h.input('serverNightTimeAcceleration').value, '0');
  assert.strictEqual(h.input('enableWhitelist').tagName, 'SELECT', 'unrelated settings remain unchanged');
}

function testPreviewIsLocalAndSeparatesLoadedFromDraft() {
  const h = harness();
  h.load({ serverTimeAcceleration: '2', serverNightTimeAcceleration: '4' });
  assert.match(h.elements.timePreviewCurrent.textContent, /6\.0 h.*1\.5 h/);
  h.run("markChanged('config', 'serverTimeAcceleration', '4')");
  assert.match(h.elements.timePreviewDraft.textContent, /3\.0 h.*0\.8 h/);
  assert.match(h.elements.timePreviewCurrent.textContent, /6\.0 h.*1\.5 h/);
  assert.strictEqual(h.requests.length, 0, 'preview must never issue requests');
  h.run('resetChanges()');
  assert.strictEqual(h.elements.timePreviewCurrent.textContent, h.elements.timePreviewDraft.textContent);
}

function testTypingUpdatesPreviewWithoutSaving() {
  const h = harness();
  h.run('loadServers = async function() {}');
  h.listeners.DOMContentLoaded();
  h.load({ serverTimeAcceleration: '2', serverNightTimeAcceleration: '4' });
  assert.strictEqual(typeof h.listeners.input, 'function', 'typing must update the preview before blur');
  const input = h.input('serverTimeAcceleration');
  input.value = '4';
  h.listeners.input({ target: input });
  assert.match(h.elements.timePreviewDraft.textContent, /3\.0 h.*0\.8 h/);
  assert.strictEqual(h.requests.length, 0);
  input.value = '';
  h.listeners.input({ target: input });
  assert.match(h.elements.timePreviewDraft.textContent, /Unavailable/);
}

function testPagesLoadSharedPreviewWithHonestLabels() {
  for (const file of ['public/dashboard/settings.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, /id="timePreviewCard"/, file);
    for (const id of ['timePreviewCurrent', 'timePreviewDraft']) assert(html.includes(`id="${id}"`));
    assert.match(html, /12.*12.*season/i);
    assert.match(html, /Unsaved draft/);
    assert.match(html, /does not.*restart/i);
    const helper = html.indexOf('/js/dayz-time.js');
    assert(helper >= 0 && helper < html.indexOf('/js/nitrado-settings.js'), 'shared helper loads first');
  }
}

async function testChangingServerClearsPreviewImmediately() {
  const h = harness();
  h.load({ serverTimeAcceleration: '2', serverNightTimeAcceleration: '4' });
  h.elements.serverSelect.value = '';
  await h.run('loadSettings()');
  assert.strictEqual(h.elements.timePreviewCurrent.textContent, '', 'old server estimate must be cleared');
  assert.strictEqual(h.elements.timePreviewDraft.textContent, '');
  assert(h.elements.timePreviewCard.classList.contains('hidden'));
}

async function testOldSaveCannotClearNewServerDraft(rejectBody = false) {
  const h = harness();
  h.load({ serverTimeAcceleration: '2', serverNightTimeAcceleration: '4' });
  h.run("markChanged('config', 'serverTimeAcceleration', '4')");
  let resolveBody;
  let reject;
  const body = new Promise((resolve, rejectPromise) => { resolveBody = resolve; reject = rejectPromise; });
  h.context.fetchWithCsrf = async (url, options) => {
    h.requests.push([url, options]);
    return { json: () => body };
  };
  const saving = h.run('saveAllSettings()');
  await Promise.resolve();
  h.elements.serverSelect.value = 'service-b';
  h.elements.serverSelect.options[0] = { dataset: { guildId: 'guild-b' } };
  h.context.fetch = async () => ({ json: async () => ({
    success: true, settings: { config: { serverTimeAcceleration: '8', serverNightTimeAcceleration: '2' } },
  }) });
  h.run('loadServerNaming = async function() {}');
  await h.run('loadSettings()');
  h.run("markChanged('config', 'serverTimeAcceleration', '6')");
  const draft = h.elements.timePreviewDraft.textContent;
  if (rejectBody) reject(new Error('Old response decoding failed'));
  else resolveBody({ success: true, updated: 1 });
  await saving;
  assert.strictEqual(h.elements.timePreviewDraft.textContent, draft, 'late save must not replace the new draft');
  assert.strictEqual(h.run('countChanges()'), 1);
  assert.strictEqual(h.alerts.length, 0, 'old save notifications are scoped to their original context');
  assert.strictEqual(h.requests[0][0], '/api/nitrado/settings/service-a');
  assert.deepStrictEqual(JSON.parse(h.requests[0][1].body), {
    settings: { config: { serverTimeAcceleration: '4' } }, guildId: 'guild-a',
  });
  assert.strictEqual(h.elements.saveBtn.disabled, false);
}

async function testPendingSaveLocksDraftAndRejectsDuplicateSubmission() {
  const h = harness();
  h.load({ serverTimeAcceleration: '2', serverNightTimeAcceleration: '4' });
  h.run("markChanged('config', 'serverTimeAcceleration', '4')");
  let finish;
  h.context.fetchWithCsrf = (url, options) => {
    h.requests.push([url, options]);
    return new Promise(resolve => { finish = resolve; });
  };
  const saving = h.run('saveAllSettings()');
  assert(h.input('serverTimeAcceleration').disabled, 'draft controls must not race a pending save');
  assert(h.elements.resetBtn.disabled);
  await h.run('saveAllSettings()');
  assert.strictEqual(h.requests.length, 1);
  h.run("markChanged('config', 'serverTimeAcceleration', '6')");
  assert.match(h.elements.timePreviewDraft.textContent, /3\.0 h/);
  finish({ json: async () => ({ success: false, error: 'Test rejection' }) });
  await saving;
  assert.strictEqual(h.input('serverTimeAcceleration').disabled, false);
  assert.strictEqual(h.elements.resetBtn.disabled, false);
  assert.strictEqual(h.run('countChanges()'), 1, 'failed saves retain the draft');
}

async function testReturningToPendingServerKeepsSaveLocked() {
  const h = harness();
  h.load({ serverTimeAcceleration: '2', serverNightTimeAcceleration: '4' });
  h.run("markChanged('config', 'serverTimeAcceleration', '4')");
  let finish;
  h.context.fetchWithCsrf = (url, options) => {
    h.requests.push([url, options]);
    return new Promise(resolve => { finish = resolve; });
  };
  const saving = h.run('saveAllSettings()');
  h.context.fetch = async () => ({ json: async () => ({
    success: true, settings: { config: { serverTimeAcceleration: '2', serverNightTimeAcceleration: '4' } },
  }) });
  h.run('loadServerNaming = async function() {}');
  h.elements.serverSelect.value = 'service-b';
  await h.run('loadSettings()');
  assert.strictEqual(h.elements.saveBtn.disabled, false, 'another server has independent controls');
  h.elements.serverSelect.value = 'service-a';
  await h.run('loadSettings()');
  assert.strictEqual(h.elements.saveBtn.disabled, true);
  assert.strictEqual(h.input('serverTimeAcceleration').disabled, true);
  await h.run('saveAllSettings()');
  assert.strictEqual(h.requests.length, 1, 'returning to a pending context must not allow a second save');
  finish({ json: async () => ({ success: false, error: 'Test rejection' }) });
  await saving;
  assert.strictEqual(h.elements.saveBtn.disabled, false);
  assert.strictEqual(h.input('serverTimeAcceleration').disabled, false);
  assert.strictEqual(h.alerts.length, 0);
}

async function main() {
  testTimeMultipliersAreNumericEvenAtOneOrZero();
  testPreviewIsLocalAndSeparatesLoadedFromDraft();
  testTypingUpdatesPreviewWithoutSaving();
  testPagesLoadSharedPreviewWithHonestLabels();
  await testChangingServerClearsPreviewImmediately();
  await testOldSaveCannotClearNewServerDraft();
  await testOldSaveCannotClearNewServerDraft(true);
  await testPendingSaveLocksDraftAndRejectsDuplicateSubmission();
  await testReturningToPendingServerKeepsSaveLocked();
  console.log('Nitrado time preview tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
