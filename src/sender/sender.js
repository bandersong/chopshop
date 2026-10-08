/* sender.js - stream an OS .syx to a MIDI output, message by message, at DIN speed.
 *
 * Part of the browser installer (working name "web"). Copyright (C) 2026 bandersong.
 * SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * Written for the startup-menu route (hold FUNC at power-on, TRIG 4 = OS UPGRADE,
 * DIN MIDI into the unit's MIDI IN). The file's own SysEx messages are sent one by
 * one, unchanged, in order. Pacing:
 *   - each message is timestamped no earlier than the previous one plus its time on
 *     the DIN wire (31250 baud, 10 bits a byte: 0.32 ms a byte, 40.96 ms for 128 B)
 *     plus a configurable gap, so the average rate can never exceed DIN speed, even
 *     through a USB-MIDI interface with a small buffer;
 *   - if the computer falls behind (a stalled tab), the schedule restarts from "now"
 *     instead of catching up with a burst;
 *   - nothing is handed to the browser more than `aheadMs` (default 1 s) before its
 *     time, because Web MIDI in Chrome cannot cancel queued output (no clear()), so an
 *     abort stops the stream within about that long;
 *   - send() resolves (or, after an error, rejects) only once everything it handed to
 *     the browser is due to have left the wire, so the caller can never start a new
 *     stream that interleaves with the tail of a stopped one.
 * The timing source is injectable so the tests can drive it with a fake clock.
 */
(function (root) {
  'use strict';

  var DIN_BAUD = 31250;
  var BITS_PER_BYTE = 10; // start bit + 8 data bits + stop bit

  function wireMs(nBytes, baud) { return nBytes * BITS_PER_BYTE * 1000 / (baud || DIN_BAUD); }

  /* The file's SysEx messages, F0 ... F7 each, in order. Throws on anything else:
   * a stray byte between messages, a status byte inside one, or a missing end. */
  function splitSysex(bytes) {
    var msgs = [], i = 0, n = bytes.length;
    while (i < n) {
      if (bytes[i] !== 0xf0) throw new Error('byte ' + i + ' is not the start of a SysEx message');
      var j = i + 1;
      while (j < n && bytes[j] !== 0xf7) {
        if (bytes[j] & 0x80) throw new Error('byte ' + j + ' is a status byte inside a SysEx message');
        j++;
      }
      if (j >= n) throw new Error('the last SysEx message has no end byte');
      msgs.push(bytes.subarray(i, j + 1));
      i = j + 1;
    }
    if (!msgs.length) throw new Error('the file holds no SysEx messages');
    return msgs;
  }

  /* How long a send takes at this gap: ms from the first byte to the last. */
  function estimateMs(messages, gapMs, baud) {
    var t = 0;
    for (var i = 0; i < messages.length; i++) t += wireMs(messages[i].length, baud) + (i + 1 < messages.length ? gapMs : 0);
    return t;
  }

  function realClock() {
    var perf = (typeof performance !== 'undefined') ? performance : null;
    return {
      now: function () { return perf ? perf.now() : Date.now(); },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, ms)); }); }
    };
  }

  /* Sleep until `until` on this clock. Nothing can call back what the browser already
   * holds, so this wait ignores the abort signal on purpose. */
  async function drain(clock, until) {
    for (;;) {
      var n = clock.now();
      if (n >= until) return;
      await clock.sleep(Math.min(until - n, 250));
    }
  }

  /* send({output, messages, gapMs, baud, aheadMs, startDelayMs, clock, onProgress, onStopping, signal})
   * -> {done, aborted, sent, total, bytes, schedule: [timestamps], drainedAt}
   * `output` needs only send(data, timestamp) (a Web MIDI MIDIOutput, or a mock).
   * Whether it ends done, aborted or with an error, send() settles only after the last
   * message it handed out is due to have left the wire (drainedAt >= that time). */
  async function send(o) {
    var out = o.output, msgs = o.messages;
    var gap = o.gapMs == null ? 20 : o.gapMs;
    if (!(gap >= 0)) throw new Error('gap must be 0 ms or more');
    var baud = o.baud || DIN_BAUD;
    var ahead = o.aheadMs == null ? 1000 : o.aheadMs;
    var clock = o.clock || realClock();
    var signal = o.signal || { aborted: false };
    var total = msgs.length, totalBytes = 0;
    for (var k = 0; k < total; k++) totalBytes += msgs[k].length;
    var remainingMs = estimateMs(msgs, gap, baud);
    var t = clock.now() + (o.startDelayMs == null ? 100 : o.startDelayMs);
    var bytes = 0, schedule = [];
    var wireEnd = -Infinity; // when the last message handed out is due to have left

    function stopping(why) {
      if (o.onStopping) { try { o.onStopping({ why: why, untilMs: Math.max(0, wireEnd - clock.now()) }); } catch (e) { /* UI only */ } }
    }

    try {
      for (var i = 0; i < total; i++) {
        var now = clock.now();
        if (t < now) t = now; // fell behind: restart the schedule from now, never burst
        while (t - now > ahead) {
          if (signal.aborted) break;
          await clock.sleep(Math.min(t - now - ahead, 250));
          now = clock.now();
        }
        if (signal.aborted) {
          if (typeof out.clear === 'function') { try { out.clear(); } catch (e) { /* not supported */ } }
          stopping('aborted');
          await drain(clock, wireEnd);
          return { done: false, aborted: true, sent: i, total: total, bytes: bytes, schedule: schedule, drainedAt: clock.now() };
        }
        out.send(msgs[i], t);
        schedule.push(t);
        bytes += msgs[i].length;
        wireEnd = t + wireMs(msgs[i].length, baud);
        // left after this message: the gap and wire time of every later one
        remainingMs -= wireMs(msgs[i].length, baud) + (i > 0 ? gap : 0);
        t += wireMs(msgs[i].length, baud) + gap;
        if (o.onProgress) {
          o.onProgress({ sent: i + 1, total: total, bytes: bytes, totalBytes: totalBytes,
                         etaMs: Math.max(0, (t - gap) - now) + Math.max(0, remainingMs) });
        }
      }
    } catch (err) {
      // e.g. the interface was unplugged: whatever was already queued may still go out
      stopping('error');
      await drain(clock, wireEnd);
      throw err;
    }
    // every message is queued: wait until the last one is due to have left, so "done"
    // means done (a Stop pressed now cannot take anything back, so it does not cut this short)
    if (signal.aborted) stopping('aborted-after-queue');
    await drain(clock, wireEnd);
    return { done: true, aborted: false, sent: total, total: total, bytes: bytes, schedule: schedule, drainedAt: clock.now() };
  }

  var api = { DIN_BAUD: DIN_BAUD, wireMs: wireMs, splitSysex: splitSysex, estimateMs: estimateMs,
              send: send, realClock: realClock };
  root.RytmSender = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
