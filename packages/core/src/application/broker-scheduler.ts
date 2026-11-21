interface SchedulerPorts<Selection> {
  /** Expiry and local work must not depend on physical eligibility. */
  maintain(): void;
  canSelect(): boolean;
  /** Select (and durably grant) once through queue policy. */
  select(): Selection | null;
  /** Acquire synchronously, then own execution and settlement against that grant. */
  start(selection: Selection): Promise<void>;
  /** Host event-loop scheduling (e.g. setImmediate). */
  defer(wake: () => void): void;
  /** Report an unexpected rejection; a selection alone never authorizes settlement. */
  onFailure(error: unknown, selection: Selection | null): void;
}

/** Drive individual physical turns, leaving local work and recovery to ports. */
export function createBrokerScheduler<Selection>(
  ports: SchedulerPorts<Selection>,
) {
  let deferred = false;
  // Protect selection from synchronous reentry only; an asynchronous turn never
  // holds this guard, so future ticks can perform maintenance while it is in flight.
  let selecting = false;

  function wakeup() {
    if (deferred) return;
    deferred = true;
    ports.defer(() => {
      deferred = false;
      void tick();
    });
  }

  async function tick() {
    if (selecting) return;
    let selection: Selection | null = null;
    let execution: Promise<void> | undefined;
    selecting = true;
    try {
      ports.maintain();
      if (ports.canSelect()) {
        selection = ports.select();
        if (selection !== null) execution = ports.start(selection);
      }
    } catch (error) {
      ports.onFailure(error, selection);
    } finally {
      selecting = false;
    }
    if (!execution) return;
    try {
      await execution;
    } catch (error) {
      ports.onFailure(error, selection);
    } finally {
      wakeup();
    }
  }

  return { tick, wakeup };
}
