'use strict';
/*
 * 录制 / 时间轴回放 / 版本管理测试（纯 Node，无服务端/浏览器）：
 *  1. Recorder：本地/远端记录、时间轴顺序、ACK seqs 回填、基线折叠 prune
 *  2. Player：play/pause/倍速/拖拽时间/跳 seq/跳索引，视图与实时 Doc 逐状态一致
 *  3. 回放只读且隔离：实时 Doc 在回放期间继续接收远端操作，互不影响
 *  4. VersionStore：保存/命名/列表/删除 + 内存持久化
 *  5. restoreEnvelopes：删除新增、恢复被删、字段纠偏、擦除单元恢复，提交后收敛到版本
 */
const WB = require('./public/kernel.js');
const R = require('./public/replay.js');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS -', msg); }
  else { failed++; console.error('  FAIL -', msg); }
}
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- 测试辅助：确定性虚拟时钟 ------------------------- */
function virtualTimers() {
  let now = 1000;
  const timers = new Map();
  let seq = 1;
  return {
    now: () => now,
    schedule(fn) { const id = seq++; timers.set(id, fn); return id; },
    cancel(id) { timers.delete(id); },
    // 推进一帧（播放器 rAF 只取时间差，不依赖回调参数）
    frame(dt) {
      now += dt;
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn(now);
    },
    async frames(n, dt) { for (let i = 0; i < n; i++) { this.frame(dt); await sleep(0); } }
  };
}

function node(id) {
  const clock = new WB.Clock(id);
  const buf = new WB.CausalBuffer();
  const doc = new WB.Doc();
  const history = new Map();
  return {
    id, clock, buf, doc, history,
    issue(op, opts) {
      const env = WB.makeEnvelope(clock, op, opts);
      const ready = buf.push(env);
      for (const e of ready) { clock.observeLamport(e.lamport); clock.mergeVC(e.clock); doc.apply(e); history.set(e.id, e); }
      return env;
    },
    receive(env) {
      const ready = buf.push(env);
      for (const e of ready) { clock.observeLamport(e.lamport); clock.mergeVC(e.clock); doc.apply(e); history.set(e.id, e); }
      return ready;
    }
  };
}

/** 用真实“录制→物化”过程造一条时间轴：返回 recorder 与各信封 */
function buildTimeline(A, B, clockNow) {
  const rec = new R.Recorder({ clockNow });
  const feed = (env, origin) => rec.record(env, { origin });
  const e1 = A.issue({ kind: 'create', objects: [{ oid: 'a', type: 'rect', fields: { x: 0, y: 0, w: 10, h: 10, color: '#000', z: '1' } }] });
  feed(e1, 'local');
  const e2 = A.issue({ kind: 'create', objects: [{ oid: 'b', type: 'ellipse', fields: { x: 5, y: 5, w: 20, h: 20, z: '2' } }] });
  feed(e2, 'local');
  // B 先收到 a/b，再移动 a
  B.receive(e1); B.receive(e2);
  const e3 = B.issue({ kind: 'set', oid: 'a', fields: { x: 30 }, prev: { x: 0 } });
  feed(e3, 'remote');
  A.receive(e3);
  const e4 = A.issue({ kind: 'delete', oids: ['b'] });
  feed(e4, 'local');
  B.receive(e4);
  return { rec, envs: { e1, e2, e3, e4 } };
}

async function run() {
  console.log('\n[1] Recorder：记录操作日志，生成可回放时间轴');
  {
    let t = 1000;
    const { rec, envs } = buildTimeline(node('A'), node('B'), () => t);
    assert(rec.entries.length === 4, `recorder captured 4 materialized envelopes (got ${rec.entries.length})`);
    assert(rec.entries[0].origin === 'local' && rec.entries[2].origin === 'remote',
      'entries tagged local/remote by origin');
    assert(rec.entries.every((e) => Number.isFinite(e.t) && e.kind), 'entries carry relative t and op kind');
    assert(rec.entries.map((e) => e.idx).join(',') === '0,1,2,3', 'idx strictly increasing');

    console.log('\n[2] ACK 回填权威 seq（逐条 seqs 与推导两种方式）');
    t = 2000;
    rec.resolveAck([envs.e1.id, envs.e2.id], 10, [9, 10]);
    assert(rec.entries[0].seq === 9 && rec.entries[1].seq === 10, 'explicit seqs aligned to ids');
    rec.resolveAck([envs.e4.id], 12); // 无 seqs：窗口推导，11 是 B 的远端操作
    assert(rec.entries[3].seq === 12, `inferred seq for acked local op (got ${rec.entries[3].seq})`);
    const tl = rec.timeline();
    assert(tl.startSeq === 0 && tl.endSeq === 12 && tl.count === 4, 'timeline exports startSeq/endSeq/count');
    assert(R.Recorder.validateTimeline(tl) === null, 'timeline validates');
    assert(R.Recorder.validateTimeline(null) !== null, 'invalid timeline rejected');

    console.log('\n[3] 基线快照折叠（prune）：只保留水位之后的记录');
    // 为条目补齐权威 seq：e1=9,e2=10（本地），e3=11（B 的远端操作），e4=12（本地）
    rec.entries[0].seq = 9; rec.entries[1].seq = 10; rec.entries[2].seq = 11;
    // A 当前 doc 物化了前 3 个信封；拍一个 seq=10 的快照作为新基线
    const snapNode = node('A2');
    snapNode.receive(envs.e1); snapNode.receive(envs.e2); snapNode.receive(envs.e3);
    const snap = snapNode.doc.snapshot({ A: 2, B: 1 });
    rec.setBaseline(snap, 10, { prune: true });
    assert(rec.entries.length === 2,
      `prune folded local entries with seq<=10, kept later seq=11/12 (got ${rec.entries.length})`);
    assert(rec.entries.every((e) => e.seq > 10), 'all kept entries have seq > watermark');
    assert(rec.entries.map((e) => e.idx).join(',') === '0,1', 'idx re-packed after prune');
    const tl2 = rec.timeline();
    assert(!!tl2.baseline && tl2.startSeq === 10, 'timeline carries baseline + startSeq');
  }

  console.log('\n[4] Player：播放/暂停/倍速/拖拽/跳 seq，视图与真实物化一致');
  {
    let t = 1000;
    const A = node('A'), B = node('B');
    const { rec, envs } = buildTimeline(A, B, () => t);
    // 给条目分配不同时间戳以检验播放节奏：重置时间并重录
    rec.reset();
    const stamps = [0, 200, 500, 900];
    let k = 0;
    for (const [env, origin] of [[envs.e1, 'local'], [envs.e2, 'local'], [envs.e3, 'remote'], [envs.e4, 'local']]) {
      const e = rec.record(env, { origin, seq: 8 + k });
      e.t = stamps[k++];
    }
    const vt = virtualTimers();
    const p = new R.Player(rec.timeline(), { now: vt.now, scheduleFrame: vt.schedule.bind(vt), cancelFrame: vt.cancel.bind(vt) });
    assert(p.currentSeq === 0 && p.currentIndex === -1, 'player starts before first entry');
    assert(p.view.liveObjects().length === 0, 'empty view at start (no baseline)');

    // 播放到 300ms 虚拟时间：应已物化 e1(0)/e2(200)，未到 e3(500)
    p.play();
    vt.frame(300);
    assert(p.playing, 'still playing mid-timeline');
    assert(p.currentIndex === 1, `applied entries up to t=300 (idx=${p.currentIndex})`);
    assert(p.view.liveObjects().length === 2, 'view shows 2 live objects at t=300');

    // 暂停
    p.pause();
    assert(!p.playing && p.state === 'paused', 'pause() stops playback');
    const scheduledAfterPause = vt.schedule(() => {});
    vt.cancel(scheduledAfterPause);
    vt.frame(1000);
    assert(p.currentIndex === 1, 'paused player does not advance with wall clock');

    // 倍速 2x：推进 100ms 实际 = 200ms 虚拟 → 到达 t=500（e3 物化）
    p.setRate(2);
    assert(p.rate === 2, 'rate set to 2x');
    p.play();
    vt.frame(100);
    assert(p.currentIndex === 2, `2x speed: 100ms wall covered 200ms timeline (idx=${p.currentIndex})`);
    assert(p.view.get('a').x === 30, 'view materialized B\'s set x=30');
    p.pause();

    // 拖拽进度（seekTime 到 900）：e4 物化，b 被删
    p.seekTime(900);
    assert(p.currentIndex === 3 && p.view.liveObjects().length === 1,
      'seekTime(900) rebuilds view: only object a remains (b deleted)');

    // 向前拖到 0：视图回到仅初始状态（吸附到 t<=0 的最后一条 = 第一条）
    p.seekTime(0);
    assert(p.currentIndex === 0 && p.view.liveObjects().length === 1 && p.view.get('a').x === 0,
      'seekTime(0) rebuilds back to first entry');

    // 跳到指定 seq
    p.seekSeq(10);
    assert(p.currentIndex === 2, 'seekSeq(10) lands on last entry with seq<=10');
    p.seekSeq(8);
    assert(p.currentIndex === 0, 'seekSeq(8) lands on first entry');
    assert(p.currentSeq === 8, `currentSeq reports 8 (got ${p.currentSeq})`);
    p.seekSeq(99);
    assert(p.currentIndex === 3, 'seekSeq beyond end lands at last entry');

    // 单步
    p.seekIndex(-1);
    p.stepForward();
    assert(p.currentIndex === 0, 'stepForward applies one entry');
    p.stepBack();
    assert(p.currentIndex === -1, 'stepBack removes one entry');

    // 播放到结尾：ended 事件
    const ends = [];
    p.on('end', () => ends.push(1));
    p.play();
    for (let i = 0; i < 50 && p.playing; i++) vt.frame(50);
    assert(!p.playing && p.state === 'ended' && ends.length === 1, 'playback reaches end and emits end/ended');
    assert(p.view.liveObjects().length === 1, 'final view equals real doc state');

    // 视图与直接按序物化的独立 Doc 完全一致
    const verify = new WB.Doc();
    for (const env of [envs.e1, envs.e2, envs.e3, envs.e4]) verify.apply(env);
    eq(p.view.snapshot().objects.map((o) => o.oid).sort(),
       verify.snapshot().objects.map((o) => o.oid).sort(),
       'final replay view matches direct materialization');
  }

  console.log('\n[5] 倍速档位循环 + 大倍速快速播完');
  {
    const A = node('A');
    const rec = new R.Recorder({ clockNow: () => 0 });
    const e = A.issue({ kind: 'create', objects: [{ oid: 'z', type: 'rect', fields: { x: 1 } }] });
    const en = rec.record(e, { origin: 'local', seq: 1 }); en.t = 0;
    const vt = virtualTimers();
    const p = new R.Player(rec.timeline(), { now: vt.now, scheduleFrame: vt.schedule.bind(vt), cancelFrame: vt.cancel.bind(vt) });
    const rates = [];
    for (let i = 0; i < 5; i++) rates.push(p.setRate());
    eq(rates, [2, 4, 8, 0.5, 1], 'setRate() cycles forward from current 1x: 2→4→8→0.5→1');
    p.setRate(8);
    p.play();
    vt.frame(1);
    assert(p.state === 'ended' && p.view.get('z').x === 1, '8x playback finishes entry at t=0 immediately');
  }

  console.log('\n[6] 回放只读隔离：回放期间实时协作文档继续接收，互不影响');
  {
    const A = node('A'), B = node('B');
    const rec = new R.Recorder({ clockNow: () => 0 });
    const e1 = A.issue({ kind: 'create', objects: [{ oid: 's1', type: 'rect', fields: { x: 1, y: 1, w: 5, h: 5 } }] });
    const r1 = rec.record(e1, { origin: 'local', seq: 1 }); r1.t = 0;

    const vt = virtualTimers();
    const p = new R.Player(rec.timeline(), { now: vt.now, scheduleFrame: vt.schedule.bind(vt), cancelFrame: vt.cancel.bind(vt) });
    p.play(); vt.frame(0);
    assert(p.state === 'ended' && p.view.get('s1'), 'replay view shows recorded object');

    // 实时世界继续：B 新建对象并删除 s1，A 收到
    B.receive(e1);
    const liveCreate = B.issue({ kind: 'create', objects: [{ oid: 's2', type: 'rect', fields: { x: 9, y: 9, w: 1, h: 1 } }] });
    const liveDelete = B.issue({ kind: 'delete', oids: ['s1'] });
    A.receive(liveCreate); A.receive(liveDelete);

    assert(!p.view.get('s2'), 'replay view does not see live concurrent ops (isolated)');
    assert(p.view.get('s1') && p.view.get('s1').deleted !== true, 'replay view stays at recorded moment (s1 alive)');
    assert(A.doc.get('s2') && A.doc.get('s1').deleted === true, 'live doc advanced (s2 created, s1 deleted)');

    // 录制器继续记录实时操作（录制不中断）
    rec.record(liveCreate, { origin: 'remote', seq: 2 });
    assert(rec.entries.length === 2, 'recorder kept recording live ops during replay');

    p.dispose();
    assert(p.view === null, 'dispose releases view');
  }

  console.log('\n[7] 带基线的时间轴回放（晚加入者场景）');
  {
    const A = node('A');
    const e1 = A.issue({ kind: 'create', objects: [{ oid: 'base1', type: 'rect', fields: { x: 0, z: '1' } }] });
    const e2 = A.issue({ kind: 'create', objects: [{ oid: 'base2', type: 'rect', fields: { x: 1, z: '2' } }] });
    const rec = new R.Recorder({ clockNow: () => 0 });
    const base = new WB.Doc(); base.apply(e1); base.apply(e2);
    rec.setBaseline(base.snapshot({ A: 2 }), 2);
    const e3 = A.issue({ kind: 'delete', oids: ['base1'] });
    const r3 = rec.record(e3, { origin: 'remote', seq: 3 }); r3.t = 100;

    const vt = virtualTimers();
    const p = new R.Player(rec.timeline(), { now: vt.now, scheduleFrame: vt.schedule.bind(vt), cancelFrame: vt.cancel.bind(vt) });
    assert(p.view.liveObjects().length === 2, 'baseline applied at playback start');
    assert(p.currentSeq === 2, 'baseline seq reported before playing deltas');
    p.seekTime(100);
    assert(p.view.liveObjects().length === 1 && p.view.get('base2'),
      'baseline + delta replay: base1 deleted, base2 alive');
  }

  console.log('\n[7b] 版本范围回放：从 startSeq 起播，到 endSeq 自动停');  {
    const A = node('A');
    const rec = new R.Recorder({ clockNow: () => 0 });
    const envs = [];
    for (let i = 0; i < 5; i++) {
      const e = A.issue({ kind: 'create', objects: [{ oid: 'o' + i, type: 'rect',
        fields: { x: i, z: '0.' + (100 + i) } }] });
      envs.push(e);
      const r = rec.record(e, { origin: 'local', seq: 10 + i });
      r.t = i * 100;
    }
    const vt = virtualTimers();
    const p = new R.Player(rec.timeline(), { now: vt.now, scheduleFrame: vt.schedule.bind(vt), cancelFrame: vt.cancel.bind(vt) });
    p.seekVersionRange(12, 13);
    assert(p.currentSeq === 11, 'range playback starts just before startSeq');
    p.play();
    for (let i = 0; i < 10 && p.playing; i++) vt.frame(50);
    assert(p.state === 'ended' && p.currentSeq === 13,
      `version range playback stops at endSeq=13 (seq=${p.currentSeq})`);
    assert(p.view.get('o3') && !p.view.get('o4'), 'only entries within range materialized');
  }

  console.log('\n[7c] 录制起点到首个事件的等待时间被归一化（回放立即开始，不等待空窗）');
  {
    const A = node('A');
    let clock = 5000;                        // 加入房间 5 秒后才产生第一条操作
    const rec = new R.Recorder({ clockNow: () => clock });
    const e1 = A.issue({ kind: 'create', objects: [{ oid: 'w1', type: 'rect', fields: { x: 1 } }] });
    const r1 = rec.record(e1, { origin: 'local', seq: 1 }); r1.t = 5000;
    clock = 5300;
    const e2 = A.issue({ kind: 'create', objects: [{ oid: 'w2', type: 'rect', fields: { x: 2 } }] });
    const r2 = rec.record(e2, { origin: 'local', seq: 2 }); r2.t = 5300;

    const vt = virtualTimers();
    const p = new R.Player(rec.timeline(), { now: vt.now, scheduleFrame: vt.schedule.bind(vt), cancelFrame: vt.cancel.bind(vt) });
    assert(p.duration === 300, `timeline normalized to 300ms (got ${p.duration})`);
    p.play();
    vt.frame(0);                             // 第一帧即应物化首条（无需等 5 秒空窗）
    assert(p.currentIndex === 0 && p.view.get('w1'), 'first event plays immediately (no join-to-first-op wait)');
    vt.frame(301);
    assert(p.state === 'ended' && p.view.get('w2'), 'full 300ms timeline completes in 301ms virtual time');
  }

  console.log('\n[8] VersionStore：保存 / 命名 / 列表 / 删除 / 持久化');  {
    const A = node('A');
    A.issue({ kind: 'create', objects: [{ oid: 'v1', type: 'rect', fields: { x: 1 } }] });
    const mem = new Map();
    const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
    const vs = new R.VersionStore({ storage, prefix: 'test.vers' });
    const va = vs.save(A.doc, { name: '初稿', seq: 1, knownVC: { A: 1 } });
    A.issue({ kind: 'set', oid: 'v1', fields: { x: 2 } });
    const vb = vs.save(A.doc, { seq: 2, knownVC: { A: 2 } });
    assert(/v2/.test(vb.name), 'default name auto-numbered');
    assert(vs.list().map((v) => v.id).join(',') === `${va.id},${vb.id}`, 'list ordered by creation');

    vs.rename(va.id, '  定稿  ');
    assert(vs.get(va.id).name === '定稿', 'rename trims and stores name');
    assert(vs.rename('nope', 'x') === null, 'rename missing version returns null');

    // 重新加载：持久化生效
    const vs2 = new R.VersionStore({ storage, prefix: 'test.vers' });
    assert(vs2.count === 2 && vs2.get(va.id).name === '定稿', 'versions persisted across store reload');
    assert(vs2.remove(va.id) && vs2.count === 1, 'remove version');
    const vs3 = new R.VersionStore({ storage, prefix: 'test.vers' });
    assert(vs3.count === 1, 'removal persisted');
  }

  console.log('\n[9] restoreEnvelopes：恢复版本 → 删除新增/恢复被删/字段纠偏/擦除恢复');
  {
    // 版本 V1：rect r 位于 x=10；笔迹 st 无擦除
    const N1 = node('N1');
    const createR = N1.issue({ kind: 'create', objects: [{ oid: 'r', type: 'rect',
      fields: { x: 10, y: 0, w: 10, h: 10, color: '#111', z: '1' } }] });
    const createSt = N1.issue({ kind: 'create', objects: [{ oid: 'st', type: 'stroke',
      fields: { stroke: { points: [{ x: 0, y: 0, w: 4 }, { x: 40, y: 0, w: 4 }], cellSize: 4, width: 4 }, color: '#000', z: '2' } }] });
    const vs = new R.VersionStore();
    const ver = vs.save(N1.doc, { name: 'V1', seq: 2, knownVC: { N1: 2 } });

    // 当前实时状态在版本之后继续演化（另一个节点模拟）：
    //  - r 被移动到 x=99（字段偏差）；
    //  - 新建了 extra（版本里没有）；
    //  - st 被像素擦擦了若干单元；
    const live = node('live');
    live.receive(createR); live.receive(createSt);
    const moveR = live.issue({ kind: 'set', oid: 'r', fields: { x: 99 }, prev: { x: 10 } });
    const createExtra = live.issue({ kind: 'create', objects: [{ oid: 'extra', type: 'ellipse',
      fields: { x: 0, y: 0, w: 3, h: 3, z: '3' } }] });
    const cells = WB.rasterizeErase([{ x: 0, y: 0 }, { x: 20, y: 0 }], 4);
    const erase = live.issue({ kind: 'erase', chunks: cells.chunks.map((ch) => Object.assign({ oid: 'st' }, ch)) });
    assert(live.doc.erasedCells('st').size > 0, 'fixture: stroke has erased cells');

    // 生成恢复信封并提交到实时节点
    const restorer = new WB.Clock('live');
    restorer.lamport = live.clock.lamport; restorer.local = live.clock.local;
    Object.assign(restorer.vc, live.clock.vc);
    const envs = R.restoreEnvelopes(restorer, live.doc, ver.snapshot);
    assert(envs.length >= 3, `restore produces delete+set+erase envelopes (got ${envs.length})`);
    const kinds = envs.map((e) => e.op.kind).sort();
    assert(kinds.includes('set') && kinds.includes('delete') && kinds.includes('erase'),
      `restore covers set/delete/erase (${kinds.join(',')})`);
    // 删除目标必须含 extra，set 目标必须是 r
    assert(!!envs.find((e) => e.op.kind === 'delete' && e.op.oids.includes('extra')), 'newer object extra deleted');
    const setEnv = envs.find((e) => e.op.kind === 'set' && e.op.oid === 'r');
    assert(setEnv && setEnv.op.fields.x === 10, 'field drifted back to version x=10');

    for (const e of envs) live.receive(e);

    // 收敛结果与版本一致
    assert(live.doc.get('extra').deleted === true, 'extra deleted after restore');
    assert(live.doc.get('r').x === 10, 'r back at x=10');
    assert(live.doc.erasedCells('st').size === 0, 'erased stroke cells restored (unerase)');
    const v1Live = new WB.Doc(); v1Live.apply(createR); v1Live.apply(createSt);
    const sig = (d) => d.liveObjects().map((o) => `${o.oid}:${o.x || ''}`).sort().join('|');
    assert(sig(live.doc) === sig(v1Live), 'live doc converges to version object set');

    // 其他协作者收到同一批恢复信封后也收敛（因果广播）
    const other = node('other');
    for (const e of [createR, createSt, moveR, createExtra, erase, ...envs]) other.receive(e);
    assert(sig(other.doc) === sig(v1Live), 'another replica converges to version too');
    assert(other.doc.erasedCells('st').size === 0, 'peer stroke cells also restored');
  }

  console.log('\n[10] restoreEnvelopes：版本中被删除的对象被恢复（restore + 字段纠偏）');
  {
    const N = node('Nx');
    N.issue({ kind: 'create', objects: [{ oid: 'd', type: 'rect', fields: { x: 7, y: 7, w: 4, h: 4, z: '1' } }] });
    const vs = new R.VersionStore();
    const ver = vs.save(N.doc, { seq: 1, knownVC: { Nx: 1 } });

    const live = node('live2');
    const create = N.history.get('Nx:1');
    live.receive(create);
    live.issue({ kind: 'delete', oids: ['d'] });
    live.issue({ kind: 'create', objects: [{ oid: 'n', type: 'rect', fields: { x: 1, z: '2' } }] });
    assert(live.doc.get('d').deleted === true, 'fixture: d deleted in live');

    const clk = new WB.Clock('live2');
    clk.lamport = live.clock.lamport; clk.local = live.clock.local; Object.assign(clk.vc, live.clock.vc);
    const envs = R.restoreEnvelopes(clk, live.doc, ver.snapshot);
    assert(!!envs.find((e) => e.op.kind === 'restore' && e.op.oids.includes('d')),
      'restore envelope revives d');
    assert(!!envs.find((e) => e.op.kind === 'delete' && e.op.oids.includes('n')),
      'post-version object n deleted');
    for (const e of envs) live.receive(e);
    assert(live.doc.get('d').deleted !== true && live.doc.get('d').x === 7, 'd alive again at x=7');
    assert(live.doc.get('n').deleted === true, 'n removed (tombstoned)');
  }

  console.log('\n[11] restoreEnvelopes：无差异时不产生信封；组关系恢复');
  {
    const N = node('Ng');
    const c1 = N.issue({ kind: 'create', objects: [{ oid: 'g1', type: 'rect', fields: { x: 1, z: '1' } }] });
    const c2 = N.issue({ kind: 'create', objects: [{ oid: 'g2', type: 'rect', fields: { x: 2, z: '2' } }] });
    const g = N.issue({ kind: 'group', gid: 'grp-1', oids: ['g1', 'g2'] });
    const vs = new R.VersionStore();
    const ver = vs.save(N.doc, { seq: 3, knownVC: { Ng: 3 } });
    const envs0 = R.restoreEnvelopes(new WB.Clock('c'), N.doc, ver.snapshot);
    assert(envs0.length === 0, 'no envelopes when already at version');

    // 当前状态解组 → 恢复时应重新 group
    const live = node('lg');
    for (const e of [c1, c2, g]) live.receive(e);
    live.issue({ kind: 'ungroup', gid: 'grp-1', oids: ['g1', 'g2'] });
    const envs1 = R.restoreEnvelopes(live.clock, live.doc, ver.snapshot);
    assert(!!envs1.find((e) => e.op.kind === 'group' && e.op.gid === 'grp-1'),
      'ungrouped objects re-grouped on restore');
    for (const e of envs1) live.receive(e);
    assert(live.doc.get('g1').group === 'grp-1' && live.doc.get('g2').group === 'grp-1',
      'group membership restored');
  }

  console.log(`\n========================================`);
  console.log(`REPLAY RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => { console.error('REPLAY CRASHED:', err); process.exit(1); });
