"use strict";
const { randomUUID } = require("node:crypto");
const { sanitize } = require("./console-logs");
const { openOperation: open } = require("./dist/core");
const {
  ConsoleModel: CoreConsoleModel,
  consoleViews: views,
} = require("./dist/core");
class ConsoleModel extends CoreConsoleModel {
  constructor() {
    super(
      (row, language) =>
        require("./console-log-presentation").logMessage(row, language),
      structuredClone,
    );
  }
}

const {
  createConsoleExporter,
} = require("./dist/node-adapters/console/export");
const exportRows = createConsoleExporter(sanitize);

const {
  BrokerObservation,
} = require("./dist/node-adapters/control-center/broker-observation");
class BrokerControl extends BrokerObservation {
  constructor(
    factory = () =>
      new (require("./queue-client").QueueClient)(
        "console:" + process.pid + ":" + randomUUID(),
      ),
  ) {
    super(factory);
  }
}

module.exports = { ConsoleModel, BrokerControl, exportRows, views, open };
