'use strict';
/*
 * InputBuffer — per-client server-side input playout buffer.
 *
 * Why: the server used to apply each input the moment it arrived (or, in the first
 * timestamped version, replay it from a playhead that locked to whichever packet came
 * first). Either way the server's body drifted away from what the client predicted, and
 * the client had no way to know which of its inputs a snapshot contained.
 *
 * How:
 *  - Every input carries the client's MONOTONIC stamp `t` (seconds, performance.now()/1000;
 *    never the slewed sim clock).
 *  - d = arrival - t = (clock offset + transit). dMin tracks the smallest d seen (slowly
 *    relaxing, so clock drift / a lucky outlier can't pin it), i.e. offset + best transit.
 *  - An input is played out at server time  t + dMin + buf  where buf is a small adaptive
 *    jitter-buffer delay (fast attack, slow decay on the observed excess delay). So durations
 *    are reproduced exactly; a late packet only matters if it is later than buf.
 *  - ack = the client-stamp time up to which inputs have been applied. The state the server
 *    produces for that tick reflects the client's inputs up to `ack`; the client compares the
 *    sample with what it predicted AT that stamp (no RTT estimate, no guessing).
 */
const MAX_QUEUE = 120;
const BUF_MIN = 0.04, BUF_MAX = 0.30;
const DRIFT = 0.0005;            // s of upward relaxation of dMin per second (clock drift allowance)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const axis = v => (typeof v === 'number' && isFinite(v) ? clamp(v, -1, 1) : 0);

class InputBuffer {
  constructor() { this.reset(); }

  reset() {
    this.q = [];
    this.cur = { mx: 0, mz: 0, fire: false };
    this.dMin = null; this.lastArr = 0; this.jit = 0; this.buf = BUF_MIN;
    this.ack = 0; this.active = false;
  }

  /** @returns {boolean} true if the message was timestamped and queued */
  push(m, nowS) {
    // stamps are the client's performance.now()/1000 (>= 0, days at most); anything else is garbage -> legacy path
    if (!m || typeof m.t !== 'number' || !(m.t >= 0 && m.t < 1e7)) return false;
    const msg = { t: m.t, mx: axis(m.mx), mz: axis(m.mz), fire: !!m.fire, jump: !!m.jump, dive: !!m.dive };
    const d = nowS - m.t;
    if (this.dMin === null) { this.dMin = d; this.buf = BUF_MIN; }
    else this.dMin = Math.min(d, this.dMin + DRIFT * Math.max(0, nowS - this.lastArr));
    const ex = Math.max(0, d - this.dMin);
    this.jit += (ex - this.jit) * (ex > this.jit ? 0.3 : 0.02);   // fast attack, slow decay (~p90-ish)
    this.lastArr = nowS;
    let i = this.q.length;                                          // keep sorted by stamp
    while (i > 0 && this.q[i - 1].t > msg.t) i--;
    this.q.splice(i, 0, msg);
    if (this.q.length > MAX_QUEUE) this.q.splice(0, this.q.length - MAX_QUEUE);
    this.active = true;
    return true;
  }

  /** Call once per server tick. Returns the input to simulate this tick (null until the first packet). */
  step(nowS) {
    if (!this.active) return null;
    const target = clamp(this.jit * 1.2 + 0.02, BUF_MIN, BUF_MAX);
    this.buf += clamp(target - this.buf, -0.001, 0.001);            // slew <= 1 ms per tick
    const play = nowS - this.dMin - this.buf;
    let jump = false, dive = false;
    while (this.q.length && this.q[0].t <= play) {
      const h = this.q.shift();
      this.cur = { mx: h.mx, mz: h.mz, fire: h.fire };
      if (h.jump) jump = true;
      if (h.dive) dive = true;
    }
    this.ack = play;
    return { mx: this.cur.mx, mz: this.cur.mz, fire: this.cur.fire, jump, dive };
  }
}

module.exports = { InputBuffer, MAX_QUEUE, BUF_MIN, BUF_MAX };
