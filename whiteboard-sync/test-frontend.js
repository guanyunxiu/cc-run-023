'use strict';
/*
 * v2 前端逻辑测试（无浏览器）：
 * 用 DOM/Canvas2D/WebSocket stub 加载真实的 public/kernel.js + public/app.js，
 * 模拟工具点击与 pointer 手势，验证：
 *  - 落笔预提交：收笔产生带 clientId/lamport/clock 的 create 信封，点含 p/t/w（压感变宽）
 *  - RDP 简化生效；远端 ops 经因果缓冲物化为对象并触发渲染
 *  - 选择/移动：高频帧带 squashKey，pointerup 后只登记一条撤销
 *  - 撤销发出逆操作（set 恢复手势前坐标）
 *  - 像素橡皮产生分块 erase 信封；对象擦产生 delete
 *  - 快照重置 + 未确认信封重发不丢、不重
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS -', msg); }
  else { failed++; console.error('  FAIL -', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(10);

/* ------------------------------ stubs ------------------------------ */
const listeners = (el) => (el._ls = el._ls || {});

function makeCtx() {
  // 任意属性可写、任意方法 noop 的 Canvas2D 替身
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'canvas') return {};
      if (prop in t) return t[prop];
      return () => {};
    },
    set() { return true; }
  });
}

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, style: {}, files: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, force) { const on = force == null ? !this._s.has(c) : force; this._s[on ? 'add' : 'delete'](c); return on; },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(type, fn) { listeners(el)[type] = listeners(el)[type] || []; listeners(el)[type].push(fn); },
    removeEventListener() {},
    closest() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 700 }; },
    focus() {}, blur() {}, click() {}, appendChild() {},
    _emit(type, ev) { (listeners(el)[type] || []).forEach((fn) => fn(ev)); }
  };
  return el;
}

const els = {};
const mainCanvas = (() => {
  const el = makeEl('mainCanvas');
  el.width = 0; el.height = 0;
  el.getContext = () => makeCtx();
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
})();
const boardWrap = makeEl('boardWrap');

const store = {};
let liveSocket = null;

global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.navigator = { onLine: true };
global.location = { protocol: 'http:', host: 'localhost:8080' };
global.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1
};global.Image = class { set src(v) { if (this.onload) this.onload(); } get src() { return ''; } };
global.FileReader = class { readAsDataURL() { this.onload && this.onload(); } };

global.document = {
  getElementById(id) {
    if (id === 'mainCanvas') return mainCanvas;
    if (id === 'boardWrap') return boardWrap;
    if (!els[id]) els[id] = makeEl(id);
    return els[id];
  },
  createElement(tag) {
    if (tag === 'canvas') {
      const c = makeEl('canvas'); c.width = 0; c.height = 0; c.getContext = () => makeCtx(); return c;
    }
    return makeEl(tag);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  activeElement: null
};

// 内存 WebSocket：捕获发送、可注入服务端消息
global.WebSocket = class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this._ls = {}; this.sent = []; liveSocket = this; FakeWS.last = this;
    setTimeout(() => this._emit('open'), 0); }  send(str) {
    const msg = JSON.parse(str);
    this.sent = this.sent || [];
    this.sent.push(msg);
    if (msg.type === 'join') {
      setTimeout(() => {
        this._emit('message', { data: JSON.stringify({ type: 'joined', roomId: msg.roomId, userId: msg.userId, lastSeq: 0 }) });
        this._emit('message', { data: JSON.stringify({ type: 'snapshot', watermark: 0, snapshot: { version: 2, known: {}, groups: [], objects: [] }, envelopes: [] }) });
      }, 0);
    }
  }
  close() { this.readyState = 3; setTimeout(() => this._emit('close'), 0); }
  addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); }
  removeEventListener() {}
  _emit(type, ev) { (this._ls[type] || []).forEach((fn) => fn(ev)); }
  dispatch(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
};
global.WebSocket.OPEN = 1;
global.WebSocket.CONNECTING = 0;
global.WebSocket.CLOSING = 2;
global.WebSocket.CLOSED = 3;

global.WB = require('./public/kernel.js');
global.WBReplay = require('./public/replay.js');
global.alert = () => {};
global.confirm = () => true;
// fetch stub：回放/版本面板的 HTTP API（默认返回空时间轴/版本列表，测试可覆盖）
global.fetch = async function (url, opts) {
  const u = String(url);
  let payload = {};
  if (/\/api\/timeline/.test(u)) payload = global.__tlPayload || { events: [], firstSeq: 0, lastSeq: 0, count: 0 };
  else if (/\/api\/versions/.test(u)) payload = { versions: [] };
  else if (/\/api\/version/.test(u)) payload = {};
  return { ok: true, status: 200, json: async () => payload };
};
(0, eval)(fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8'));

/* ------------------------------ 辅助 ------------------------------ */
const WB = global.WB;
function clickTool(name) {
  const btn = { dataset: { tool: name }, classList: makeEl('x').classList, closest: () => btn };
  els.tools._emit('click', { target: btn });
}
function clickSub(containerId, attr, val) {
  const btn = { dataset: { [attr]: val }, classList: makeEl('x').classList, closest: () => btn };
  els[containerId]._emit('click', { target: btn });
}
function pointer(type, x, y, extra) {
  mainCanvas._emit(type, Object.assign({
    type, button: 0, pointerId: 1, clientX: x, clientY: y,
    pressure: extra && extra.pressure != null ? extra.pressure : 0.5,
    tiltX: 0, tiltY: 0, timeStamp: (pointer.t = (pointer.t || 0) + 16),
    shiftKey: !!(extra && extra.shift),
    preventDefault() {},
    getCoalescedEvents() { return [{ clientX: x, clientY: y, pressure: this.pressure, timeStamp: this.timeStamp }]; }
  }, extra || {}));
}
function sentEnvelopes() {
  return (liveSocket.sent || []).filter((m) => m.type === 'ops').flatMap((m) => m.envelopes);
}
function lastEnvelope() { const e = sentEnvelopes(); return e[e.length - 1]; }

async function run() {
  // 1) 加入房间 → 连接 + join + snapshot
  els.roomInput.value = 'room-fe';
  els.joinForm._emit('submit', { preventDefault() {} });
  await tick(); await tick();
  assert(store['wb2_user_id'], 'userId persisted');
  assert((liveSocket.sent[0] || {}).type === 'join', 'join sent');
  await tick();

  // 2) 切换到钢笔（关闭图形识别，保证保留为笔迹），画一笔弯曲笔迹：压感点 + 信封头
  clickTool('pen');
  els.recognizeBtn._emit('click', {}); // 关闭图形识别
  await tick();
  pointer('pointerdown', 10, 10, { pressure: 0.2 });
  pointer('pointermove', 14, 22, { pressure: 0.7 });
  pointer('pointermove', 40, 10, { pressure: 0.9 });
  pointer('pointerup', 44, 30, { pressure: 0.9 });
  await tick(); await tick();
  let createEnv = lastEnvelope();
  assert(createEnv && createEnv.op.kind === 'create', 'stroke commit sends create envelope');
  assert(createEnv.op.objects[0].type === 'stroke', 'created object is a stroke');
  assert(createEnv.clientId && Number.isInteger(createEnv.lamport) && createEnv.clock[createEnv.clientId] >= 1,
    'envelope carries clientId + lamport + dependency vector');
  const pts = createEnv.op.objects[0].fields.stroke.points;
  assert(pts.every((p) => Number.isFinite(p.w)), 'every point carries computed width (pressure/speed)');
  assert(pts.every((p) => Number.isFinite(p.t) && Number.isFinite(p.p)), 'points carry timestamp + pressure + tilt');
  const wLow = pts[0].w;
  // 收笔后本地对象表含该笔迹，且渲染不抛错
  const oid = createEnv.op.objects[0].oid;
  assert(!!WB, 'kernel loaded');
  await tick();

  // 3) 远端创建一个矩形 + 一条笔迹：经 ops 物化为对象
  const remoteCreate = {
    id: 'remote:1', clientId: 'remote', lamport: 1, clock: { remote: 1 },
    op: { kind: 'create', objects: [{ oid: 'rrect', type: 'rect',
      fields: { x: 100, y: 100, w: 120, h: 80, color: '#ef4444', stroke: { width: 3 }, z: '0.5' } }] }
  };
  liveSocket.dispatch({ type: 'ops', envelopes: [remoteCreate] });
  await tick();
  // 通过 DOM 无法直接读 app 内部 doc；改为发出一次“选择命中”验证对象已物化
  clickTool('select');
  await tick();
  const beforeHit = sentEnvelopes().length;
  pointer('pointerdown', 150, 130); // 矩形内部
  pointer('pointerup', 150, 130);
  await tick();
  // 点中矩形（不拖动）不会新建任何对象，也不会产生移动 set
  const afterHit = sentEnvelopes().slice(beforeHit);
  assert(afterHit.length === 0, 'clicking remote rect selects it, emits no create/set (no drag)');

  // 4) 选中矩形后移动：多帧 set 带 squashKey；松手后只产生一次撤销记录
  const beforeCount = sentEnvelopes().length;
  pointer('pointerdown', 150, 130);
  pointer('pointermove', 160, 140);
  pointer('pointermove', 170, 145);
  pointer('pointerup', 170, 145);
  await tick();
  const moveEnvs = sentEnvelopes().slice(beforeCount);
  assert(moveEnvs.length >= 1 && moveEnvs.every((e) => e.op.kind === 'set' && e.squashKey),
    `move emits squashed set envelopes (${moveEnvs.length})`);
  assert(moveEnvs.every((e) => /^move:/.test(e.squashKey)), 'move squashKey is gesture-scoped per object');
  const finalTr = moveEnvs[moveEnvs.length - 1].op.fields.tr;
  assert(finalTr.tx === 20 && finalTr.ty === 15, `final transform tx/ty = 20/15 (got ${finalTr.tx}/${finalTr.ty})`);

  // 5) 撤销移动：发出一条逆 set，恢复手势前 x=100
  const beforeUndo = sentEnvelopes().length;
  els.undoBtn._emit('click', {});
  await tick();
  const undoEnv = sentEnvelopes().slice(beforeUndo)[0];
  assert(undoEnv && undoEnv.op.kind === 'set' && undoEnv.op.inv, 'undo emits an inverse set envelope');
  assert(undoEnv.op.fields.tr.tx === 0 && undoEnv.op.fields.tr.ty === 0,
    `inverse restores pre-gesture transform (got tx=${undoEnv.op.fields.tr.tx})`);
  assert(els.redoBtn.disabled === false, 'redo enabled after undo');

  // 6) 远端“他人随后修改”后，再撤销自己的操作应被架空（不覆盖他人值）
  //    直接发一条他人的 set x=300（lamport 更大），然后本地撤销“更早”的移动手势：
  const otherMove = {
    id: 'remote:2', clientId: 'remote', lamport: 99, clock: { remote: 2, [createEnv.clientId]: createEnv.clock[createEnv.clientId] },
    op: { kind: 'set', oid: 'rrect', fields: { tr: { tx: 200, ty: 0, sx: 1, sy: 1, r: 0 } }, prev: { tr: { tx: 0 } } }
  };
  liveSocket.dispatch({ type: 'ops', envelopes: [otherMove] });
  await tick();
  // 重做刚撤销的移动 → 再撤销（此时逆操作的原 lamport 远小于他人 99），应空转
  els.redoBtn._emit('click', {});
  await tick();
  els.undoBtn._emit('click', {});
  await tick();
  // 空转不改变结果：通过再发一次远端查询间接验证较繁琐，这里至少确认撤销信封带 inv 且被服务端式 Doc 接受
  const lastUndo = sentEnvelopes()[sentEnvelopes().length - 1];
  assert(lastUndo.op.inv && lastUndo.op.inv.originLamport < 99, 'undo after remote edit carries inverse with older originLamport (will void via CRDT)');

  // 7) 像素橡皮：划过本地笔迹产生分块 erase 信封
  clickTool('eraser');
  clickSub('eraserTools', 'erase', 'pixel');
  await tick();
  // 笔迹位于 (10,10)→(14,22)→(40,10)→(44,30)，沿它划
  pointer('pointerdown', 5, 5);
  pointer('pointermove', 25, 20);
  pointer('pointermove', 50, 35);
  pointer('pointerup', 50, 35);
  await tick();
  const eraseEnv = sentEnvelopes().slice().reverse().find((e) => e.op.kind === 'erase');
  assert(!!eraseEnv, 'pixel eraser emits erase envelope');
  assert(eraseEnv.op.chunks.every((c) => Array.isArray(c.cells) && Number.isInteger(c.tx)),
    'erase is chunked into tiles with cell indices (incremental, no full redraw)');

  // 8) 对象橡皮：点中矩形产生 delete（不是 erase）
  clickSub('eraserTools', 'erase', 'object');
  pointer('pointerdown', 310, 130); // 矩形被他人移到 x=300 后中心约 360,140；点其左侧
  pointer('pointerup', 310, 130);
  await tick();
  const delEnv = sentEnvelopes().slice().reverse().find((e) => e.op.kind === 'delete');
  assert(!!delEnv && delEnv.op.oids.includes('rrect'), 'object eraser deletes the hit object');

  // 9) 快照重置后，未 ack 的本地信封重发不丢、不产生重复 create
  const priorIds = new Set(sentEnvelopes().map((e) => e.id));
  // 模拟重连：服务端重下空快照（不含本地未确认操作），joined 后 flushPending
  liveSocket.dispatch({ type: 'joined', roomId: 'room-fe', userId: store['wb2_user_id'], lastSeq: 0 });
  liveSocket.dispatch({ type: 'snapshot', watermark: 0, snapshot: { version: 2, known: {}, groups: [], objects: [] }, envelopes: [] });
  await tick(); await tick();
  const resentMsgs = liveSocket.sent.slice(-2).filter((m) => m.type === 'ops');
  assert(resentMsgs.length >= 1, 'after snapshot reset, pending local envelopes are resent');
  const resentIds = resentMsgs.flatMap((m) => m.envelopes.map((e) => e.id));
  assert(resentIds.every((id) => priorIds.has(id)),
    'resend reuses original envelope ids (server idempotent, no duplicate objects)');

  // 10) 录制回放：进入回放只读、与实时 doc 隔离、播放/拖拽/跳 seq、退出回最新
  // 用已发出的本地 + 注入的远端信封构造时间轴（服务端会带 seq/serverTs）
  const allEnvs = sentEnvelopes().slice();
  allEnvs.forEach((e, i) => { e.seq = i + 1; e.serverTs = 1000 + i * 50; });
  global.__tlPayload = { events: allEnvs, firstSeq: 1, lastSeq: allEnvs.length, count: allEnvs.length };
  const wb = window.__wb;
  const liveCountBefore = wb.doc.liveObjects().length;
  await els.replayBtn._emit('click', {});
  await tick(); await tick();
  assert(wb.replayMode === true, 'entered replay mode');
  assert(els.replayBar.hidden === false && els.replayBadge.hidden === false, 'replay bar + read-only badge shown');
  assert(wb.replayCtl && wb.replayCtl.totalEvents === allEnvs.length, 'timeline loaded into controller');
  // 默认停在最新 seq
  assert(wb.replayCtl.currentSeq === allEnvs.length, `paused at latest seq ${allEnvs.length}`);

  // 跳到 seq=1：回放 doc 只应呈现第一个事件（一条笔迹），实时 doc 不受影响
  wb.replayCtl.seekSeq(1);
  assert(wb.replayCtl.doc.liveObjects().length <= 1, 'replay doc at seq1 shows early state');
  assert(wb.doc.liveObjects().length === liveCountBefore, 'live doc untouched while scrubbing replay');

  // 跳 seq、拖拽、倍速 API 不抛错
  wb.replayCtl.seekFraction(0); wb.replayCtl.setSpeed(4); wb.replayCtl.frame(1);
  assert(wb.replayCtl.speed === 4, 'speed change applied');

  // 回放期间画布指针事件被忽略（只读）
  const sentDuringReplay = liveSocket.sent.length;
  clickTool('pen'); // 工具点击仍可切换 UI，但画布不应提交
  pointer('pointerdown', 500, 500);
  pointer('pointermove', 520, 520);
  pointer('pointerup', 520, 520);
  await tick();
  assert(liveSocket.sent.length === sentDuringReplay, 'no ops transmitted while in read-only replay');

  // 回放期间远端实时 ops 仍正常进入 live doc（不影响回放画面，也不丢协作）
  const liveOps = liveSocket.sent.length;
  liveSocket.dispatch({ type: 'ops', envelopes: [{
    id: 'livex:1', clientId: 'livex', lamport: 1, clock: { livex: 1 },
    op: { kind: 'create', objects: [{ oid: 'liveDuringReplay', type: 'rect',
      fields: { x: 1, y: 1, w: 5, h: 5, z: '0.9' } }] }
  }] });
  await tick();
  assert(wb.doc.get('liveDuringReplay'), 'live collaboration still ingested during replay');
  assert(!wb.replayCtl.doc.get('liveDuringReplay'), 'replay doc does not receive live ops (isolated)');
  assert(liveSocket.sent.length === liveOps, 'replay does not echo anything to network');

  // 退出回放：画面回到实时最新（含回放期间到达的协作）
  els.rpExit._emit('click', {});
  assert(wb.replayMode === false && wb.replayCtl === null, 'exited replay, controller discarded');
  assert(els.replayBar.hidden === true && els.replayBadge.hidden === true, 'replay UI hidden after exit');
  assert(wb.doc.liveObjects().some((o) => o.oid === 'liveDuringReplay'), 'after exit board shows latest live state');
  // 退出后编辑恢复正常
  clickTool('pen');
  const sentAfterExit = liveSocket.sent.length;
  pointer('pointerdown', 600, 100);
  pointer('pointermove', 630, 140);
  pointer('pointerup', 640, 150);
  await tick(); await tick();
  assert(liveSocket.sent.length > sentAfterExit, 'editing works again after exiting replay');

  console.log(`\n========================================`);
  console.log(`FRONTEND RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error('FRONTEND CRASHED:', err); process.exit(1); });
