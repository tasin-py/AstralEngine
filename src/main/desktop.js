'use strict';
// Win32 desktop integration: embedding windows behind desktop icons (WorkerW / Progman),
// foreground/fullscreen detection, cursor position and taskbar styling.
// Uses koffi (FFI) so no native compilation is needed.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const kernel32 = koffi.load('kernel32.dll');
const psapi = koffi.load('psapi.dll');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
const EmptyWorkingSet = psapi.func('bool __stdcall EmptyWorkingSet(intptr_t h)');

/** Return idle memory pages of our own processes to Windows (used while wallpapers are paused). */
function trimWorkingSet(pids) {
  let n = 0;
  for (const pid of pids) {
    const h = OpenProcess(0x0100 /* SET_QUOTA */ | 0x0400 /* QUERY_INFORMATION */, false, pid);
    if (!h) continue;
    if (EmptyWorkingSet(h)) n++;
    CloseHandle(h);
  }
  return n;
}

const RECT = koffi.struct('AE_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('AE_POINT', { x: 'int32', y: 'int32' });
const MONITORINFO = koffi.struct('AE_MONITORINFO', {
  cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32'
});
const ACCENTPOLICY = koffi.struct('AE_ACCENTPOLICY', {
  AccentState: 'int32', AccentFlags: 'int32', GradientColor: 'uint32', AnimationId: 'int32'
});
const WINCOMPATTRDATA = koffi.struct('AE_WINCOMPATTRDATA', {
  Attribute: 'int32', Data: 'void *', SizeOfData: 'uint32'
});

const EnumWindowsProc = koffi.proto('bool __stdcall AE_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 name)');
const FindWindowExW = user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 name)');
const SendMessageTimeoutW = user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32 msg, uintptr_t w, intptr_t l, uint32 flags, uint32 timeout, _Out_ uintptr_t *result)');
const SetParent = user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)');
const GetParent = user32.func('intptr_t __stdcall GetParent(intptr_t hwnd)');
const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32 cmd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int idx)');
const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int idx, intptr_t v)');
const SetLayeredWindowAttributes = user32.func('bool __stdcall SetLayeredWindowAttributes(intptr_t hwnd, uint32 key, uint8 alpha, uint32 flags)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(AE_EnumWindowsProc *cb, intptr_t lParam)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ AE_RECT *rect)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int max)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(intptr_t hwnd)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ AE_POINT *p)');
const MapWindowPoints = user32.func('int __stdcall MapWindowPoints(intptr_t from, intptr_t to, _Inout_ AE_RECT *pts, uint32 count)');
const MonitorFromWindow = user32.func('intptr_t __stdcall MonitorFromWindow(intptr_t hwnd, uint32 flags)');
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(intptr_t mon, _Inout_ AE_MONITORINFO *mi)');
const SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 action, uint32 param, _Inout_ uint16_t *pv, uint32 winIni)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)');
const SetWindowCompositionAttribute = user32.func('bool __stdcall SetWindowCompositionAttribute(intptr_t hwnd, AE_WINCOMPATTRDATA *data)');
const LockWorkStation = user32.func('bool __stdcall LockWorkStation()');
const DwmGetWindowAttribute = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ int32 *val, uint32 size)');

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_TRANSPARENT = 0x00000020;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40, SWP_FRAMECHANGED = 0x20;
const HWND_BOTTOM = 1;
const GW_HWNDNEXT = 2, GW_CHILD = 5;
const LWA_ALPHA = 0x2;
const SMTO_NORMAL = 0;
const DWMWA_CLOAKED = 14;

function hwndFromBuffer(buf) {
  // BrowserWindow.getNativeWindowHandle() returns a pointer-sized buffer.
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

function className(hwnd) {
  const buf = new Uint16Array(256);
  const n = GetClassNameW(hwnd, buf, 256);
  return n > 0 ? String.fromCharCode(...buf.subarray(0, n)) : '';
}

function rectOf(hwnd) {
  const r = {};
  if (!GetWindowRect(hwnd, r)) return null;
  return r;
}

/**
 * Finds (and creates if needed) the window that sits behind the desktop icons.
 * Returns { mode: 'legacy'|'progman', parent, workerw, defView }.
 *  - legacy (Windows 10 / 11 before 24H2): a top-level WorkerW behind the icon window.
 *  - progman (Windows 11 24H2+): WorkerW is a child of Progman; we insert between
 *    SHELLDLL_DefView (icons) and WorkerW (static wallpaper).
 */
function findDesktopLayer() {
  const progman = FindWindowW('Progman', null);
  if (!progman) return null;
  const out = [0];
  // Ask Explorer to spawn the WorkerW layer (undocumented message used by every live wallpaper app).
  SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, SMTO_NORMAL, 1000, out);
  SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, out);

  // Windows 11 24H2+ layout.
  const defViewInProgman = FindWindowExW(progman, 0, 'SHELLDLL_DefView', null);
  const childWorker = FindWindowExW(progman, 0, 'WorkerW', null);
  if (defViewInProgman && childWorker) {
    return { mode: 'progman', parent: progman, workerw: childWorker, defView: defViewInProgman, progman };
  }

  // Legacy layout: find top-level window hosting SHELLDLL_DefView, the WorkerW right after it is ours.
  let workerw = 0;
  let defView = 0;
  const cb = koffi.register((hwnd) => {
    const dv = FindWindowExW(hwnd, 0, 'SHELLDLL_DefView', null);
    if (dv) {
      defView = dv;
      workerw = FindWindowExW(0, hwnd, 'WorkerW', null);
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  if (workerw) return { mode: 'legacy', parent: workerw, workerw, defView, progman };
  if (defViewInProgman) {
    // DefView in Progman but no WorkerW yet: fall back to progman parenting.
    return { mode: 'progman', parent: progman, workerw: childWorker || 0, defView: defViewInProgman, progman };
  }
  return { mode: 'progman-only', parent: progman, workerw: 0, defView: 0, progman };
}

/** Convert a physical-pixel screen rect into the parent's client coordinates. */
function screenToParent(parent, rect) {
  const r = { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
  MapWindowPoints(0, parent, r, 2);
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/**
 * Embed a window behind the desktop icons at the given physical screen rect.
 */
function embedWindow(hwnd, physRect) {
  const layer = findDesktopLayer();
  if (!layer) throw new Error('Explorer desktop (Progman) not found');
  let style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
  // Child window without caption / resize frame, so the client area is the full rect.
  style = (style | WS_CHILD) & ~(WS_POPUP | 0x00C00000 /* CAPTION */ | 0x00040000 /* THICKFRAME */ | 0x00080000 /* SYSMENU */ | 0x00020000 /* MINIMIZEBOX */ | 0x00010000 /* MAXIMIZEBOX */ | 0x00800000 /* BORDER */);
  SetWindowLongPtrW(hwnd, GWL_STYLE, style >>> 0);
  let ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  ex &= ~(0x00000001 /* DLGMODALFRAME */ | 0x00000200 /* CLIENTEDGE */ | 0x00020000 /* STATICEDGE */ | 0x00000100 /* WINDOWEDGE */);
  ex |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  if (layer.mode !== 'legacy') {
    // Progman uses DirectComposition on 24H2; children must be layered to be composed.
    ex |= WS_EX_LAYERED;
  }
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
  if (layer.mode !== 'legacy') SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  SetParent(hwnd, layer.parent);
  const r = screenToParent(layer.parent, physRect);
  if (layer.mode === 'legacy') {
    SetWindowPos(hwnd, 0, r.x, r.y, r.width, r.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
  } else {
    // Directly below the icons view...
    SetWindowPos(hwnd, layer.defView || HWND_BOTTOM, r.x, r.y, r.width, r.height, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    // ...and the static wallpaper WorkerW at the very bottom. (Putting it directly below *this* window
    // would hide every wallpaper embedded earlier, e.g. the one on the other monitor.)
    if (layer.workerw) SetWindowPos(layer.workerw, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  return layer.mode;
}

function moveEmbedded(hwnd, physRect) {
  const parent = GetParent(hwnd);
  if (!parent) return;
  const r = screenToParent(parent, physRect);
  SetWindowPos(hwnd, 0, r.x, r.y, r.width, r.height, SWP_NOZORDER | SWP_NOACTIVATE);
}

/**
 * Windows 11 24H2+: our wallpapers and Explorer's static-wallpaper WorkerW are siblings inside Progman.
 * Explorer sometimes raises that WorkerW (wallpaper refresh, theme change, slideshow), which hides our
 * windows although they are still embedded. Returns true when every given window is above it; with
 * fix=true the WorkerW is pushed back to the bottom.
 */
function keepAboveStaticWallpaper(hwnds, fix = true) {
  const progman = FindWindowW('Progman', null);
  if (!progman) return true;
  const worker = FindWindowExW(progman, 0, 'WorkerW', null);
  if (!worker) return true;
  const mine = new Set(hwnds.filter((h) => GetParent(h) === progman));
  if (!mine.size) return true;
  // Walk Progman's children top to bottom; any of ours found after the WorkerW is hidden.
  let ok = true, seenWorker = false;
  for (let h = GetWindow(progman, GW_CHILD); h; h = GetWindow(h, GW_HWNDNEXT)) {
    if (h === worker) seenWorker = true;
    else if (seenWorker && mine.has(h)) { ok = false; break; }
  }
  if (!ok && fix) SetWindowPos(worker, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  return ok;
}

function isEmbedded(hwnd) {
  const p = GetParent(hwnd);
  if (!p || !IsWindow(p)) return false;
  const c = className(p);
  return c === 'WorkerW' || c === 'Progman';
}

/** Re-applies the system wallpaper so Explorer repaints after we leave (clears last frame). */
function refreshSystemWallpaper() {
  const SPI_GETDESKWALLPAPER = 0x0073, SPI_SETDESKWALLPAPER = 0x0014, SPIF_SENDCHANGE = 0x2;
  const buf = new Uint16Array(520);
  SystemParametersInfoW(SPI_GETDESKWALLPAPER, 520, buf, 0);
  SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, buf, SPIF_SENDCHANGE);
}

/** Keep a widget window at the bottom of the z-order (above wallpaper, below apps). */
function sendToBottom(hwnd) {
  SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function setClickThrough(hwnd, on) {
  let ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  ex = on ? (ex | WS_EX_TRANSPARENT | WS_EX_LAYERED) : (ex & ~WS_EX_TRANSPARENT);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
}

function cursorPos() {
  const p = {};
  return GetCursorPos(p) ? p : { x: 0, y: 0 };
}

const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland',
  'XamlExplorerHostIslandWindow', 'ForegroundStaging', 'MultitaskingViewFrame', 'TaskListThumbnailWnd']);

function monitorRect(hwnd) {
  const mon = MonitorFromWindow(hwnd, 2 /* NEAREST */);
  const mi = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
  if (!GetMonitorInfoW(mon, mi)) return null;
  return mi.rcMonitor;
}

function isCloaked(hwnd) {
  const v = [0];
  return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, v, 4) === 0 && v[0] !== 0;
}

/**
 * Describes the foreground window: its state relative to its monitor.
 * state: 'desktop' | 'focused' | 'maximized' | 'fullscreen'
 */
function foregroundState(ownPids = []) {
  const fg = GetForegroundWindow();
  if (!fg) return { state: 'desktop' };
  const cls = className(fg);
  if (SHELL_CLASSES.has(cls)) return { state: 'desktop', cls };
  const pid = [0];
  GetWindowThreadProcessId(fg, pid);
  if (ownPids.includes(pid[0])) return { state: 'desktop', own: true, cls };
  if (!IsWindowVisible(fg) || IsIconic(fg) || isCloaked(fg)) return { state: 'desktop', cls };
  const r = rectOf(fg);
  const m = monitorRect(fg);
  if (!r || !m) return { state: 'focused', cls };
  const monitor = { x: m.left, y: m.top, width: m.right - m.left, height: m.bottom - m.top };
  if (r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom) {
    return { state: 'fullscreen', monitor, cls, pid: pid[0] };
  }
  if (IsZoomed(fg)) return { state: 'maximized', monitor, cls, pid: pid[0] };
  return { state: 'focused', monitor, cls, pid: pid[0] };
}

// ---------- Taskbar styling (same technique as TranslucentTB) ----------
const ACCENT = { normal: 0, opaque: 1, transparent: 2, blur: 3, acrylic: 4 };
function taskbarWindows() {
  const list = [];
  const main = FindWindowW('Shell_TrayWnd', null);
  if (main) list.push(main);
  let after = 0;
  for (let i = 0; i < 16; i++) {
    const h = FindWindowExW(0, after, 'Shell_SecondaryTrayWnd', null);
    if (!h) break;
    list.push(h); after = h;
  }
  return list;
}
/** mode: normal|opaque|transparent|blur|acrylic ; color: 0xAABBGGRR */
function setTaskbarStyle(mode, color = 0x00000000) {
  const state = ACCENT[mode] ?? 0;
  const policy = { AccentState: state, AccentFlags: state === ACCENT.transparent ? 2 : 2, GradientColor: color >>> 0, AnimationId: 0 };
  const buf = koffi.alloc(ACCENTPOLICY, 1);
  koffi.encode(buf, ACCENTPOLICY, policy);
  let ok = 0;
  for (const h of taskbarWindows()) {
    const data = { Attribute: 19 /* WCA_ACCENT_POLICY */, Data: buf, SizeOfData: koffi.sizeof(ACCENTPOLICY) };
    if (SetWindowCompositionAttribute(h, data)) ok++;
  }
  koffi.free(buf);
  return ok;
}

function lockWorkstation() { return LockWorkStation(); }

module.exports = {
  lockWorkstation,
  hwndFromBuffer, className, findDesktopLayer, embedWindow, moveEmbedded, isEmbedded,
  refreshSystemWallpaper, sendToBottom, setClickThrough, cursorPos, foregroundState,
  setTaskbarStyle, taskbarWindows, ShowWindow, IsWindow, GetParent, trimWorkingSet, rectOf, keepAboveStaticWallpaper
};
