import { randomUUID } from "node:crypto";
import { controlIntent } from "@fmcad/core";

export interface ObservedBrokerState {
  readonly instanceId: string;
  readonly generation: number;
}
export interface ObservedBrokerClient {
  register(options: { autoStart: false }): Promise<unknown>;
  call(
    method: string,
    values?: {
      control: {
        requestId: string;
        instanceId: string;
        expectedGeneration: number;
      };
    },
  ): Promise<ObservedBrokerState>;
}

/** Shared passive observation/fencing adapter, independent of terminal rendering. */
export class BrokerObservation<Client extends ObservedBrokerClient> {
  client: Client | undefined;
  current: ObservedBrokerState | null = null;
  observedAt = 0;
  constructor(readonly factory: () => Client) {}

  async read(): Promise<ObservedBrokerState> {
    this.client ??= this.factory();
    await this.client.register({ autoStart: false });
    this.current = await this.client.call("control-status");
    this.observedAt = Date.now();
    return this.current;
  }

  async set(paused: boolean): Promise<ObservedBrokerState> {
    if (!this.current) throw new Error("Read broker state before control");
    const before = await this.read();
    const intent = controlIntent(paused, randomUUID(), {
      status: "available",
      value: before,
      observedAt: this.observedAt,
    });
    try {
      return (this.current = await this.client!.call(intent.method, {
        control: intent.control,
      }));
    } catch (error) {
      this.current = null;
      try {
        await this.read();
      } catch {
        /* Observe only; never replay an uncertain action. */
      }
      throw error;
    }
  }
}
