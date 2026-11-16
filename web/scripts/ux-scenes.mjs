// Named UI states ("scenes") of the page, shared by the screenshot script and the layout audit.
// Every scene can be entered from the neutral state and `neutral()` returns to it.
import { addUserApps, clickIf, dropOverlay, fillConsole, forceStatus, has, sleep } from './ux-lib.mjs';

export const layoutOf = (vp) => (vp.phone ? 'phone' : vp.w < 1180 ? 'tablet' : 'wide');

const CRASH_REASON = 'abort: assertion "obj != NULL" failed at /Users/dev/kode-sdk/components/lvgl/src/core/lv_obj_style.c:412 (lv_obj_get_style_prop)';

async function sheetOpen(page) {
  return page.$eval('[data-testid=sheet]', (e) => e.dataset.open === 'true').catch(() => false);
}
export async function openSheet(page, tab) {
  if (!(await sheetOpen(page))) {
    await clickIf(page, '[data-testid=sheet-handle]');
    await sleep(350);
  }
  if (tab) {
    await clickIf(page, `[data-testid=tab-${tab}]`);
    await sleep(200);
  }
}
export async function closeSheet(page) {
  if (await sheetOpen(page)) {
    await clickIf(page, '[data-testid=sheet-close]');
    await sleep(350);
  }
}
/** Opens or closes a side card (docked column or drawer) through its toggle in the stage toolbar. */
export async function setPanel(page, which, on) {
  const sel = `[data-testid=drawer-${which}]`;
  const cur = await page.$eval(sel, (e) => e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-expanded') === 'true').catch(() => null);
  if (cur === null || cur === on) return;
  await clickIf(page, sel);
  await sleep(350);
}
const placementOf = (page, which) => page.$eval(`[data-testid=drawer-${which}-panel]`, (e) => e.dataset.placement ?? 'drawer').catch(() => 'none');

/** Back to: no popover, no sheet, no drawer, no overlay, app running. */
export async function neutral(page, vp) {
  const kind = layoutOf(vp);
  await dropOverlay(page, false);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await clickIf(page, '[data-testid=model-offer-cancel]');
  await clickIf(page, '[data-testid=notice] button');
  if (kind === 'phone') await closeSheet(page);
  else {
    // drawers closed, docked cards open
    for (const which of ['bench', 'console']) await setPanel(page, which, (await placementOf(page, which)) === 'dock');
  }
  await clickIf(page, '[data-testid=console-expand]');
  await forceStatus(page, 'running');
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.mouse.move(2, 2).catch(() => {});
  await sleep(150);
}

async function showBench(page, vp, tab = 'bench') {
  const kind = layoutOf(vp);
  if (kind === 'phone') {
    await openSheet(page, 'bench');
    if (!(await clickIf(page, `[data-testid=left-tab-${tab}]`))) await clickIf(page, `[data-testid=tab-${tab}]`);
    await sleep(200);
    return;
  }
  await setPanel(page, 'bench', true);
  await clickIf(page, `[data-testid=left-tab-${tab}]`);
  await sleep(200);
}
async function showConsole(page, vp) {
  const kind = layoutOf(vp);
  if (kind === 'phone') return openSheet(page, 'console');
  await setPanel(page, 'console', true);
  await clickIf(page, '[data-testid=console-expand]');
}
async function showApps(page, vp) {
  if (layoutOf(vp) === 'phone') return openSheet(page, 'apps');
  if (!(await has(page, '[data-testid=apps-popover]'))) await clickIf(page, '[data-testid=apps-menu]');
  await sleep(250);
}
async function setView(page, vp, mode) {
  if (layoutOf(vp) === 'phone') {
    await openSheet(page, 'settings');
    await clickIf(page, `[data-testid=settings-view-${mode}]`);
    await closeSheet(page);
  } else await clickIf(page, `[data-testid=view-${mode}]`);
  if (mode === '3d') await page.waitForSelector('[data-testid=webgl-canvas]', { timeout: 20000 }).catch(() => {});
  await sleep(mode === '3d' ? 1500 : 300);
}
async function setZoom(page, z) {
  await page.evaluate((label) => {
    const group = document.querySelector('[data-testid=zoom-group]') ?? [...document.querySelectorAll('[role=group]')].find((g) => /×/.test(g.textContent ?? ''));
    const btn = group && [...group.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    btn?.click();
  }, z);
  await sleep(250);
}
async function ensureMotionObject(page, vp) {
  await showBench(page, vp);
  await clickIf(page, '[data-testid=area-motion]');
  await sleep(150);
  if (!(await has(page, '[data-testid=bench-object]'))) {
    await clickIf(page, '[data-testid="add-motion.pose"]');
    await sleep(200);
  }
  const active = await page.$eval('[data-testid=bench-object]', (e) => e.dataset.active === 'true').catch(() => true);
  if (!active) await clickIf(page, '[data-testid=toggle-near]');
  await sleep(150);
}

// shaped like the 3D code's store: a built-in choice, the state of the bundled file, a performance switch
const BASE_MODEL = { builtin: 'kode', bundled: 'ready', performance: true };
const MODEL_STATES = {
  none: { status: 'none', ...BASE_MODEL },
  loading: { ...BASE_MODEL, status: 'loading', name: 'my_custom_kode_dot_shell_with_a_long_file_name_v3_final.glb' },
  ready: {
    ...BASE_MODEL,
    status: 'ready',
    name: 'my_custom_kode_dot_shell_with_a_long_file_name_v3_final.glb',
    sizeBytes: 3482112,
    warnings: ['No node named "screen" was found: the app picture is drawn on the largest flat face of the model.', 'The model has 412,380 triangles; the 3D view may be slow on phones.', 'Node "btn_top" is missing: the top button cannot be pressed in 3D.'],
  },
  error: { builtin: 'simple', bundled: 'missing', performance: true, status: 'error', name: 'broken-export-from-the-cad-tool.glb', error: 'This file is not a binary glTF: the header says "glTF 1.0" and only version 2 can be read (offset 0x0000000C).', warnings: ['The file is 48.2 MB; files above 40 MB are not kept after a reload.'] },
};
/** Installs a stand-in for the 3D code's model store in a given state and opens the place that shows it. */
async function showModel(page, vp, state, { details = false } = {}) {
  await page.evaluate((s) => window.__dotbench.ui.fakeModel?.(s), MODEL_STATES[state]);
  if (layoutOf(vp) === 'phone') await openSheet(page, 'settings');
  else if (!(await has(page, '[data-testid=device-popover]'))) await clickIf(page, '[data-testid=device-menu]');
  await sleep(250);
  if (details) await clickIf(page, '[data-testid=model-details][aria-expanded=false]');
  await page.evaluate(() => document.querySelector('[data-testid=model-controls]')?.scrollIntoView({ block: 'nearest' }));
}

let appsAdded = new WeakSet();
async function ensureUserApps(page, vp) {
  await showApps(page, vp);
  if (appsAdded.has(page)) return;
  appsAdded.add(page);
  await addUserApps(page, () => showApps(page, vp));
  await page.keyboard.press('Escape');
  await clickIf(page, '[data-testid=notice-dismiss]');
  await showApps(page, vp);
}

/** Scenes for a viewport, in an order that builds state up (objects, apps, log lines). */
export function scenesFor(vp) {
  const kind = layoutOf(vp);
  const phone = kind === 'phone';
  const S = [];
  const add = (id, enter, extra = {}) => S.push({ id, enter, leave: neutral, ...extra });

  add('first-run', async () => {}, {
    settle: 800,
    leave: async (p) => {
      await clickIf(p, '[data-testid=welcome-dismiss]'); // the first-visit hint belongs to this scene only
      await neutral(p, vp);
    },
  });
  if (!phone) {
    add('3d-hints', async (p) => {
      await setView(p, vp, '3d');
      await p.evaluate(() => (document.querySelector('[data-testid=hints-toggle]') ?? document.querySelector('section[aria-label] button.btn-icon[aria-expanded]'))?.click());
    });
    add('3d-crash', async (p) => forceStatus(p, 'crashed', CRASH_REASON));
    add('3d-boot', async (p) => forceStatus(p, 'booting'));
    for (const z of ['1×', '2×', '3×']) {
      add(`2d-${z[0]}x`, async (p) => {
        await setView(p, vp, '2d');
        await setZoom(p, z);
      });
    }
    add('2d-fit', async (p) => {
      await setView(p, vp, '2d');
      await p.evaluate(() => {
        const fit = document.querySelector('[data-testid=zoom-fit]');
        if (fit) return fit.click();
        const group = [...document.querySelectorAll('[role=group]')].find((g) => /×/.test(g.textContent ?? ''));
        [...(group?.querySelectorAll('button') ?? [])].pop()?.click();
      });
    });
  }
  add('boot', async (p) => forceStatus(p, 'booting'));
  add('crash', async (p) => forceStatus(p, 'crashed', CRASH_REASON), { textHeavy: true });
  add('idle', async (p) => forceStatus(p, 'idle'));

  add('bench-nfc', async (p) => {
    await showBench(p, vp);
    if (!(await clickIf(p, '[data-testid=area-soon]'))) await clickIf(p, '[data-testid=area-nfc]');
  }, { textHeavy: true });
  add('bench-motion', async (p) => ensureMotionObject(p, vp), { textHeavy: true });
  add('components', async (p) => showBench(p, vp, 'components'), { textHeavy: true });

  add('console-long', async (p) => {
    await showConsole(p, vp);
    await fillConsole(p, 70);
  }, { textHeavy: true });
  add('console-focus', async (p) => {
    await showConsole(p, vp);
    await p.focus('[data-testid=console-input]');
    await p.keyboard.type('nvs get wifi ssid');
  });
  if (kind === 'wide') add('console-collapsed', async (p) => (await clickIf(p, '[data-testid=console-collapse]')) || setPanel(p, 'console', false));
  // scenes that only exist since the review pass (no "before" twin)
  add('object-menu', async (p) => {
    await ensureMotionObject(p, vp);
    await clickIf(p, '[data-testid=object-menu]');
  }, { newUi: true, textHeavy: true });
  if (!phone) {
    add('settings-menu', async (p) => clickIf(p, '[data-testid=settings-menu]'), { newUi: true, textHeavy: true });
    add('details', async (p) => clickIf(p, '[data-testid=status-details-toggle]'), { newUi: true, textHeavy: true });
    add('both-collapsed', async (p) => {
      await setPanel(p, 'bench', false);
      await setPanel(p, 'console', false);
    }, { newUi: true });
  } else if (kind === 'phone' && !(vp.w > vp.h)) {
    add('sheet-full', async (p) => {
      await openSheet(p, 'bench');
      await clickIf(p, '[data-testid=sheet-handle]');
      await sleep(300);
    }, { newUi: true });
  }

  add('apps', async (p) => ensureUserApps(p, vp), { textHeavy: true, settle: 500 });
  if (!phone) {
    add('device-menu', async (p) => showModel(p, vp, 'none'), { textHeavy: true });
    add('drop', async (p) => dropOverlay(p, true));
  }
  add('notice', async (p) => {
    await p.evaluate(() => {
      const input = document.querySelector('[data-testid=file-input]');
      if (!input) return;
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'holiday-photo-from-the-beach.jpeg'));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (!(await has(p, '[data-testid=notice]'))) {
      await showApps(p, vp);
      await p.evaluate(() => {
        const input = document.querySelector('[data-testid=file-input]');
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'holiday-photo-from-the-beach.jpeg'));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await p.keyboard.press('Escape');
      if (phone) await closeSheet(p);
    }
  }, { textHeavy: true });

  // "3D model": every state of the entry, and the question a dropped .glb asks (stand-in store, see showModel)
  add('model-ready', async (p) => showModel(p, vp, 'ready', { details: true }), { newUi: true, textHeavy: true });
  add('model-error', async (p) => showModel(p, vp, 'error', { details: true }), { newUi: true, textHeavy: true });
  add('model-loading', async (p) => showModel(p, vp, 'loading'), { newUi: true });
  add('model-offer', async (p) => {
    await p.evaluate((s) => window.__dotbench.ui.fakeModel?.(s), MODEL_STATES.none);
    await p.evaluate(() => window.__dotbench.ui.offerModel?.('my_custom_kode_dot_shell_with_a_long_file_name_v3_final.glb'));
  }, { newUi: true, textHeavy: true });

  if (kind === 'tablet') {
    add('drawers-both', async (p) => {
      await setPanel(p, 'bench', true);
      await setPanel(p, 'console', true);
    });
  }
  if (phone) {
    add('sheet-settings', async (p) => {
      await p.evaluate((s) => window.__dotbench.ui.fakeModel?.(s), MODEL_STATES.none);
      await openSheet(p, 'settings');
    }, { textHeavy: true });
    add('phone-3d', async (p) => setView(p, vp, '3d'), {
      leave: async (p) => {
        await setView(p, vp, '2d');
        await neutral(p, vp);
      },
    });
  }
  add('focus-ring', async (p) => {
    for (let i = 0; i < 4; i++) await p.keyboard.press('Tab');
  });
  return S;
}
