"use strict";

const Module = require("node:module");
const path = require("node:path");
const worker = path.resolve(process.argv[1]);
const originalLoad = Module._load;

// Only the retained evaluator child gets the existing explicit offline backend
// seam. It does not impersonate WSL or provide a Fusion/SDK implementation.
Module._load = function (request, parent, isMain) {
  if (request === "./queue-broker" && parent?.filename === worker) {
    const broker = originalLoad.call(this, request, parent, isMain);
    return {
      ...broker,
      serve(config, options = {}) {
        return broker.serve(config, {
          ...options,
          createBackend: () => ({
            server: { timeoutMs: 1000 },
            _parse: JSON.parse,
            _post() {
              throw new Error(
                "Offline retained evaluator attempted an SDK request",
              );
            },
          }),
        });
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
