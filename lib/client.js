/**
 * Browser half of dsh-web-keepalive.
 *
 * WHY THIS EXISTS
 * The Web GUI's live channel is the gateway WebSocket at `/api/remote.mux`
 * (`@deepseek-ai/dsh-api-gateway`). The Host owns its liveness check and it is
 * strict:
 *
 *   - `DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2000` (lib/index.js) — one
 *     WebSocket Ping control frame every 2 seconds;
 *   - `MAX_MISSED_HEARTBEATS = 2` (lib/types/stream-server.js) — consecutive
 *     ping intervals without a pong before the socket is terminated.
 *
 * The counter is incremented *before* each ping (`missed + 1`) and reset only when
 * a pong arrives, so the real tolerance is about 6 seconds. Survival therefore
 * depends entirely on the browser auto-replying with a pong frame, which it fails
 * to do while a tab is background-throttled, while the main thread is blocked by a
 * long task, across an OS suspend/resume, or behind a proxy that does not forward
 * control frames. The browser half owns no heartbeat of its own, so nothing
 * corrects for that — the Host simply terminates a connection the user still has.
 *
 * WHAT THIS DOES
 * Keeps one dedicated, idle-but-warm socket on the same endpoint and sends a
 * protocol-valid frame once a second. Any traffic on the socket resets the Host's
 * missed-heartbeat counter, so the ~6 second termination window never opens. The
 * frozen-object counter advances before the check and a pong lands during the same
 * interval, so a warm socket is counted as alive rather than miscounted as missed.
 *
 * Frame choice is deliberate. `parseRemoteStreamClientMessage` accepts
 * `{ type: 'cancel', streamId }`, and the server handles an unknown id as
 * `this.streams.get(id)?.abort(...)` — a no-op. It cannot be mistaken for a
 * duplicate stream, produces no error frame, and touches no business state.
 *
 * All side effects belong to the `ctx.effect` below, so stopping or unmounting the
 * row closes the socket and clears the interval.
 */

window.__ModuleLoader__.load({
  id: "dsh-web-keepalive",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    /** Exact WebSocket route carrying every Typert Remote stream. */
    const MUX_PATH = "/api/remote.mux"

    /** Frame period. Must stay well under the Host's ~6 second tolerance. */
    const BEAT_MS = 1000

    /**
     * Absolute same-origin `ws(s)://` URL for the mux endpoint.
     * @returns the URL, or undefined when the page has no usable origin.
     */
    function muxUrl() {
      const base = globalThis.location
      if (base === undefined) return undefined
      const origin = base.origin
      const root = origin !== undefined && origin !== "" && origin !== "null" ? origin : base.href
      if (root === undefined || root === "") return undefined
      const url = new URL(MUX_PATH, root)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      return url.href
    }

    /**
     * Mount the keepalive carrier.
     * @param ctx - client root context (timer service).
     */
    function apply(ctx) {
      ctx.effect(() => {
        let closed = false
        let socket
        let nonce = 0

        const beat = () => {
          if (closed || socket === undefined || socket.readyState !== 1) return
          nonce += 1
          try {
            socket.send(JSON.stringify({
              type: "cancel",
              streamId: "ka-" + String(Date.now()) + "-" + String(nonce),
            }))
          } catch (error) {
            console.warn("[web-keepalive] beat failed:", error)
            try { socket.close() } catch {}
          }
        }

        const open = () => {
          if (closed) return
          const url = muxUrl()
          if (url === undefined) {
            console.warn("[web-keepalive] no usable page origin for " + MUX_PATH)
            return
          }
          let candidate
          try {
            candidate = new WebSocket(url)
          } catch (error) {
            console.warn("[web-keepalive] could not open " + url + ":", error)
            return
          }
          socket = candidate
          candidate.addEventListener("open", () => {
            if (closed) { try { candidate.close() } catch {} }
          })
          candidate.addEventListener("close", () => {
            if (closed) return
            socket = undefined
            // The carrier is expected to outlive the page; recreate it if the
            // Host ever drops it so the fix self-heals instead of going quiet.
            ctx.timeout(open, 300)
          })
          candidate.addEventListener("error", () => {
            console.warn("[web-keepalive] keepalive socket error on " + url)
          })
        }

        open()
        const stopBeating = ctx.interval(beat, BEAT_MS)

        return () => {
          closed = true
          stopBeating()
          const current = socket
          socket = undefined
          if (current !== undefined && (current.readyState === 0 || current.readyState === 1)) {
            try { current.close(1000, "keepalive unmounted") } catch {}
          }
        }
      }, "web-keepalive: /api/remote.mux carrier")

      console.log("[web-keepalive] active: beating " + MUX_PATH + " every " + String(BEAT_MS) + "ms")
    }

    const inject = ["timer"]

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
