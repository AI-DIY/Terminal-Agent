/* global module, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { assertProjectElectronRuntime } = require('../../scripts/e2e-electron-runtime.cjs')

module.exports = function globalSetup() {
  assertProjectElectronRuntime()
}
