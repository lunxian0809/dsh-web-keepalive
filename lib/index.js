/**
 * Host half of dsh-web-keepalive.
 *
 * The fix itself lives entirely in the browser half (`./client.js`): it keeps the
 * `/api/remote.mux` WebSocket warm so the gateway heartbeat cannot decide the page
 * is gone. This host half exists so the loader row activates on the host plane and
 * `@deepseek-ai/dsh-client-modules` can find the package manifest that declares
 * `dsh.client`.
 *
 * Deliberately publishes nothing: no service, no route, no tool. A row that
 * provides nothing can sit loose in the host composition without an isolate realm,
 * and it therefore cannot collide with a second session or shadow host state.
 *
 * @module dsh-web-keepalive
 */

/**
 * Loader row entry.
 *
 * Carries no host-side behaviour by design; the keepalive is a browser concern.
 * @param ctx - host context for this row (unused).
 */
export function apply(ctx) {
  void ctx
}
