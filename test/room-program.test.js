'use strict';

// 共享房间「循环排演编排」HTTP 单元测试：
// 1～8 段循环排演的提交校验（非负起止、起点<终点、不超版本末尾、正整数重复）、
// 密钥与修订号鉴权（无权/过期不改房间）、提交成功从首段开始并递增修订号、
// 服务端墙钟按倍速穿过各段（段尾回环/跳入下段、全部完成停在末段终点）、
// 查询返回当前段/轮次/时码/状态、暂停与改速保留进度、手动跳转取消编排、
// 完成后再播放从首段重新开始、启用保护时超载段起点整次拒绝且运行中抵边界自动暂停不越界、
// 主持权交接后新主持人可继续控制编排、观看者只读且不见密钥、重启后编排进度一致。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-program-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');

let server;

function request(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => server.close(r));
});

async function resetDraft() {
  const cues = await getJson('/api/cues');
  for (const c of cues) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await getJson('/api/lights');
  for (const l of lights) await request('DELETE', `/api/lights/${l.id}`);
  const circuits = await getJson('/api/circuits');
  for (const c of circuits) await request('DELETE', `/api/circuits/${c.id}`);
}

// 普通版本：灯 L 从 t=0 用 10 秒渐变到 100（版本末尾 10）
async function seedVersion(label = '编排版') {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: `编排灯${label}` })).json.id;
  await request('POST', '/api/cues', [
    { cue_no: 9001, light_id: l, time: 0, target: 100, duration: 10 },
  ]);
  return { version: (await request('POST', '/api/versions', { label })).json, light: l };
}

// 带超载保护的短版本（同 room-overload-protection 用例口径）：
// 超载区间 [0.3, 1)（左闭右开），版本末尾 1。
async function seedProtectedVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '编排超载回路', capacity: 100 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '编排大灯' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('POST', '/api/cues', [
    { cue_no: 9201, light_id: l1, time: 0, target: 50, duration: 0 },
    { cue_no: 9202, light_id: l1, time: 0.3, target: 100, duration: 0 },
    { cue_no: 9203, light_id: l1, time: 1, target: 0, duration: 0 },
  ]);
  return {
    version: (await request('POST', '/api/versions', { label: '编排保护版' })).json,
    circuit: c1,
  };
}

async function makeRoom(versionId, extra = {}) {
  const r = await request('POST', '/api/rooms', { version_id: versionId, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const codeOf = (c) => c.code;
const submit = (c, body) =>
  request('POST', `/api/rooms/${codeOf(c)}/program`, { control_key: c.control_key, ...body });
const ctrl = (c, body) =>
  request('POST', `/api/rooms/${codeOf(c)}/control`, { control_key: c.control_key, ...body });
const stateOf = (c) => request('GET', `/api/rooms/${codeOf(c)}`);

/* --------------------------------- 校验与鉴权 --------------------------------- */

test('编排提交：观看者无密钥/错误密钥 → 403 且不改房间', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);

  let r = await request('POST', `/api/rooms/${c.code}/program`, {
    revision: 0,
    segments: [{ start: 2, end: 4, repeat: 1 }],
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await submit(c, {
    control_key: 'deadbeef'.repeat(6),
    revision: 0,
    segments: [{ start: 2, end: 4, repeat: 1 }],
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  const g = await stateOf(c);
  assert.equal(g.json.revision, 0);
  assert.equal(g.json.program, undefined);
});

test('编排提交：修订号缺失/非法 400；过期 409 且不改房间', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);

  let r = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    segments: [{ start: 2, end: 4, repeat: 1 }],
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await submit(c, { revision: -1, segments: [{ start: 2, end: 4, repeat: 1 }] });
  assert.equal(r.status, 400);

  await submit(c, { revision: 0, segments: [{ start: 2, end: 4, repeat: 1 }] });
  r = await submit(c, { revision: 0, segments: [{ start: 0, end: 1, repeat: 1 }] });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  const g = await stateOf(c);
  assert.equal(g.json.revision, 1); // 仍是第一次成功提交后的修订号
  assert.equal(g.json.program.segments[0].start, 2);
});

test('编排提交：非法段（空/非数组/段数/起止/重复）→ 400 且整次拒绝、不改房间', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);

  const badBodies = [
    [{ revision: 0 }, /segments 数组/],
    [{ revision: 0, segments: {} }, /segments 数组/],
    [{ revision: 0, segments: [] }, /段数无效/],
    [{ revision: 0, segments: Array(9).fill({ start: 0, end: 1, repeat: 1 }) }, /段数无效/],
    [{ revision: 0, segments: [{ start: 'x', end: 4, repeat: 1 }] }, /起点时码无效/],
    [{ revision: 0, segments: [{ start: -1, end: 4, repeat: 1 }] }, /不得为负/],
    [{ revision: 0, segments: [{ start: 4, end: 4, repeat: 1 }] }, /起点.*须早于终点/],
    [{ revision: 0, segments: [{ start: 5, end: 4, repeat: 1 }] }, /起点.*须早于终点/],
    [{ revision: 0, segments: [{ start: 0, end: 10.5, repeat: 1 }] }, /超过房间固定版本末尾/],
    [{ revision: 0, segments: [{ start: 0, end: 4, repeat: 0 }] }, /重复次数无效/],
    [{ revision: 0, segments: [{ start: 0, end: 4, repeat: 1.5 }] }, /重复次数无效/],
    [{ revision: 0, segments: [{ start: 0, end: 4, repeat: -2 }] }, /重复次数无效/],
    [{ revision: 0, segments: [{ start: 0, end: 4 }] }, /重复次数无效/],
  ];
  for (const [body, re] of badBodies) {
    const r = await submit(c, body);
    assert.equal(r.status, 400, `body=${JSON.stringify(body)} got=${r.status}`);
    assert.match(r.json.error, re, `body=${JSON.stringify(body)} msg=${r.json.error}`);
  }

  // 批量中任一段非法 → 整次拒绝（房间未编排）
  let r = await submit(c, {
    revision: 0,
    segments: [
      { start: 0, end: 2, repeat: 1 },
      { start: 3, end: 3, repeat: 1 },
    ],
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /第 2 段/);
  const g = await stateOf(c);
  assert.equal(g.json.program, undefined);
  assert.equal(g.json.revision, 0);
});

test('编排提交成功：从首段起点开始播放、修订号 +1、返回段/轮次/时码与状态；查询不回显密钥', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);

  const r = await submit(c, {
    revision: 0,
    segments: [
      { start: 2, end: 4, repeat: 3 },
      { start: 6, end: 8, repeat: 1 },
    ],
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.playing, true);
  assert.ok(Math.abs(r.json.time - 2) < 1e-6);
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.control_key, undefined);

  const p = r.json.program;
  assert.equal(p.status, 'playing');
  assert.equal(p.segment, 1);
  assert.equal(p.round, 1);
  assert.equal(p.rounds_total, 3);
  assert.equal(p.segment_count, 2);
  assert.ok(Math.abs(p.time - 2) < 1e-6);
  assert.ok(Math.abs(p.elapsed) < 1e-6);
  assert.ok(Math.abs(p.total_elapsed - 8) < 1e-6); // 2*3 + 2*1
  assert.equal(p.segments[1].start, 6);

  const g = await stateOf(c);
  assert.equal(g.json.control_key, undefined);
  assert.equal(g.json.program.segment_count, 2);
});

/* --------------------------------- 播放路径 --------------------------------- */

test('播放按墙钟与倍速穿过各段：段尾回环、跳入下段；全部完成停在末段终点且不加修订号', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  // 单段 [2,4] ×2：虚拟总时长 4；播放中 t 从 2 走到 4（2 秒），跳回 2 再走到 4
  await submit(c, { revision: 0, segments: [{ start: 2, end: 4, repeat: 2 }] });

  await sleep(600);
  let g = await stateOf(c);
  assert.equal(g.json.playing, true);
  let p = g.json.program;
  assert.equal(p.segment, 1);
  assert.equal(p.round, 1);
  assert.ok(g.json.time > 2.4 && g.json.time < 3.0, `time=${g.json.time}`);

  await sleep(2000); // 总计约 2.6s：已在第二轮（回环跳回 2）
  g = await stateOf(c);
  p = g.json.program;
  assert.equal(g.json.playing, true);
  assert.equal(p.round, 2, `应在第二轮，time=${g.json.time} e=${p.elapsed}`);
  assert.ok(g.json.time >= 2 - 1e-6 && g.json.time < 4, `time=${g.json.time}`);

  await sleep(2000); // 越过总时长 4：完成，停在末段终点 4
  g = await stateOf(c);
  p = g.json.program;
  assert.equal(g.json.playing, false);
  assert.equal(p.status, 'finished');
  assert.ok(Math.abs(g.json.time - 4) < 1e-6, `time=${g.json.time}`);
  assert.ok(Math.abs(p.elapsed - 4) < 1e-6);
  assert.equal(g.json.revision, 1, '自动完成不增加修订号');

  // 已落库：再查仍停在末段终点
  const g2 = await stateOf(c);
  assert.equal(g2.json.playing, false);
  assert.ok(Math.abs(g2.json.time - 4) < 1e-6);
  assert.equal(g2.json.program.status, 'finished');
});

test('多段：段尾跳入下段起点；末段完成停在末段终点', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  // 段1 [2,4]×1（2s），段2 [6,9]×1（3s），总 5s
  await submit(c, {
    revision: 0,
    segments: [
      { start: 2, end: 4, repeat: 1 },
      { start: 6, end: 9, repeat: 1 },
    ],
  });

  await sleep(2300); // 已跳入段 2（6 起）
  let g = await stateOf(c);
  assert.equal(g.json.playing, true);
  assert.equal(g.json.program.segment, 2);
  assert.equal(g.json.program.round, 1);
  assert.ok(g.json.time > 6 && g.json.time < 6.8, `time=${g.json.time}`);

  await sleep(3000); // 完成，停在 9
  g = await stateOf(c);
  assert.equal(g.json.playing, false);
  assert.equal(g.json.program.status, 'finished');
  assert.ok(Math.abs(g.json.time - 9) < 1e-6);
});

test('暂停保留编排进度，继续从断点接续；改速保留进度并按新倍速走', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  await submit(c, { revision: 0, segments: [{ start: 2, end: 6, repeat: 2 }] }); // 总长 8

  await sleep(500);
  let r = await ctrl(c, { revision: 1, action: 'pause' });
  assert.equal(r.status, 200);
  const pausedTime = r.json.time;
  const pausedE = r.json.program.elapsed;
  assert.ok(pausedTime > 2.3 && pausedTime < 2.8);
  assert.equal(r.json.program.status, 'paused');

  await sleep(400);
  let g = await stateOf(c);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - pausedTime) < 1e-6);
  assert.ok(Math.abs(g.json.program.elapsed - pausedE) < 1e-6);

  // 2 倍速：暂停态改速，时码/编排坐标不变
  r = await ctrl(c, { revision: 2, action: 'speed', speed: 2 });
  assert.equal(r.json.speed, 2);
  assert.ok(Math.abs(r.json.time - pausedTime) < 1e-6);
  assert.ok(Math.abs(r.json.program.elapsed - pausedE) < 1e-6);

  r = await ctrl(c, { revision: 3, action: 'play' });
  assert.equal(r.json.playing, true);
  const w = r.json.server_wall;
  await sleep(300);
  g = await stateOf(c);
  // 2 倍速推进 0.3s 墙钟 ≈ 0.6 编排秒（仍在第一轮，段长 4）
  const expE = pausedE + (g.json.server_wall - w) * 2;
  assert.ok(Math.abs(g.json.program.elapsed - expE) < 0.08,
    `e=${g.json.program.elapsed} exp=${expE}`);
});

test('手动跳转取消编排并沿用原房间控制语义（播放/暂停状态保留）', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  await submit(c, { revision: 0, segments: [{ start: 2, end: 4, repeat: 3 }] });

  // 播放中跳转到 7：取消编排，按普通房间播放继续
  let r = await ctrl(c, { revision: 1, action: 'seek', time: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.ok(Math.abs(r.json.time - 7) < 1e-6);
  assert.equal(r.json.program, undefined, '跳转取消编排');

  await sleep(200);
  let g = await stateOf(c);
  assert.equal(g.json.playing, true);
  assert.ok(g.json.time > 7, '普通播放继续推进');
  assert.equal(g.json.program, undefined);

  // 暂停后再跳也保持无编排
  await ctrl(c, { revision: 2, action: 'pause' });
  r = await ctrl(c, { revision: 3, action: 'seek', time: 1 });
  assert.equal(r.json.playing, false);
  assert.ok(Math.abs(r.json.time - 1) < 1e-6);
  assert.equal(r.json.program, undefined);
});

test('编排完成停在末段终点后再按播放：从首段重新开始整次编排', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  // 短编排 [2,2.3]×1（0.3s 完成）
  await submit(c, { revision: 0, segments: [{ start: 2, end: 2.3, repeat: 1 }] });
  await sleep(600);
  let g = await stateOf(c);
  assert.equal(g.json.program.status, 'finished');
  assert.ok(Math.abs(g.json.time - 2.3) < 1e-6);

  // play（当前修订号 1）：重新从首段起点 2 开始编排
  const r = await ctrl(c, { revision: 1, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  assert.ok(Math.abs(r.json.time - 2) < 1e-6);
  assert.equal(r.json.program.status, 'playing');
  assert.equal(r.json.program.segment, 1);
  assert.equal(r.json.program.round, 1);
  assert.ok(Math.abs(r.json.program.elapsed) < 1e-6);
});

test('重新提交编排：替换当前编排，从新首段起点开始（修订号继续递增）', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  await submit(c, { revision: 0, segments: [{ start: 2, end: 6, repeat: 2 }] });
  await ctrl(c, { revision: 1, action: 'pause' });

  const r = await submit(c, {
    revision: 2,
    segments: [{ start: 8, end: 9, repeat: 1 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.playing, true);
  assert.ok(Math.abs(r.json.time - 8) < 1e-6);
  assert.equal(r.json.revision, 3);
  assert.equal(r.json.program.segment_count, 1);
  assert.ok(Math.abs(r.json.program.total_elapsed - 1) < 1e-6);
});

/* ----------------------------- 回路超载保护联动 ----------------------------- */

test('启用保护：超载的段起点使整次编排被拒绝（房间不变），安全起点可提交', async () => {
  const { version, circuit } = await seedProtectedVersion();
  const c = await makeRoom(version.id, { overload_protection: true });

  // 段起点 0.5 位于严格超载区间 [0.3,1)：整次拒绝
  let r = await submit(c, { revision: 0, segments: [{ start: 0.5, end: 0.8, repeat: 2 }] });
  assert.equal(r.status, 400);
  assert.equal(r.json.reason, 'overloaded_program_start');
  assert.equal(r.json.segment, 1);
  assert.ok(Math.abs(r.json.time - 0.5) < 1e-6);
  assert.equal(r.json.circuits[0].circuit_id, circuit);
  assert.match(r.json.error, /整次编排被拒绝/);
  const g = await stateOf(c);
  assert.equal(g.json.revision, 0);
  assert.equal(g.json.program, undefined);

  // 起点安全（0），段全程在 [0,0.2]：可提交并正常完成
  r = await submit(c, { revision: 0, segments: [{ start: 0, end: 0.2, repeat: 2 }] });
  assert.equal(r.status, 201);
  await sleep(700);
  const g2 = await stateOf(c);
  assert.equal(g2.json.program.status, 'finished');
  assert.ok(Math.abs(g2.json.time - 0.2) < 1e-6);
  assert.equal(g2.json.protection.tripped, undefined);
});

test('运行途中抵达超载边界自动暂停：停在边界、不越过危险段、不加修订号、编排身份保留', async () => {
  const { version, circuit } = await seedProtectedVersion();
  const c = await makeRoom(version.id, { overload_protection: true });
  // 段 [0,0.8]×3：第一轮 0.3 处撞上闭端点超载边界
  await submit(c, { revision: 0, segments: [{ start: 0, end: 0.8, repeat: 3 }] });

  await sleep(1000); // 远超 0.3s
  const g = await stateOf(c);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `time=${g.json.time}`);
  assert.equal(g.json.revision, 1, '自动暂停不加修订号');
  assert.equal(g.json.program.segment, 1);
  assert.equal(g.json.program.round, 1);
  assert.ok(Math.abs(g.json.program.elapsed - 0.3) < 1e-6);
  assert.equal(g.json.protection.tripped.time, 0.3);
  assert.equal(g.json.protection.tripped.circuit.circuit_id, circuit);

  // 已落库：再查一致
  const g2 = await stateOf(c);
  assert.equal(g2.json.playing, false);
  assert.ok(Math.abs(g2.json.time - 0.3) < 1e-6);
  assert.equal(g2.json.revision, 1);
});

test('编排中暂停时跳转避险取消编排后可重新播放（沿用保护规则）', async () => {
  const { version } = await seedProtectedVersion();
  const c = await makeRoom(version.id, { overload_protection: true });
  await submit(c, { revision: 0, segments: [{ start: 0, end: 0.8, repeat: 2 }] });
  await sleep(900);
  let g = await stateOf(c);
  assert.ok(g.json.protection.tripped);

  // 暂停（自动暂停）态跳到安全点 0.1：取消编排
  let r = await ctrl(c, { revision: 1, action: 'seek', time: 0.1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.program, undefined);
  assert.equal(r.json.protection.tripped, undefined);
  assert.equal(r.json.protection.overloaded_now, false);

  // 再播放成功（普通房间，随后在 0.3 被截停）
  r = await ctrl(c, { revision: 2, action: 'play' });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, true);
  await sleep(500);
  g = await stateOf(c);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6);
});

test('未启用保护的房间：编排不做起点超载预检，循环照常穿段完成', async () => {
  const { version } = await seedProtectedVersion();
  const c = await makeRoom(version.id); // 不启用保护
  // 起点就在超载段（未启用保护完全不预检）
  const r = await submit(c, { revision: 0, segments: [{ start: 0.5, end: 0.7, repeat: 2 }] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.protection, { enabled: false });
  await sleep(700);
  const g = await stateOf(c);
  assert.equal(g.json.program.status, 'finished');
  assert.ok(Math.abs(g.json.time - 0.7) < 1e-6);
});

/* ------------------------------- 交接与兼容性 ------------------------------- */

test('主持权交接后新主持人可继续控制编排；旧密钥提交编排 403；观看者只读不见密钥', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  await submit(c, { revision: 0, segments: [{ start: 2, end: 6, repeat: 2 }] });
  await ctrl(c, { revision: 1, action: 'pause' }); // 当前修订号 2

  // 发起交接
  const iss = await request('POST', `/api/rooms/${c.code}/handover/issue`, {
    control_key: c.control_key,
    revision: 2,
  });
  assert.equal(iss.status, 200);
  const token = iss.json.handover_token;

  // 接班人领取（修订号 → 3，新密钥）
  const cl = await request('POST', `/api/rooms/${c.code}/handover/claim`, {
    handover_token: token,
    revision: 2,
  });
  assert.equal(cl.status, 200);
  assert.equal(cl.json.revision, 3);
  const newKey = cl.json.control_key;
  assert.ok(newKey && newKey !== c.control_key);
  // 编排不因交接而重置：仍是同一份编排（暂停保留）
  assert.equal(cl.json.program.segment_count, 1);
  assert.equal(cl.json.program.status, 'paused');

  // 旧密钥再提交编排 → 403，房间不变
  let r = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 3,
    segments: [{ start: 0, end: 2, repeat: 1 }],
  });
  assert.equal(r.status, 403);
  const g0 = await stateOf(c);
  assert.equal(g0.json.revision, 3);
  assert.equal(g0.json.program.segments[0].start, 2);

  // 新主持人可继续控制编排（替换）
  r = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: newKey,
    revision: 3,
    segments: [{ start: 1, end: 3, repeat: 1 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.revision, 4);
  assert.ok(Math.abs(r.json.time - 1) < 1e-6);
});

test('成功提交编排使已发出的交接凭证作废（修订号前进，领取 409）', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);

  const iss = await request('POST', `/api/rooms/${c.code}/handover/issue`, {
    control_key: c.control_key,
    revision: 0,
  });
  assert.equal(iss.status, 200);
  const token = iss.json.handover_token;

  // 主持人随后提交编排（修订号 0 → 1）
  const sub = await submit(c, { revision: 0, segments: [{ start: 0, end: 2, repeat: 1 }] });
  assert.equal(sub.status, 201);

  // 凭证绑定修订号已落后：领取 409 且控制权不变
  const cl = await request('POST', `/api/rooms/${c.code}/handover/claim`, {
    handover_token: token,
    revision: 1,
  });
  assert.equal(cl.status, 409);
  assert.match(cl.json.error, /交接凭证已作废/);
});

test('服务重启后编排与进度可恢复（段/轮次/暂停位置一致）', async () => {
  const { version } = await seedVersion();
  const c = await makeRoom(version.id);
  await submit(c, { revision: 0, segments: [{ start: 2, end: 6, repeat: 3 }] });
  await sleep(300);
  await ctrl(c, { revision: 1, action: 'pause' }); // 暂停在第一轮段内
  const before = (await stateOf(c)).json;
  assert.equal(before.program.round, 1);

  const { app: app2 } = require('../server.js');
  const s2 = http.createServer(app2);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const g = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s2.address().port, path: `/api/rooms/${c.code}` }, (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    assert.equal(g.playing, false);
    assert.ok(Math.abs(g.time - before.time) < 1e-6);
    assert.equal(g.revision, 2);
    assert.equal(g.program.status, 'paused');
    assert.equal(g.program.segment, 1);
    assert.equal(g.program.round, 1);
    assert.ok(Math.abs(g.program.elapsed - before.program.elapsed) < 1e-6);
    assert.equal(g.program.segments[0].repeat, 3);
  } finally {
    await new Promise((r) => s2.close(r));
  }
});
