const fs = require('node:fs');
const { planCadInput, decodeCadInput } = require('./dist/core/application/cad/input');

function parseCadInput(args, inputs = {}, formatting = {}, readFile = fs.readFileSync) {
  const plan = planCadInput(args, inputs, formatting);
  let fileText;
  if (plan.payload?.kind === 'file') {
    const bytes = readFile(plan.payload.value);
    if (process.env.FMCAD_QUEUE_WORKER_JOB) require('./queue-client').verifyInputBytes(plan.payload.value, bytes);
    fileText = bytes.toString('utf8');
  }
  return decodeCadInput(plan, fileText);
}
module.exports = { parseCadInput };
