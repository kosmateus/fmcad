'use strict';
const { performance } = require('node:perf_hooks');
const { budgetRemaining, budgetTransition } = require('./dist/core/domain/queue-control');

class PauseBudget {
  constructor(ms, expired, { now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
    Object.assign(this, { left: ms, expired, now, schedule, cancel, generation: 0, frozen: false, ended: false });
    this.arm();
  }
  remaining() { return budgetRemaining(this, this.now()); }
  apply(action, generation) {
    const result = budgetTransition(this, action, this.now(), generation);
    Object.assign(this, result.state);
    if (result.effect === 'cancel') this.cancel(this.timer);
    if (result.effect === 'expired') this.expired();
    if (result.effect === 'schedule') {
      const current = this.generation;
      this.timer = this.schedule(() => this.apply('expire', current), this.left);
    }
  }
  arm() {
    this.apply('arm');
  }
  freeze() {
    this.apply('freeze');
  }
  resume() { this.apply('resume'); }
  close() { this.apply('close'); }
}
module.exports = { PauseBudget };
