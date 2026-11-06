// Chrome's own windows over a parked page (agent/sheets.mjs), with the
// windows as they were on Mike's Mac when X asked for a passkey (6 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findSheets, onScreen, placeOn, sitsOn } from '../agent/sheets.mjs';

const screens = [
  { left: 0, top: 0, width: 2560, height: 1440 },
  { left: 2560, top: 195, width: 1512, height: 982 },
  { left: -2560, top: 0, width: 2560, height: 1440 },
];
const parked = (left, top) => ({ left, top, width: 1280, height: 900 });

test("finds the passkey sheet and the parked tab it's over", () => {
  const tabWindows = [
    { tabId: 1018, bounds: parked(-3800, 1399) },
    { tabId: 1026, bounds: parked(-3200, 990) },
  ];
  const windows = [
    { id: 54775, left: -2562, top: 973, width: 448, height: 468 }, // the sheet
    { id: 54635, ...parked(-3200, 990) },
    { id: 54569, ...parked(-3800, 1399) },
    { id: 45218, left: -2560, top: 0, width: 2560, height: 30 }, // a strip along the top
    { id: 54573, left: 0, top: 0, width: 1, height: 1 },
    { id: 38753, left: 0, top: 940, width: 64, height: 64 },
  ];
  const found = findSheets(windows, tabWindows, screens);
  assert.deepEqual([...found.keys()], [1026]);
  assert.equal(found.get(1026).id, 54775);
});

test('nothing when every window is a tab window or off the screens', () => {
  const tabWindows = [{ tabId: 1, bounds: parked(-3200, 990) }];
  assert.equal(findSheets([{ id: 1, ...parked(-3200, 990) }], tabWindows, screens).size, 0);
  // The omnibox's dropdown, hidden away with its parked window.
  assert.equal(findSheets([{ id: 2, left: -3701, top: 1424, width: 1118, height: 138 }], tabWindows, screens).size, 0);
  assert.equal(findSheets([{ id: 3, left: -2562, top: 973, width: 448, height: 468 }], [], screens).size, 0);
});

test('windows parked on top of each other: the sheet goes to the one it sits in the middle of', () => {
  const tabWindows = [
    { tabId: 1, bounds: parked(-2560, 540) },
    { tabId: 2, bounds: parked(-2000, 540) },
  ];
  const sheet = { id: 9, left: -1584, top: 623, width: 448, height: 468 };
  assert.deepEqual([...findSheets([sheet], tabWindows, screens).keys()], [2]);
});

test('onScreen and placeOn', () => {
  assert.equal(onScreen(parked(-3200, 990), screens) < 0.5, true);
  assert.equal(onScreen({ left: -2562, top: 973, width: 448, height: 468 }, screens) > 0.9, true);
  const focus = { left: 0, top: 25, width: 2560, height: 1340 };
  assert.deepEqual(placeOn(focus, { width: 1280, height: 900 }), { left: 640, top: 245, width: 1280, height: 900 });
  // Taller than the screen: cut to fit.
  assert.deepEqual(placeOn({ left: 0, top: 25, width: 1440, height: 875 }, { width: 1280, height: 900 }), { left: 80, top: 25, width: 1280, height: 875 });
});

test("windows parked in the same corner: the thread's page that was busy last, never Chrome's blank one", () => {
  const corner = parked(-1240, 1039);
  const sheet = { id: 9, left: 0, top: 788, width: 448, height: 565 };
  const tabWindows = [
    { tabId: 1001, bounds: corner }, // the window Chrome started with
    { tabId: 1002, bounds: corner, thread: 'a', activeAt: 200 },
    { tabId: 1003, bounds: corner, thread: 'b', activeAt: 100 },
  ];
  assert.deepEqual([...findSheets([sheet], tabWindows, screens).keys()], [1002]);
});

test('a sheet stays with the tab it was first matched to', () => {
  const tabWindows = [
    { tabId: 1, bounds: { left: 320, top: 90, width: 1280, height: 900 }, thread: 'a', activeAt: 1 },
    { tabId: 2, bounds: parked(-1240, 1039), thread: 'b', activeAt: 2 },
  ];
  // Still at the edge, nearer the parked window, but it's tab 1's.
  const sheet = { id: 9, left: 0, top: 788, width: 448, height: 565 };
  assert.deepEqual([...findSheets([sheet], tabWindows, screens, new Map([[9, 1]])).keys()], [1]);
});

test("a tab the sheet didn't follow is passed over next time", () => {
  const corner = parked(-1240, 1039);
  const sheet = { id: 9, left: 0, top: 788, width: 448, height: 565 };
  const tabWindows = [
    { tabId: 1, bounds: corner, thread: 'a', activeAt: 200 },
    { tabId: 2, bounds: corner, thread: 'b', activeAt: 100 },
  ];
  assert.deepEqual([...findSheets([sheet], tabWindows, screens).keys()], [1]);
  assert.deepEqual([...findSheets([sheet], tabWindows, screens, new Map(), new Map([[9, new Set([1])]])).keys()], [2]);
  assert.equal(findSheets([sheet], tabWindows, screens, new Map(), new Map([[9, new Set([1, 2])]])).size, 0);
  assert.equal(sitsOn({ left: 736, top: 173, width: 448, height: 565 }, { left: 320, top: 90, width: 1280, height: 900 }), true);
  assert.equal(sitsOn(sheet, { left: 320, top: 90, width: 1280, height: 900 }), false);
});

test("a window already on screen doesn't take a sheet that isn't on it", () => {
  const tabWindows = [
    { tabId: 1, bounds: { left: 0, top: 0, width: 1280, height: 900 }, thread: 'a', activeAt: 200 },
    { tabId: 2, bounds: { left: -1240, top: 1039, width: 1280, height: 375 }, thread: 'b', activeAt: 100 },
  ];
  const sheet = { id: 9, left: 0, top: 788, width: 448, height: 565 };
  assert.deepEqual([...findSheets([sheet], tabWindows, [screens[0]]).keys()], [2]);
  const inside = { id: 10, left: 416, top: 100, width: 448, height: 565 };
  assert.deepEqual([...findSheets([inside], tabWindows, [screens[0]]).keys()], [1]);
});
