"use strict";

const os = require("node:os");

/** Emulates only WSL path spelling for offline tests with fake physical backends. */
module.exports = function installFakeWslPlatform() {
  const originalDistro = process.env["WSL_DISTRO_NAME"];
  const originalRelease = os.release;
  if (
    originalDistro &&
    /microsoft.*wsl2|wsl2.*microsoft/i.test(originalRelease())
  )
    return () => {};

  process.env["WSL_DISTRO_NAME"] = "FMCAD_TEST";
  os.release = () => `${originalRelease()} Microsoft WSL2 (offline fixture)`;
  return () => {
    os.release = originalRelease;
    if (originalDistro === undefined) delete process.env["WSL_DISTRO_NAME"];
    else process.env["WSL_DISTRO_NAME"] = originalDistro;
  };
};
