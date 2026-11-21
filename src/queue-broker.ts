import * as broker from "./composition/queue-broker";

// Keep the CommonJS own exports writable for existing host adapter injection.
export const assertResetSubmissionOpen = broker.assertResetSubmissionOpen;
export const brokerConfigHash = broker.brokerConfigHash;
export const matching = broker.matching;
export const reclaim = broker.reclaim;
export const serve = broker.serve;
