/* ============================================================
   mobile-keyboard-e2e.test.ts — the Edit toolbar docks on the soft keyboard
   (spec 0020, ADR 0037).

   The visual viewport can shrink without resizing layout, so this is pure
   browser geometry: the bar meets the visible bottom edge at every layout /
   visual / scroll combination, stays hidden until the doc has focus, and the
   ⋯ calibration moves it in 8px steps, bounded, persisted and caret-preserving.
   ============================================================ */
import { afterAll, beforeAll, test, expect } from "bun:test";
import type { Browser, Page } from "puppeteer-core";
import { startServer, sleep, type TestServer } from "./helpers";
import { launchTestBrowser, newAppPage, appDriver, ensureMode } from "./browser";

async function tapToolbar(page: Page, label: string) {
  await page.tap(`[aria-label="${label}"]`);
  await sleep(300);
}

const touchViewport = (page: Page, width: number, height = 844) =>
  page.setViewport({ width, height, isMobile: true, hasTouch: true });

/** A phone-sized page showing `path` with the island mounted. */
async function phone(path: string, width = 390) {
  const page = await newAppPage(browser, { width, height: 844 });
  await touchViewport(page, width);
  await appDriver(page, srv.base).boot(`/d/${path}`);
  await page.waitForSelector('.bn-editor[contenteditable="true"]');
  return page;
}

const hittable = (page: Page, selector: string) => page.$eval(selector, e => {
  const r = e.getBoundingClientRect();
  return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
});

let srv: TestServer;
let browser: Browser;
beforeAll(async () => {
  srv = await startServer({ seed: {
    "short.md": "- Parent\n- Child\n",
    "position.md": "Toolbar position\n",
    "long.md": "- Parent\n- Child\n\n" + "A paragraph with room to scroll.\n\n".repeat(70),
  } });
  browser = await launchTestBrowser();
}, 90000);

test('phone toolbar is hidden until editing and hides again when focus leaves the doc', async () => {
  const page = await phone('position.md');
  try {
    const visible = () => page.$eval('.z-block-toolbar', e => e.getClientRects().length > 0);
    expect(await visible()).toBe(false);
    await page.tap('.bn-inline-content');
    expect(await visible()).toBe(true);
    await page.tap('[aria-label="Toolbar options"]');
    await sleep(250);
    await page.tap('[aria-label="Move toolbar up"]');
    expect(await visible()).toBe(true);
    expect(await page.$eval('.bn-editor', e => e.contains(document.activeElement))).toBe(true);
    await page.tap('#crumbs');
    expect(await visible()).toBe(false);
    expect(await page.$eval('.z-toolbar-options', e => e.getClientRects().length)).toBe(0);
    await page.tap('.bn-inline-content');
    expect(await visible()).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('znotes.toolbarOffset'))).toBe('-8');
  } finally {
    await page.evaluate(() => localStorage.removeItem('znotes.toolbarOffset'));
    await page.close();
  }
}, 90000);
afterAll(async () => { await browser?.close(); await srv?.stop(); });

async function viewport(page: Page, height: number, offsetTop = 0) {
  await page.evaluate((height, offsetTop) => {
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: height },
      offsetTop: { configurable: true, value: offsetTop },
    });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  }, height, offsetTop);
  await sleep(380);
}

for (const path of ["short.md", "long.md"]) test(`${path}: editing toolbar meets the visual viewport and dismissed chat cannot paint or focus`, async () => {
  const page = await phone(path);
  try {
    await sleep(400);
    await page.tap('.bn-inline-content');
    for (const [layout, visual, offset] of [[844, 500, 0], [844, 430, 70], [500, 500, 0], [844, 844, 0]]) {
      await touchViewport(page, 390, layout);
      await viewport(page, visual, offset);
      for (const fraction of [0, 0.5, 1]) {
        await page.evaluate(f => { const sc = document.getElementById("scroll")!; sc.scrollTop = f * sc.scrollHeight; }, fraction);
        const m = await page.evaluate(() => {
          const toolbar = document.querySelector('.z-block-toolbar')!.getBoundingClientRect();
          const chat = document.querySelector('.chat')!;
          const style = getComputedStyle(chat);
          const composer = document.getElementById('composer')!;
          const previous = document.activeElement as HTMLElement;
          composer.focus();
          const stoleFocus = document.activeElement === composer;
          previous.focus();
          return { bottom: toolbar.bottom, edge: Math.min(visualViewport!.height + visualViewport!.offsetTop, document.querySelector(".statusbar")!.getBoundingClientRect().top),
            chatVisible: style.visibility !== 'hidden' && style.display !== 'none', stoleFocus };
        });
        expect(m.chatVisible).toBe(false);
        expect(m.stoleFocus).toBe(false);
        expect(Math.abs(m.edge - m.bottom)).toBeLessThanOrEqual(2);
      }
    }
    await ensureMode(page, 'raw');
    expect(await page.$eval('.z-block-toolbar', e => e.getBoundingClientRect().height).catch(() => 0)).toBe(0);
    await page.evaluate(() => document.getElementById('chatBtn')!.click());
    await viewport(page, 500);
    await page.focus('#composer');
    await page.keyboard.type('Draft survives');
    expect(await page.$eval('#composer', e => (e as HTMLTextAreaElement).value)).toBe('Draft survives');
    expect(await page.$eval('.chat', e => getComputedStyle(e).visibility)).toBe('visible');
  } finally { await page.close(); }
}, 90000);

test('reported innerHeight mismatch leaves no keyboard gap and window resize republishes the visible edge', async () => {
  const page = await phone('short.md');
  try {
    await page.focus('.bn-editor');
    await page.evaluate(() => Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 }));
    await viewport(page, 500);
    expect(await page.$eval('.z-block-toolbar', e => e.getBoundingClientRect().bottom)).toBeCloseTo(500, 0);
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 460 });
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => Math.abs(document.querySelector('.z-block-toolbar')!.getBoundingClientRect().bottom - 460) < 1);
    await viewport(page, 844);
    expect(await page.evaluate(() => Math.abs(
      document.querySelector('.z-block-toolbar')!.getBoundingClientRect().bottom -
      document.querySelector('.statusbar')!.getBoundingClientRect().top,
    ))).toBeLessThanOrEqual(1);
  } finally { await page.close(); }
}, 90000);

test('touch indent keeps the caret, keyboard dismissal leaves Mode reachable, a desktop has no toolbar', async () => {
  const page = await phone('short.md');
  try {
    await viewport(page, 500);
    const rows = await page.$$('.bn-inline-content');
    await rows[1].tap();
    await page.keyboard.press('End');
    await page.tap('[aria-label="Indent"]');
    expect(await page.$eval('.bn-block-group .bn-block-group', e => e.textContent)).toContain('Child');
    expect(await page.$eval('.bn-editor', e => e.contains(document.activeElement))).toBe(true);
    await page.keyboard.type(' retained');
    await page.tap('[aria-label="Outdent"]');
    expect(await page.$('.bn-block-group .bn-block-group')).toBeNull();
    expect(await page.$eval('.bn-editor', e => e.textContent)).toContain('Child retained');
    await viewport(page, 844);
    expect(await hittable(page, '#stMode')).toBe(true);
    await page.setViewport({ width: 1440, height: 900 });
    await page.waitForSelector('.z-block-toolbar');
    await viewport(page, 900);
    await page.focus('.bn-editor');
    expect(await page.$eval('.z-block-toolbar', e => e.getClientRects().length)).toBe(0);
    await touchViewport(page, 390);
    await page.waitForSelector('.z-block-toolbar');
    await viewport(page, 844);
    await page.tap('#stMode');
    await page.waitForSelector('#doc.raw-mode');
    expect(await page.$eval('#rawArea', e => (e as HTMLTextAreaElement).value)).toMatch(/[-*] Parent\n[-*] Child retained/);
  } finally { await page.close(); }
}, 90000);

test('toolbar calibration preserves the caret, animates, persists and keeps the controls reachable', async () => {
  const page = await phone('short.md', 320);
  try {
    expect(await page.$('[aria-label="Toolbar options"]')).not.toBeNull();
    await viewport(page, 500);
    await page.tap('.bn-inline-content');
    const caret = () => page.evaluate(() => ({ anchor: getSelection()?.anchorOffset, focus: getSelection()?.focusOffset,
      editing: !!document.querySelector('.bn-editor')?.contains(document.activeElement) }));
    const before = await caret();
    await tapToolbar(page, 'Toolbar options');
    const bottom = () => page.$eval('.z-block-toolbar', e => e.getBoundingClientRect().bottom);
    expect(await bottom()).toBeCloseTo(500, 0);
    // Touch input starts the move; frame samples distinguish animation from a jump.
    const samples = page.evaluate(() => new Promise<number[]>(resolve => {
      const values: number[] = [];
      const start = performance.now();
      function frame() {
        values.push(document.querySelector('.z-block-toolbar')!.getBoundingClientRect().bottom);
        if (performance.now() - start < 600) requestAnimationFrame(frame); else resolve(values);
      }
      requestAnimationFrame(frame);
    }));
    await page.tap('[aria-label="Move toolbar down"]');
    const positions = await samples;
    expect(positions.some(y => y > 500.1 && y < 507.9)).toBe(true);
    expect(await bottom()).toBeCloseTo(508, 0);
    expect(await caret()).toEqual(before);
    await tapToolbar(page, 'Move toolbar up');
    expect(await bottom()).toBeCloseTo(500, 0);
    await tapToolbar(page, 'Move toolbar down');
    expect(await page.evaluate(() => localStorage.getItem('znotes.toolbarOffset'))).toBe('8');
    for (const width of [320, 360, 390]) {
      await touchViewport(page, width);
      await viewport(page, 500);
      expect(await page.$eval('[aria-label="Toolbar options"]', e => {
        const r = e.getBoundingClientRect();
        return r.right <= innerWidth && e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
      for (const label of ['Bullet list', 'Numbered list', 'Checklist', 'Outdent', 'Indent']) {
        expect(await page.$eval(`[aria-label="${label}"]`, e => {
          e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = e.getBoundingClientRect();
          return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })).toBe(true);
      }
    }
    await page.keyboard.press('Escape');
    expect(await page.$eval('#doc', e => e.classList.contains('raw-mode'))).toBe(false);
    expect(await page.$eval('[aria-label="Toolbar options"]', e => e.getAttribute('aria-expanded'))).toBe('false');
    await page.focus('.bn-editor');
    await tapToolbar(page, 'Toolbar options');
    await page.focus('[aria-label="Reset toolbar position"]');
    await page.keyboard.press('Escape');
    expect(await page.$eval('[aria-label="Toolbar options"]', e => e === document.activeElement)).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bn-editor[contenteditable="true"]');
    await page.focus('.bn-editor');
    await viewport(page, 500);
    expect(await bottom()).toBeCloseTo(508, 0);
    await page.evaluate(() => { location.hash = ''; history.pushState({}, '', '/d/long.md'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForFunction(() => document.querySelector('.bn-editor')?.textContent?.includes('A paragraph'));
    await page.focus('.bn-editor');
    await viewport(page, 500);
    expect(await bottom()).toBeCloseTo(508, 0);
    await viewport(page, 844);
    expect(await hittable(page, '#stMode')).toBe(true);
    await tapToolbar(page, 'Toolbar options');
    await page.tap('[aria-label="Reset toolbar position"]');
    expect(await page.evaluate(() => localStorage.getItem('znotes.toolbarOffset'))).toBe('0');
    await sleep(300);
    const floor = await bottom();
    await tapToolbar(page, 'Move toolbar down');
    expect(await bottom()).toBeCloseTo(floor + 8, 0);
    await tapToolbar(page, 'Reset toolbar position');
    expect(await bottom()).toBeCloseTo(floor, 0);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    expect(await page.$eval('.z-block-toolbar', e => parseFloat(getComputedStyle(e).transitionDuration))).toBeLessThan(0.001);
  } finally { await page.close(); }
}, 90000);

test('toolbar offset tolerates corrupt or blocked storage and bounds extreme values', async () => {
  const page = await phone('short.md', 320);
  try {
    for (const [value, expected] of [['invalid', 500], ['Infinity', 500], ['99999', 660], ['-99999', 340]] as const) {
      await page.evaluate(value => localStorage.setItem('znotes.toolbarOffset', value), value);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.bn-editor[contenteditable="true"]');
      await page.focus('.bn-editor');
      await viewport(page, 500);
      expect(await page.$eval('.z-block-toolbar', e => e.getBoundingClientRect().bottom)).toBeCloseTo(expected, 0);
      if (value === '99999') {
        await viewport(page, 844);
        expect(await page.$eval('.z-block-toolbar', e => e.getBoundingClientRect().bottom)).toBeCloseTo(844, 0);
        await tapToolbar(page, 'Toolbar options');
        await tapToolbar(page, 'Reset toolbar position');
        expect(await hittable(page, '#stMode')).toBe(true);
      }
    }
    await viewport(page, 180);
    await tapToolbar(page, 'Toolbar options');
    expect(await page.$eval('.z-toolbar-options', e => e.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
    expect(await hittable(page, '[aria-label="Reset toolbar position"]')).toBe(true);
    await page.tap('[aria-label="Reset toolbar position"]');
    expect(await page.evaluate(() => localStorage.getItem('znotes.toolbarOffset'))).toBe('0');
    await page.evaluateOnNewDocument(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (key === 'znotes.toolbarOffset') throw new Error('blocked'); return get.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (key === 'znotes.toolbarOffset') throw new Error('blocked'); return set.call(this, key, value); };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.bn-editor[contenteditable="true"]');
    await page.focus('.bn-editor');
    await viewport(page, 500);
    await tapToolbar(page, 'Toolbar options');
    await tapToolbar(page, 'Move toolbar down');
    expect(await page.$eval('.z-block-toolbar', e => e.getBoundingClientRect().bottom)).toBeCloseTo(508, 0);
  } finally { await page.close(); }
}, 90000);

test('Escape dismisses the focused palette or native menu before toolbar options', async () => {
  const page = await phone('position.md');
  try {
    await viewport(page, 500);
    await page.tap('.bn-inline-content');
    await tapToolbar(page, 'Toolbar options');
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('#palVeil.show');
    await page.waitForFunction(() => document.activeElement === document.getElementById('palInput'));
    await page.keyboard.press('Escape');
    expect(await page.$('#palVeil.show')).toBeNull();
    expect(await page.$eval('[aria-label="Toolbar options"]', e => e.getAttribute('aria-expanded'))).toBe('true');
    await page.tap('.bn-inline-content');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.tap('[aria-label="Toolbar options"]');
    await page.keyboard.type('/');
    await page.waitForSelector('.bn-suggestion-menu');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.bn-suggestion-menu', { hidden: true });
    expect(await page.$eval('[aria-label="Toolbar options"]', e => e.getAttribute('aria-expanded'))).toBe('true');
    await page.keyboard.press('Escape');
    expect(await page.$eval('[aria-label="Toolbar options"]', e => e.getAttribute('aria-expanded'))).toBe('false');
  } finally { await page.close(); }
}, 90000);
