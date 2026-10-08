/* The Web MIDI sender against a mock MIDIOutput: the exact bytes, in order, at DIN pace.
 * Part of the browser installer (working name "web"). SPDX-License-Identifier: GPL-3.0-or-later.
 * No real device, no virtual port, no system setting is touched. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const L = require('./lib.js');
const S = require(path.join(L.WEB, 'src/sender/sender.js'));

const EPS = 1e-6;

/* A clock that only moves when the sender sleeps (and, optionally, jumps). */
function fakeClock(jumps = {}) {
  let t = 1000, sleeps = 0;
  return {
    now: () => t,
    sleep: async ms => { sleeps++; t += ms; if (jumps[sleeps]) t += jumps[sleeps]; },
    advance: ms => { t += ms; },
    get sleeps() { return sleeps; }
  };
}

class MockOutput {
  constructor(clock) { this.clock = clock; this.log = []; }
  send(data, ts) { this.log.push({ data: Uint8Array.from(data), ts, at: this.clock.now() }); }
}

function checkPacing(log, gap, ahead, baud = 31250) {
  for (let i = 0; i < log.length; i++) {
    assert.ok(log[i].ts - log[i].at <= ahead + EPS, `message ${i} queued ${log[i].ts - log[i].at} ms ahead`);
    if (i) {
      const need = S.wireMs(log[i - 1].data.length, baud) + gap;
      assert.ok(log[i].ts - log[i - 1].ts >= need - EPS,
        `message ${i} only ${log[i].ts - log[i - 1].ts} ms after the previous one (needs ${need})`);
    }
  }
  const bytes = log.reduce((n, m) => n + m.data.length, 0);
  const span = log[log.length - 1].ts + S.wireMs(log[log.length - 1].data.length, baud) - log[0].ts;
  const avgBaud = bytes * 10 / (span / 1000);
  assert.ok(avgBaud <= baud + EPS, `average ${avgBaud} baud`);
  return avgBaud;
}

const stocks = L.findStock();
const sample = Object.values(stocks).find(s => L.known.stock.some(k => k.sha256 === L.SHA.sha256hex(s.bytes) && k.supported));

test('splitSysex: the stock file is F0..F7 messages that rejoin to the exact file', { skip: !sample }, () => {
  const msgs = S.splitSysex(sample.bytes);
  const joined = Buffer.concat(msgs.map(m => Buffer.from(m)));
  assert.ok(joined.equals(Buffer.from(sample.bytes)));
  for (const m of msgs) { assert.strictEqual(m[0], 0xf0); assert.strictEqual(m[m.length - 1], 0xf7); }
  assert.deepStrictEqual([...new Set(msgs.map(m => m.length))].sort((a, b) => a - b), [16, 128]);
});

test('splitSysex refuses junk', () => {
  assert.throws(() => S.splitSysex(new Uint8Array([0x00, 0xf0, 0xf7])), /not the start/);
  assert.throws(() => S.splitSysex(new Uint8Array([0xf0, 0x01, 0x90, 0xf7])), /status byte/);
  assert.throws(() => S.splitSysex(new Uint8Array([0xf0, 0x01, 0x02])), /no end byte/);
});

test('wire time: 128 B at 31250 baud is 40.96 ms', () => {
  assert.ok(Math.abs(S.wireMs(128) - 40.96) < 1e-9);
});

test('mock send: byte-identical message sequence, gap + wire spacing, <= 1 s ahead, <= 31250 baud', { skip: !sample }, async () => {
  const msgs = S.splitSysex(sample.bytes);
  const clock = fakeClock();
  const out = new MockOutput(clock);
  const prog = [];
  const r = await S.send({ output: out, messages: msgs, gapMs: 20, aheadMs: 1000, clock,
                           onProgress: p => prog.push(Object.assign({ now: clock.now() }, p)) });
  assert.ok(r.done && !r.aborted);
  assert.strictEqual(out.log.length, msgs.length);
  for (let i = 0; i < msgs.length; i++) assert.ok(Buffer.from(out.log[i].data).equals(Buffer.from(msgs[i])), `message ${i}`);
  assert.ok(Buffer.concat(out.log.map(m => Buffer.from(m.data))).equals(Buffer.from(sample.bytes)));
  const avg = checkPacing(out.log, 20, 1000);
  assert.ok(prog.every((p, i) => p.sent === i + 1));
  const expected = S.estimateMs(msgs, 20);
  const end = out.log[out.log.length - 1].ts + S.wireMs(msgs[msgs.length - 1].length);
  const took = end - out.log[0].ts;
  // the ETA shown at every step is exactly the time left until the last byte leaves
  for (const p of prog) assert.ok(Math.abs(p.now + p.etaMs - end) < 1e-6, `ETA at ${p.sent}`);
  assert.ok(prog[prog.length - 1].etaMs <= 1000 + S.wireMs(128) + 1e-6);
  assert.ok(Math.abs(took - expected) < 1e-3, `took ${took} ms, estimate ${expected}`);
  console.log(`  ${msgs.length} messages, ${sample.bytes.length} B, gap 20 ms: ${(took / 60000).toFixed(2)} min, average ${avg.toFixed(0)} baud`);
});

test('gap 0: back-to-back still never above 31250 baud', { skip: !sample }, async () => {
  const msgs = S.splitSysex(sample.bytes).slice(0, 2000);
  const clock = fakeClock();
  const out = new MockOutput(clock);
  await S.send({ output: out, messages: msgs, gapMs: 0, clock });
  const avg = checkPacing(out.log, 0, 1000);
  assert.ok(avg > 31249 && avg <= 31250 + EPS, `average ${avg}`);
});

test('a stalled computer restarts the schedule instead of bursting', async () => {
  const msgs = Array.from({ length: 300 }, (_, i) => new Uint8Array([0xf0, 0x00, 0x20, 0x3c, i & 0x7f, 0xf7]));
  const clock = fakeClock({ 5: 5000, 9: 12000 }); // two long stalls
  const out = new MockOutput(clock);
  // a mock that also stalls inside send() now and then
  const orig = out.send.bind(out);
  out.send = (d, ts) => { orig(d, ts); if (out.log.length % 97 === 0) clock.advance(3000); };
  await S.send({ output: out, messages: msgs, gapMs: 5, aheadMs: 200, clock });
  checkPacing(out.log, 5, 200);
  assert.strictEqual(out.log.length, msgs.length);
});

test('abort stops scheduling within the look-ahead', async () => {
  const msgs = Array.from({ length: 500 }, () => new Uint8Array(128).fill(0x01).fill(0xf0, 0, 1).fill(0xf7, 127));
  const clock = fakeClock();
  const out = new MockOutput(clock);
  const signal = { aborted: false };
  const r = await S.send({ output: out, messages: msgs, gapMs: 20, aheadMs: 1000, clock, signal,
                           onProgress: p => { if (p.sent === 100) signal.aborted = true; } });
  assert.ok(r.aborted && !r.done);
  assert.strictEqual(out.log.length, 100);
  const last = out.log[out.log.length - 1];
  assert.ok(last.ts - clock.now() <= 1000 + EPS, 'queued data at abort is within the look-ahead');
});

test('real timers: short stream keeps its spacing and look-ahead', async () => {
  const msgs = Array.from({ length: 40 }, (_, i) => new Uint8Array([0xf0, 0x00, i, 0xf7]));
  const clock = S.realClock();
  const out = new MockOutput(clock);
  const t0 = clock.now();
  const r = await S.send({ output: out, messages: msgs, gapMs: 3, aheadMs: 30, startDelayMs: 5, clock });
  assert.ok(r.done);
  checkPacing(out.log, 3, 30 + 2); // 2 ms slack for the timer's own wake-up jitter
  assert.ok(clock.now() - t0 >= S.estimateMs(msgs, 3) - 1);
});
