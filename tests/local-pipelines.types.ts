import type { EngineeringRuntime, DataImportFiles, LocalWorkerPort } from '../packages/core/src';
import { runEngineering, planImage, parseImageArguments } from '../packages/core/src';

const runtime: EngineeringRuntime = { clock: { now: () => 0 } };
runEngineering('fit.stack', { schemaVersion: 1 }, runtime);
planImage(parseImageArguments('trace', ['--input', 'a.png', '--out', 'new']));
// @ts-expect-error A clock is an explicit finite-millisecond provider, not a host object.
const wrongClock: EngineeringRuntime = { clock: { now: () => 'now' } };
// @ts-expect-error Worker outcomes must distinguish missing exit codes/signals.
const wrongWorker: LocalWorkerPort = { run: async () => ({ success: true }) };
// @ts-expect-error A source snapshot must bind the text and its digest.
const wrongFiles: DataImportFiles = { snapshot: () => ({ text: '[]' }) };
void wrongClock;
void wrongWorker;
void wrongFiles;
