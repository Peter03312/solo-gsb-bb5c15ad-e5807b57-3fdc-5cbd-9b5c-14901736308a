'use strict';

// 循环排演编排纯函数单元测试（浏览器/Node 共用引擎）：
// 虚拟坐标 -> 段/轮次/时码映射（半开区间归属、回环/跳入下段、归左身份），
// 以及沿编排路径的首个超载边界（段内、段起点、开端点段尾跳过、闭端点段尾拦截、
// 多轮/多段取最早）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/engine.js');

const approx = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !=~ ${expected}`);

// 段1 [2,4]×3（每次 2s，共 6s），段2 [6,8]×1（2s），虚拟总时长 8
function prog() {
  return Engine.prepareProgram([
    { start: 2, end: 4, repeat: 3 },
    { start: 6, end: 8, repeat: 1 },
  ]);
}

test('prepareProgram：派生每段长度、累计偏移与总虚拟时长', () => {
  const p = prog();
  assert.equal(p.total, 8);
  assert.deepEqual(
    p.segments.map((s) => [s.len, s.cumStart, s.cumEnd]),
    [
      [2, 0, 6],
      [2, 6, 8],
    ]
  );
});

test('locateProgram：半开区间归属——段尾瞬间即跳到下一轮/下段', () => {
  const p = prog();
  const cases = [
    // e, expect [i, k, time]
    [0, [0, 0, 2]],
    [1.5, [0, 0, 3.5]],
    [2, [0, 1, 2]], // 第一轮段尾：已跳回段起点进入第二轮
    [3.999, [0, 1, 3.999]],
    [4, [0, 2, 2]], // 第二轮段尾：进入第三轮
    [5, [0, 2, 3]],
    [6, [1, 0, 6]], // 第三轮段尾：跳入第二段起点
    [7, [1, 0, 7]],
  ];
  for (const [e, [i, k, t]] of cases) {
    const loc = Engine.locateProgram(p, e, false);
    assert.equal(loc.i, i, `e=${e} i`);
    assert.equal(loc.k, k, `e=${e} k`);
    approx(loc.time, t);
    assert.equal(loc.finished, false);
  }
});

test('locateProgram：到总时长即完成，停在末段终点', () => {
  const p = prog();
  for (const e of [8, 8.001, 100]) {
    const loc = Engine.locateProgram(p, e, false);
    assert.equal(loc.finished, true, `e=${e}`);
    assert.equal(loc.i, 1);
    assert.equal(loc.k, 0);
    approx(loc.time, 8);
    approx(loc.elapsed, 8);
  }
  // 负值按 0 处理
  const loc0 = Engine.locateProgram(p, -3, false);
  assert.equal(loc0.i, 0);
  assert.equal(loc0.k, 0);
  approx(loc0.time, 2);
});

test('locateProgram(fromLeft)：冻结在轮右端点时身份归给刚结束的那一轮', () => {
  const p = prog();
  // 闭端点恰在段尾触发自动暂停：时码同为段尾，段/轮归属刚结束的轮
  let loc = Engine.locateProgram(p, 2, true);
  assert.equal(loc.i, 0);
  assert.equal(loc.k, 0);
  approx(loc.time, 4);
  loc = Engine.locateProgram(p, 4, true);
  assert.equal(loc.i, 0);
  assert.equal(loc.k, 1);
  approx(loc.time, 4);
  loc = Engine.locateProgram(p, 6, true);
  assert.equal(loc.i, 0);
  assert.equal(loc.k, 2);
  approx(loc.time, 4);
  // 起始点归左仍是第一轮起点
  loc = Engine.locateProgram(p, 0, true);
  assert.equal(loc.i, 0);
  assert.equal(loc.k, 0);
  approx(loc.time, 2);
});

test('programNextTrip：段内闭端点在每一轮都拦截，取最早的一轮', () => {
  const p = prog();
  const b = [{ start: 3, inclusive: true }]; // 段1 每轮中部 t=3 超载
  // 从 e0 起首个不早于 e0 的轮次：偏移 1,3,5
  assert.equal(Engine.programNextTrip(p, b, 0).at, 1);
  assert.equal(Engine.programNextTrip(p, b, 1).at, 1); // 锚点就在边界：推进即冻结
  assert.equal(Engine.programNextTrip(p, b, 1.2).at, 3);
  assert.equal(Engine.programNextTrip(p, b, 3).at, 3);
  assert.equal(Engine.programNextTrip(p, b, 4.5).at, 5);
  assert.equal(Engine.programNextTrip(p, b, 5.5), null); // 段1 所有轮次都已在身后
});

test('programNextTrip：段起点边界在首轮开始与每次回环跳入时都拦截', () => {
  const p = prog();
  const b = [{ start: 2, inclusive: false }]; // 段1 开端点起点
  // 每轮起点（含首段开始）虚拟偏移 0,2,4：锚点在边界上时推进即冻结
  assert.equal(Engine.programNextTrip(p, b, 0).at, 0);
  assert.equal(Engine.programNextTrip(p, b, 2).at, 2);
  assert.equal(Engine.programNextTrip(p, b, 4).at, 4);
  assert.equal(Engine.programNextTrip(p, b, 4.1), null); // 段1 已全部走完，段2 不含 t=2
});

test('programNextTrip：开端点段尾不算撞上（回环/收尾瞬间立即跳走，不进入危险段）', () => {
  const p = prog();
  const b = [
    { start: 4, inclusive: false }, // 段1 开端点段尾
    { start: 8, inclusive: false }, // 末段开端点段尾（正常收尾）
  ];
  assert.equal(Engine.programNextTrip(p, b, 0), null);
  assert.equal(Engine.programNextTrip(p, b, 5.999), null);
  assert.equal(Engine.programNextTrip(p, b, 7.5), null);
});

test('programNextTrip：闭端点段尾抵达即冻结（不回环、不跳入下段）', () => {
  const p = prog();
  const b = [{ start: 4, inclusive: true }]; // 段1 每轮段尾闭端点
  // 轮次段尾虚拟偏移 2,4,6，最后一次（6）不再回环而是冻结（atPlayEnd）
  const h0 = Engine.programNextTrip(p, b, 0);
  assert.equal(h0.at, 2);
  assert.equal(h0.atPlayEnd, true);
  const h1 = Engine.programNextTrip(p, b, 2);
  assert.equal(h1.at, 2); // 锚点就在段尾：推进即冻结
  const h2 = Engine.programNextTrip(p, b, 3);
  assert.equal(h2.at, 4);
  const h3 = Engine.programNextTrip(p, b, 5);
  assert.equal(h3.at, 6);
  assert.equal(h3.atPlayEnd, true);
  // 第二段段尾闭端点（末段终点）：在 8 收尾冻结
  const bEnd = [{ start: 8, inclusive: true }];
  const he = Engine.programNextTrip(p, bEnd, 7);
  assert.equal(he.at, 8);
  assert.equal(he.atPlayEnd, true);
});

test('programNextTrip：多段中边界属于各自段；段外边界忽略；完成后不再触发', () => {
  const p = prog();
  const b = [
    { start: 7, inclusive: true }, // 仅段2 内
    { start: 5, inclusive: true }, // 不属于任何段（段1 [2,4]、段2 [6,8]）
  ];
  assert.equal(Engine.programNextTrip(p, b, 0).at, 7); // 段2 偏移 6+(7-6)=7
  assert.equal(Engine.programNextTrip(p, b, 6).at, 7);
  assert.equal(Engine.programNextTrip(p, b, 7).at, 7);
  assert.equal(Engine.programNextTrip(p, b, 7.1), null);
  // 已完成
  assert.equal(Engine.programNextTrip(p, b, 8), null);
});

test('programNextTrip：边界携带的附加字段随结果原样返回', () => {
  const p = prog();
  const circuit = { circuit_id: 1, name: '面光回路', capacity: 100 };
  const b = [{ start: 3, inclusive: true, circuit }];
  const h = Engine.programNextTrip(p, b, 0);
  assert.equal(h.boundary.circuit.circuit_id, 1);
});
