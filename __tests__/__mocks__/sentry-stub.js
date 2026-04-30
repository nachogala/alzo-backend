/**
 * sentry-stub.js — drop-in replacement for @sentry/node during tests.
 *
 * Captures every addBreadcrumb / captureMessage / captureException call into
 * an in-memory log. Exposed via getBreadcrumbs() / getMessages() / _reset().
 *
 * Wired up via jest.config.js → moduleNameMapper:
 *   '^@sentry/node$': '<rootDir>/__tests__/__mocks__/sentry-stub.js'
 */

// Pin state to globalThis so the captured trail survives jest.resetModules()
// (otherwise every server.js boot under test gets a NEW stub instance and the
// test side and the server side are pushing/reading from different objects).
if (!globalThis.__SENTRY_STUB_STATE__) {
  globalThis.__SENTRY_STUB_STATE__ = { breadcrumbs: [], messages: [], exceptions: [] };
}
const _state = globalThis.__SENTRY_STUB_STATE__;

module.exports = {
  init: () => {},
  addBreadcrumb: (b) => { _state.breadcrumbs.push(b || {}); },
  captureMessage: (msg, opts) => { _state.messages.push({ msg, opts }); },
  captureException: (err, opts) => { _state.exceptions.push({ err, opts }); },
  setTag: () => {},
  setUser: () => {},
  setContext: () => {},
  withScope: (fn) => fn({ setTag: () => {}, setUser: () => {}, setContext: () => {}, setExtra: () => {} }),
  Handlers: {
    requestHandler: () => (req, res, next) => next(),
    errorHandler: () => (err, req, res, next) => next(err),
    tracingHandler: () => (req, res, next) => next(),
  },
  expressIntegration: () => ({}),
  httpIntegration: () => ({}),
  setupExpressErrorHandler: () => {},
  // Test helpers
  getBreadcrumbs: () => [..._state.breadcrumbs],
  getMessages: () => [..._state.messages],
  getExceptions: () => [..._state.exceptions],
  _reset: () => {
    _state.breadcrumbs.length = 0;
    _state.messages.length = 0;
    _state.exceptions.length = 0;
  },
};
