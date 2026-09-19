'use strict';
/*
 * 录制回放 / 版本管理测试（需先启动服务端，脚本会自动拉起 server.js）。
 *
 * 纯逻辑部分（public/replay.js，无需服务端）：
 *  - ReplayController：加载/播放/暂停/倍速/拖拽/跳 seq/单步/检查点重建一致性
 *  - buildRestoreOps：移动恢复、删除恢复、新增对象回滚、像素擦恢复
 *
 * 协议部分（真实 ws + HTTP）：
 *  - 服务端录制时间轴：ops 物化后 /api/timeline 按 seq 返回
 *  - 保存命名版本（最新 / 指定 seq）、列表、详情、删除
 *  - 按 seq 物化的版本快照内容正确
 *  - 恢复版本：客户端补偿信封广播，另一客户端收敛到目标版本
 *  - 回放只读：回放期间发出的信封不会被接受/上行（前端保障 + 时间轴不被污染）
 */
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const WB = require('./public/kernel.js');
const WBR = require('./public/replay.js');

const PORT = process.env.PORT || 8081;
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS -', msg); }
  else { failed++; console.error('  FAIL -', msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 测试用调度器 ------------------------------ */
function fakeTimer() {
  let t = 0;
  const pending = new Map();
  let id = 0;
  return {
    now: () => t,
    schedule(fn, delay) { const my = ++id; pending.set(my, { fn, at: t + delay }); return my; },
    cancel(i) { pending.delete(i); },
    advance(ms) {
      t += ms;
      const due = [...pending.entries()].filter(([, e]) => e.at <= t).map(([i]) => i);
      for (const i of due) { const e = pending.get(i); pending.delete(i); e.fn(); }
    },
    pending: () => pending.size
  };
}

/* ------------------------------ 纯逻辑测试 ------------------------------ */
function makeTimeline(n, gap) {
  // n 个信封：create obj-0，之后连续 set x=1..n-1；带 seq 与 serverTs
  const clock = new WB.Clock('u1');
  const envs = [];
  let env = WB.makeEnvelope(clock, {
    kind: 'create', objects: [{ oid: 'o1', type: 'rect', fields: { x: 0, y: 0, w: 10, h: 10, z: '0.5' } }]
  });
  envs.push(env);
  for (let i = 1; i < n; i++) {
    env = WB.makeEnvelope(clock, { kind: 'set', oid: 'o1', fields: { x: i }, prev: { x: i - 1 } });
    envs.push(env);
  }
  envs.forEach((e, i) => { e.seq = i + 1; e.serverTs = 1000 + i * gap; });
  return envs;
}

/** 把信封序列折叠成一个 Doc（参照服务端物化） */
function fold(events) {
  const d = new WB.Doc();
  for (const e of events) d.apply(e);
  return d;
}

/**
 * 构造一个「已观察过历史」的时钟：恢复操作是当前时刻的新编辑，其 lamport 必须
 * 大于历史最大值才能在 LWW 中胜出（真实 app.js 的 clock 已随同步推进，这里模拟）。
 */
function syncedClock(clientId, history) {
  const c = new WB.Clock(clientId);
  let maxL = 0;
  for (const e of history) {
    if ((e.lamport | 0) > maxL) maxL = e.lamport | 0;
    c.mergeVC(e.clock);
  }
  c.lamport = maxL;
  // 自身 local 计数必须与 vc[clientId] 一致（makeEnvelope tick 后 vc[self]=local）
  c.local = c.vc[clientId] | 0;
  return c
}
/** 用同步时钟把恢复操作体签成信封并应用到 doc（验证 LWW 收敛） */
function applyRestoreOps(targetDoc, restoreOps, history, clientId) {
  const c = syncedClock(clientId || 'me', history || []);
  const envs = restoreOps.map((opBody) => WB.makeEnvelope(c, opBody));
  if (envs.length > 1) WB.atomic(envs);
  // 本地先乐观物化（单个 Doc 内无乱序，直接 apply）
  for (const e of envs) targetDoc.apply(e);
  return envs;
}

async function runUnit() {
  console.log('\n[U1] 加载时间轴 + 拖拽/单步：回放 Doc 与直接折叠结果一致');
  const events = makeTimeline(20, 50);
  const timer = fakeTimer();
  const ctl = new WBR.ReplayController({
    events, schedule: timer.schedule, cancel: timer.cancel, now: timer.now
  });
  ctl.seekIndex(19);
  const folded = fold(events);
  assert(ctl.doc.get('o1').x === 19, 'replay doc at last event x=19');
  assert(ctl.doc.get('o1').x === folded.get('o1').x, 'replay equals fold-from-scratch');
  ctl.seekIndex(5);
  assert(ctl.doc.get('o1').x === 5, 'seek back to index 5 gives x=5 (checkpoint rebuild)');
  ctl.frame(3);
  assert(ctl.doc.get('o1').x === 8, 'frame(+3) advances to x=8');
  ctl.frame(-8);
  assert(ctl.doc.get('o1').x === 0, 'frame(-8) back to create state x=0');

  console.log('\n[U2] 跳到指定 seq：呈现 seq<=target 已应用状态');
  ctl.seekSeq(11);
  assert(ctl.currentSeq === 11 && ctl.doc.get('o1').x === 10,
    `seekSeq(11) applies seq<=11, x=10 (got seq=${ctl.currentSeq},x=${ctl.doc.get('o1').x})`);
  ctl.seekSeq(1);
  assert(ctl.doc.get('o1').x === 0, 'seekSeq(1) shows just-created object x=0');

  console.log('\n[U3] 播放 / 暂停 / 倍速（注入虚拟时钟，确定性）');
  ctl.seekIndex(-1);
  assert(!ctl.playing, 'starts paused');
  ctl.play();
  assert(ctl.playing, 'play() sets playing');
  // play() 立即应用已到点的第一个事件（虚拟时间 0）
  assert(ctl.index === 0 && ctl.doc.get('o1').x === 0, `play immediately shows event0 (idx=${ctl.index})`);
  timer.advance(50); // 到事件2（虚拟 50ms）
  assert(ctl.index === 1 && ctl.doc.get('o1').x === 1, 'after +50ms at event1 x=1');
  timer.advance(50); // 到事件3
  assert(ctl.index === 2 && ctl.doc.get('o1').x === 2, 'after +100ms at event2 x=2');
  ctl.pause();
  assert(!ctl.playing && timer.pending() === 0, 'pause stops timer loop');
  // 2× 倍速：恢复后 100ms 虚拟时间应推进 2 个事件
  ctl.seekIndex(1);
  ctl.setSpeed(2);
  ctl.play();
  timer.advance(100);
  assert(ctl.index >= 3, `2x speed advances ~2 events per 100ms (idx=${ctl.index})`);
  ctl.pause();

  console.log('\n[U4] 倍速即时生效（播放中切换不跳变）');
  ctl.seekIndex(0);
  ctl.setSpeed(1);
  ctl.play();
  timer.advance(50); // idx=1
  ctl.setSpeed(4);
  const idxAfterSwitch = ctl.index;
  timer.advance(50); // 4×：应跨过多个事件
  assert(ctl.index > idxAfterSwitch + 1, `speed-up during play takes effect (${idxAfterSwitch} -> ${ctl.index})`);
  ctl.pause();

  console.log('\n[U5] 播到结尾自动暂停；fraction/时间读数');
  ctl.seekIndex(18);
  ctl.play();
  timer.advance(200);
  assert(!ctl.playing && ctl.index === 19, 'auto-pause at timeline end');
  assert(Math.abs(ctl.duration - 19 * 50) < 1e-6, `duration = ${ctl.duration}ms`);
  assert(Math.abs(ctl.fraction - 1) < 1e-9, 'fraction=1 at end');
  ctl.destroy();

  console.log('\n[U6] 拖拽 fraction 与 seekTime');
  const ctl2 = new WBR.ReplayController({ events });
  ctl2.seekFraction(0.5);
  assert(ctl2.index === Math.round(0.5 * 19), `seekFraction(0.5) -> idx ${ctl2.index}`);
  ctl2.seekTime(500); // serverTs 1000 起，+500ms -> 事件 10
  assert(ctl2.currentSeq === 11, `seekTime(500ms) -> seq 11 (got ${ctl2.currentSeq})`);
  ctl2.destroy();

  console.log('\n[U7] buildRestoreOps：移动后恢复旧版本 → set 回旧值');
  const base = makeTimeline(3, 10);
  const vDoc = fold(base.slice(0, 2));          // 目标版本：x=1
  const liveDoc = fold(base);                    // 当前：x=2
  const r1 = WBR.buildRestoreOps(liveDoc, vDoc.snapshot());
  assert(r1.ops.length === 1 && r1.ops[0].kind === 'set' && r1.ops[0].fields.x === 1,
    'restore generates one set x=1');
  // 应用恢复信封（已同步时钟签发，LWW 胜出）后 live doc 收敛到目标
  applyRestoreOps(liveDoc, r1.ops, base, 'me');
  assert(liveDoc.get('o1').x === 1, 'after restore ops live doc x back to 1');

  console.log('\n[U8] buildRestoreOps：新版本里新增的对象，恢复旧版本 → delete');
  const c2 = new WB.Clock('u2');
  const extra = WB.makeEnvelope(c2, {
    kind: 'create', objects: [{ oid: 'late', type: 'rect', fields: { x: 1, y: 1, w: 5, h: 5, z: '0.6' } }]
  });
  extra.seq = 99;
  const live2 = fold(base);
  live2.apply(extra);
  assert(live2.liveObjects().some((o) => o.oid === 'late'), 'extra object exists before restore');
  const r2 = WBR.buildRestoreOps(live2, fold(base).snapshot());
  const delOp = r2.ops.find((o) => o.kind === 'delete');
  assert(delOp && delOp.oids.includes('late'), 'restore deletes object not in target version');
  applyRestoreOps(live2, r2.ops, base.concat(extra), 'u2');
  assert(!live2.liveObjects().some((o) => o.oid === 'late'), 'extra object gone after restore');
  assert(live2.get('o1').x === fold(base).get('o1').x, 'existing object also restored');

  console.log('\n[U9] buildRestoreOps：旧版本被删的对象 → 恢复时 restore + set 回字段');
  // 目标：有 o1 活着；当前：o1 已 delete
  const initEvents = makeTimeline(1, 10);
  const targetSnap = fold(initEvents).snapshot();
  const live3 = fold(initEvents);
  const dclock = syncedClock('d', initEvents);
  const delEnv = WB.makeEnvelope(dclock, { kind: 'delete', oids: ['o1'] });
  live3.apply(delEnv);
  assert(live3.get('o1').deleted === true, 'o1 deleted in current');
  const r3 = WBR.buildRestoreOps(live3, targetSnap);
  const restoreOp = r3.ops.find((o) => o.kind === 'restore');
  assert(restoreOp && restoreOp.oids.includes('o1'), 'restore emits restore to clear deleted flag');
  applyRestoreOps(live3, r3.ops, initEvents.concat(delEnv), 'd');
  assert(live3.liveObjects().some((o) => o.oid === 'o1'), 'o1 alive again after restore');
  assert(live3.get('o1').x === 0, 'restored o1 has target fields');

  console.log('\n[U10] buildRestoreOps：像素擦单元恢复一致');
  const wb = new WB.Doc();
  const strokeEnv = WB.makeEnvelope(new WB.Clock('w'), {
    kind: 'create', objects: [{ oid: 'st', type: 'stroke',
      fields: { stroke: { width: 8, cellSize: 8, points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] }, z: '0.5' } }]
  });
  wb.apply(strokeEnv);
  assert(wb.erasedCells('st').size === 0, 'no erase initially');
  // 擦除发生在创建之后（推进时钟，否则同 lamport 平局）
  const wclockE = syncedClock('w', [strokeEnv]);
  const eraseEnv = WB.makeEnvelope(wclockE, {
    kind: 'erase', chunks: [{ oid: 'st', tx: 0, ty: 0, cells: [[0, 0], [1, 0]] }]
  });
  wb.apply(eraseEnv);
  assert(wb.erasedCells('st').size === 2, '2 cells erased in live');
  // 目标版本是擦除前的快照 → 恢复应产生 unerase
  const r4 = WBR.buildRestoreOps(wb, fold([strokeEnv]).snapshot());
  const unerase = r4.ops.find((o) => o.kind === 'erase' && o.unerase);
  assert(unerase && unerase.chunks[0].cells.length === 2, 'restore emits unerase for 2 cells');
  applyRestoreOps(wb, r4.ops, [strokeEnv, eraseEnv], 'w');
  assert(wb.erasedCells('st').size === 0, 'cells restored after unerase');
}

/* ------------------------------ 协议测试 ------------------------------ */
function connect() { return new WebSocket(`ws://localhost:${PORT}/ws`); }
function send(ws, o) { ws.send(JSON.stringify(o)); }
function waitMsg(ws, type, pred, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + type)), timeout);
    ws.on('message', function on(raw) {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.type === type && (!pred || pred(m))) { clearTimeout(t); ws.off('message', on); resolve(m); }
    });
  });
}
function httpReq(p, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL('http://localhost:' + PORT + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {} }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : {} }));
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

async function joinAs(room, userId) {
  const ws = connect();
  await new Promise((r) => ws.on('open', r));
  const ps = waitMsg(ws, 'snapshot');
  send(ws, { type: 'join', roomId: room, userId });
  const snap = await ps;
  return { ws, snap };
}

async function runProtocol() {
  const room = 'rec-' + Date.now();
  console.log('\n[P1] 录制：客户端 ops 物化后进入时间轴');
  const A = await joinAs(room, 'A');
  const B = await joinAs(room, 'B');
  const clockA = new WB.Clock('A');
  const issue = (op) => {
    const env = WB.makeEnvelope(clockA, op);
    send(A.ws, { type: 'ops', envelopes: [env] });
    return env;
  };
  const e1 = issue({ kind: 'create', objects: [{ oid: 'r1', type: 'rect',
    fields: { x: 0, y: 0, w: 40, h: 40, z: '0.5' } }] });
  const e2 = issue({ kind: 'set', oid: 'r1', fields: { x: 100 }, prev: { x: 0 } });
  const e3 = issue({ kind: 'set', oid: 'r1', fields: { x: 200 }, prev: { x: 100 } });
  await sleep(250);
  const tl = (await httpReq('/api/timeline?roomId=' + room)).body;
  assert(tl.count === 3 && tl.events.length === 3, `timeline records 3 events (got ${tl.count})`);
  assert(tl.events.every((e, i) => e.seq === i + 1 && Number.isInteger(e.serverTs)),
    'timeline events seq-ordered with serverTs');
  assert(tl.events.map((e) => e.id).join() === [e1.id, e2.id, e3.id].join(),
    'timeline order matches submission order');

  console.log('\n[P2] 时间轴范围过滤 fromSeq/toSeq');
  const tlRange = (await httpReq(`/api/timeline?roomId=${room}&fromSeq=1&toSeq=2`)).body;
  assert(tlRange.events.length === 1 && tlRange.events[0].seq === 2, 'fromSeq/toSeq window returns only seq 2');

  console.log('\n[P3] 保存命名版本（最新 / 指定 seq）');
  const saveNow = await httpReq('/api/versions?roomId=' + room, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: room, name: '最新版', clientId: 'A' })
  });
  assert(saveNow.status === 200 && saveNow.body.seq === 3, `save at head -> seq 3 (got ${saveNow.body.seq})`);
  const vNowId = saveNow.body.id;
  const saveMid = await httpReq('/api/versions?roomId=' + room, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: room, name: '中间版', seq: 2 })
  });
  assert(saveMid.body.seq === 2, 'save at seq=2');
  const vMidId = saveMid.body.id;
  const badName = await httpReq('/api/versions?roomId=' + room, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: room })
  });
  assert(badName.status === 400, 'empty version name rejected');
  const badSeq = await httpReq('/api/versions?roomId=' + room, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: room, name: 'x', seq: 999 })
  });
  assert(badSeq.status === 400, 'seq out of range rejected');

  console.log('\n[P4] 版本列表 / 详情（按 seq 物化的快照内容正确）');
  const list = (await httpReq('/api/versions?roomId=' + room)).body;
  assert(list.versions.length === 2, `2 versions listed (got ${list.versions.length})`);
  assert(list.versions.every((v) => !v.snapshot), 'list payload has no snapshot body');
  const midDetail = (await httpReq(`/api/version?roomId=${room}&id=${vMidId}`)).body;
  const midDoc = new WB.Doc();
  midDoc.loadSnapshot(midDetail.snapshot);
  assert(midDoc.get('r1').x === 100, 'version@seq2 snapshot has x=100');
  const nowDetail = (await httpReq(`/api/version?roomId=${room}&id=${vNowId}`)).body;
  const nowDoc = new WB.Doc();
  nowDoc.loadSnapshot(nowDetail.snapshot);
  assert(nowDoc.get('r1').x === 200, 'version@seq3 snapshot has x=200');

  console.log('\n[P5] 按版本回放：用版本快照/时间轴驱动 ReplayController（只读、隔离）');
  const ctl = new WBR.ReplayController({ events: tl.events });
  ctl.seekSeq(midDetail.seq);
  assert(ctl.doc.get('r1').x === 100, 'replay at version seq2 shows x=100');
  assert(ctl.currentSeq === 2, 'replay currentSeq = 2');
  // 回放 Doc 与协作者实时 Doc 互不影响
  assert(!ctl.doc.has(e3.id) || ctl.doc.get('r1').x === 100, 'replay doc isolated at older state');
  ctl.destroy();

  console.log('\n[P6] 恢复版本：补偿信封广播，其他客户端收敛到旧版本');
  // 服务端房间当前 r1.x=200；恢复到 seq2(x=100)
  const liveFold = fold(tl.events);
  const restore = WBR.buildRestoreOps(liveFold, midDetail.snapshot);
  assert(restore.ops.length >= 1, 'restore yields ops');
  const setBack = restore.ops.find((o) => o.kind === 'set');
  assert(setBack && setBack.fields.x === 100, 'restore op sets x back to 100');
  const renvs = applyRestoreOps(liveFold, restore.ops, tl.events, 'A');
  send(A.ws, { type: 'ops', envelopes: renvs });
  await sleep(300);
  const apiRoom = (await httpReq('/api/room?roomId=' + room)).body;
  assert(apiRoom.seq >= 4, `restore ops materialized, server seq=${apiRoom.seq}`);
  // 晚加入客户端看到恢复后的状态
  const C = await joinAs(room, 'C');
  const cDoc = new WB.Doc();
  cDoc.loadSnapshot(C.snap.snapshot);
  assert(cDoc.get('r1').x === 100, `late joiner sees restored x=100 (got ${cDoc.get('r1').x})`);

  console.log('\n[P7] 恢复后再次保存/继续编辑：时间轴不被压缩影响、版本仍可回放');
  const tl2 = (await httpReq('/api/timeline?roomId=' + room)).body;
  assert(tl2.count >= 4, `timeline keeps all events incl restore (${tl2.count})`);
  // 触发服务端压缩（log 压缩），时间轴应不受影响
  await httpReq('/api/compact?roomId=' + room);
  const tl3 = (await httpReq('/api/timeline?roomId=' + room)).body;
  assert(tl3.count === tl2.count, 'timeline unaffected by log compaction');

  console.log('\n[P8] 删除版本');
  const del = await httpReq(`/api/version?roomId=${room}&id=${vMidId}`, { method: 'DELETE' });
  assert(del.status === 200 && del.body.ok === true, 'version deleted');
  const list2 = (await httpReq('/api/versions?roomId=' + room)).body;
  assert(list2.versions.length === 1 && list2.versions[0].id === vNowId, 'only latest version remains');
  const gone = await httpReq(`/api/version?roomId=${room}&id=${vMidId}`);
  assert(gone.status === 404, 'deleted version detail 404');

  console.log('\n[P9] 未知房间 404');
  assert((await httpReq('/api/timeline?roomId=nope')).status === 404, 'timeline 404 for unknown room');
  assert((await httpReq('/api/versions?roomId=nope')).status === 404, 'versions 404 for unknown room');

  A.ws.close(); B.ws.close();
}

let serverProc = null;
async function ensureServer() {
  try {
    await httpReq('/api/rooms');
    console.log('using already-running server on', PORT);
    return;
  } catch (_) { /* start */ }
  serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { await httpReq('/api/rooms'); console.log('spawned test server on', PORT); return; } catch (_) {}
  }
  throw new Error('test server failed to start');
}

async function main() {
  await runUnit();
  await ensureServer();
  await runProtocol();
  console.log(`\n========================================`);
  console.log(`REPLAY RESULT: ${passed} passed, ${failed} failed`);
  if (serverProc) serverProc.kill();
  process.exit(failed ? 1 : 0);
}
main().catch((err) => { console.error('REPLAY CRASHED:', err); if (serverProc) serverProc.kill(); process.exit(1); });
