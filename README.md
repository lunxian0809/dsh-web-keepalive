# dsh-web-keepalive

Stops the [dsh](https://github.com/deepseek-ai) Web GUI from dropping its live connection.

A small, dependency-free dsh plugin: one host-side no-op row plus one browser bundle that holds a
warm WebSocket on the gateway endpoint, so the Host heartbeat cannot conclude the page is gone.

## 简介

dsh 网页端用一段时间后连接断开，根因是宿主对实时通道 `/api/remote.mux` 的存活检查过窄：每 2 秒发一个
WebSocket Ping，只容忍 2 次丢包，约 **6 秒**收不到 pong 就直接 `terminate()` 连接。而 pong 完全依赖浏览器
自动回复控制帧——标签页后台节流、主线程卡顿、休眠唤醒、代理不转发控制帧，都会让它失守，于是服务端不断掐断
用户其实还在的连接，页面只能反复退避重连。

本插件在浏览器端每 **1 秒**发送一个协议合法的轻量帧复位心跳计数，掐断窗口就不会打开。它开的是自己的一条
连接，不碰产品原有的 socket，也不调用任何内部接口。装完重启 dsh 永久生效，无运行时依赖。

---

## The problem

The dsh Web GUI's live channel is a single WebSocket at `/api/remote.mux`, owned by
`@deepseek-ai/dsh-api-gateway`. Liveness is decided **only by the Host**, and the window is narrow:

| Where | Constant | Meaning |
| --- | --- | --- |
| `dsh-api-gateway/lib/index.js` | `DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2000` | one WebSocket **Ping** control frame every 2 s |
| `dsh-api-gateway/lib/types/stream-server.js` | `MAX_MISSED_HEARTBEATS = 2` | consecutive ping intervals without a pong before `socket.terminate()` |

The counter is incremented **before** each ping (`missed + 1`) and reset only when a pong arrives, so
the real tolerance is about **6 seconds**.

Survival therefore depends entirely on the browser auto-replying with a **pong control frame** — and
the browser half owns no heartbeat of its own to correct for it. Pongs go missing when:

- a background tab is throttled and stops draining the socket;
- a long task blocks the main thread;
- the machine sleeps and resumes;
- a proxy or TLS interceptor does not forward control frames.

When that happens the Host terminates a connection the user still has, and the page reconnects on
backoff. dsh's reconnect logic (`dsh-client-connection`, 500 ms exponential backoff capped at 10 s) is
sound — the problem is that the server keeps killing the socket, so reconnects repeat forever. That is
the "disconnects after a while" symptom.

## The fix

Keep a dedicated, idle-but-warm socket on the same endpoint and send a protocol-valid frame once per
second. Any traffic on the socket resets the Host's missed-heartbeat counter, so the ~6 s termination
window never opens.

The frame is deliberately chosen. `parseRemoteStreamClientMessage` accepts `{ type: 'cancel', streamId }`,
and the server handles an unknown id as `this.streams.get(id)?.abort(...)` — a **no-op**. It cannot be
mistaken for a duplicate stream, produces no error frame, and touches no business state:

```js
socket.send(JSON.stringify({ type: 'cancel', streamId: 'ka-' + Date.now() + '-' + (++nonce) }))
```

The Host's counter advances before the check while a pong lands inside the same interval, so a warm
socket is counted alive rather than miscounted as missed.

Everything is owned by one `ctx.effect`: unmounting the row clears the interval and closes the socket.

## Install

### Option A — the installer

From a clone of this repository:

```sh
node install.mjs              # installs into $DSH_HOME/profiles/web
node install.mjs --dry-run    # show what it would do, change nothing
node install.mjs --profile tui --dsh-home /path/to/.dsh
```

It copies the package to `<profile>/plugins/web-keepalive/` and adds one row to
`<profile>/cordis.patch.yml`. It is idempotent, and it **refuses rather than guesses**: if that patch
file is not a top-level block sequence, it leaves the file untouched and prints the entry to add by
hand. Then restart dsh.

### Option B — by hand

1. Copy this package to `<profile>/plugins/web-keepalive/`.
2. Add this item to the top-level array in `<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: web-keepalive
      name: "./plugins/web-keepalive/lib/index.js"
```

3. Restart dsh.

> **If cloning or `dsh plugin add` fails with a TLS/connection error**, check
> `C:\Windows\System32\drivers\etc\hosts` (Administrator) for lines pointing `github.com`,
> `api.github.com`, or `raw.githubusercontent.com` at `127.0.0.1`. Accelerators and hosts-based
> "network fixes" leave those behind, and while they are present every GitHub tool on the machine is sent to
> a local address that is not GitHub. Remove them and run `ipconfig /flushdns`.

### Why `insert` matters

The patch layer's non-`insert` form is an **id-targeted override**: `{ id, name }` only rewrites a row
that already exists, and warns `patch: entry "x" not found` otherwise. A *new* row must be wrapped in
`insert:`. Writing it the other way is the single easiest mistake to make here.

Keep the file in one YAML style. Mixing a block `- insert:` into a flow `[ {...} ]` array is a parse
error, and dsh fails loud at boot rather than skipping it.

### Optional: install it as a package instead

The package also resolves by name, which suits a fork or a published copy. Add it to the profile's
`package.json` and use a bare specifier in the patch row:

```sh
dsh plugin --profile web add github:lunxian0809/dsh-web-keepalive
```

```yaml
- insert:
    - id: web-keepalive
      name: "dsh-web-keepalive"
```

## How it is wired

| File | Role |
| --- | --- |
| `lib/index.js` | Host half. Activates the loader row on the host plane and publishes **nothing** — no service, route, or tool, so no isolate realm is needed and it cannot collide or shadow anything. |
| `lib/client.js` | Browser half. The actual fix, in `window.__ModuleLoader__.load({...})` form. |
| `package.json` | Declares `dsh.client.platform = "web"` and `exports["./client"]`, which is how `@deepseek-ai/dsh-client-modules` finds the bundle. |

The host half must exist: `dsh-client-modules` locates the package manifest through the loader row's own
module specifier, so a client bundle with no host row would never be discovered. The row is written as a
relative path (`./plugins/web-keepalive/lib/index.js`) because loader row names resolve against the
composition directory.

## Verifying it is actually running

Open the browser console. On mount the bundle logs:

```
[web-keepalive] active: beating /api/remote.mux every 1000ms
```

To see the effect from the Host side, count the WebSocket connections the web server carries while the
page is idle. The extra one that never drops is this plugin's carrier, and it stays connected far past
the ~6 s the gateway would otherwise terminate at.

This repository's own claim was verified that way before publication: with the same logic running as a
dynamic plugin, the carrier held for **43.5 s** across roughly 21 heartbeat periods — 45 frames sent,
zero disconnects, zero errors. If the mechanism were wrong, the socket would have been terminated inside
6 s.

## Compatibility and caveats

- **Restart required.** The user patch layer is read at startup. It does not hot-reload in a running
  process.
- **It is a second socket.** The plugin opens its own connection to `/api/remote.mux`; it does not touch
  the product's socket or any internal API. If the Host ever rejected a second socket, the carrier would
  fail closed and the GUI would behave exactly as it does today.
- **It is a workaround, not a fix to the Host.** The narrow 2 s / 2-miss liveness policy is upstream
  behaviour in `@deepseek-ai/dsh-api-gateway`. This plugin makes the browser hold up its end of it. A
  future upstream change to that policy would make this plugin unnecessary — not harmful.
- **Pinned to internal Endpoint behaviour.** It relies on `/api/remote.mux` accepting a `cancel` frame
  for an unknown `streamId`. Both are verified against the dsh version noted below; if a future dsh
  version rejects that frame, the socket would be closed with `4002`/`1008` and reconnect, which is
  visible as reconnect churn in the console rather than silent breakage.

Built and verified against **`dsh` 0.1.5-rc.2** with **`@deepseek-ai/dsh-api-gateway` 0.1.5-rc.2**, on
Node.js v24 (Windows). No runtime dependencies.

## Uninstall

Remove the `web-keepalive` `insert` item from `<profile>/cordis.patch.yml`, delete
`<profile>/plugins/web-keepalive/`, and restart dsh.

## Tests

```sh
node test/install.test.mjs      # or: npm test
```

Covers the installer's shape decisions, idempotence, dry-run, and every refusal path against throwaway
profiles. The strongest check feeds the produced `cordis.patch.yml` through **dsh's own patch parser**,
which is what a real boot uses — a patch file dsh cannot parse fails the boot outright, so this is worth
asserting rather than eyeballing.

That check needs a dsh installation. It skips loudly rather than silently when none is found; point it at
one with:

```sh
DSH_APP_BOOT=/path/to/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js \
DSH_INSTALL_ANCHOR=/path/to/dsh/package.json \
node test/install.test.mjs
```

## License

MIT — see [LICENSE](LICENSE).
