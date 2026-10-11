# dsh-web-keepalive

[English](README.md) | **中文**

修复 [dsh](https://github.com/deepseek-ai) 网页端连接被意外断开的问题。

一个轻量、零依赖的 dsh 插件：宿主侧只有一个空转的加载行，浏览器侧一个 bundle，在网关端点上维持一条
常驻 WebSocket，使宿主心跳不会误判页面已经离线。

---

## 问题

dsh 网页端的实时通道是 `/api/remote.mux` 上的**单条** WebSocket，由 `@deepseek-ai/dsh-api-gateway` 持有。
存活判定**完全由宿主单方面做出**，而且窗口很窄：

| 位置 | 常量 | 含义 |
| --- | --- | --- |
| `dsh-api-gateway/lib/index.js` | `DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2000` | 每 2 秒发一个 WebSocket **Ping** 控制帧 |
| `dsh-api-gateway/lib/types/stream-server.js` | `MAX_MISSED_HEARTBEATS = 2` | 连续多少个 ping 周期没收到 pong 就 `socket.terminate()` |

计数是**先自增、再 ping**（`missed + 1`），只有收到 pong 才复位，因此真实容错约 **6 秒**。

也就是说，连接能否存活**完全依赖浏览器自动回复 pong 控制帧**；而浏览器这一侧自己**没有任何心跳**去补救。
以下情况都会让 pong 丢失：

- 标签页被后台节流，不再排空 socket；
- 主线程被长任务阻塞；
- 系统休眠后唤醒；
- 代理或 TLS 拦截器不转发控制帧。

一旦发生，宿主就会掐断一条用户其实还在使用的连接，页面随即退避重连。dsh 的重连逻辑本身是可靠的
（`dsh-client-connection`，500ms 起步的指数退避，封顶 10 秒）——问题在于服务端**反复**掐断 socket，于是
重连无休止地重复。这正是「用一段时间就断连」的成因。

## 做法

在这个端点上额外维持一条闲置但常热的 socket，**每秒**发送一个协议合法的帧。socket 上有任何流量都会复位
宿主的丢包计数，那个约 6 秒的掐断窗口就永远不会打开。

选用哪种帧是刻意决定的。`parseRemoteStreamClientMessage` 接受 `{ type: 'cancel', streamId }`，而服务端对
未知 id 的处理是 `this.streams.get(id)?.abort(...)` —— 即**空操作**。它不会被误判为重复流，不产生错误帧，
也不触碰任何业务状态：

```js
socket.send(JSON.stringify({ type: 'cancel', streamId: 'ka-' + Date.now() + '-' + (++nonce) }))
```

宿主的计数在检查之前自增，而 pong 会在同一个周期内到达，因此常热的 socket 会被判定为存活，而不会被误算成
丢包。

所有副作用都归属同一个 `ctx.effect`：加载行卸载时，定时器被清除、socket 被关闭。

## 安装

### 方式 A —— 用安装脚本

在本仓库的克隆目录下：

```sh
node install.mjs              # 安装到 $DSH_HOME/profiles/web
node install.mjs --dry-run    # 只展示将要做什么，不改动任何文件
node install.mjs --profile tui --dsh-home /path/to/.dsh
```

它会把插件包复制到 `<profile>/plugins/web-keepalive/`，并向 `<profile>/cordis.patch.yml` 追加一行。脚本是
幂等的，且**宁可拒绝也不猜**：如果那个补丁文件不是顶层块式序列，它会保留文件不动，并打印出需要手动加入的
条目。之后重启 dsh。

### 方式 B —— 手动安装

1. 把本包复制到 `<profile>/plugins/web-keepalive/`。
2. 在 `<profile>/cordis.patch.yml` 的顶层数组中追加这一项：

```yaml
- insert:
    - id: web-keepalive
      name: "./plugins/web-keepalive/lib/index.js"
```

3. 重启 dsh。

> **如果 clone 或 `dsh plugin add` 报 TLS／连接错误**，请以管理员身份检查
> `C:\Windows\System32\drivers\etc\hosts`，看是否有把 `github.com`、`api.github.com` 或
> `raw.githubusercontent.com` 指向 `127.0.0.1` 的行。加速器和基于 hosts 的「网络修复」会留下这类记录，
> 只要它们在，机器上每一个访问 GitHub 的工具都会被送到一个并不是 GitHub 的本地地址。删掉这些行并执行
> `ipconfig /flushdns`。

### 为什么必须用 `insert`

补丁层里不带 `insert` 的写法是**按 id 覆盖**：`{ id, name }` 只会改写**已存在**的行，否则会警告
`patch: entry "x" not found`。新增行必须包在 `insert:` 里。写反是这里最容易犯的错误。

同时请让文件保持**一种** YAML 风格。把块式的 `- insert:` 混进流式的 `[ {...} ]` 数组会导致解析错误，而
dsh 在启动时会**直接报错退出**，并不会静默跳过。

### 可选：以包的形式安装

本包同样可以按包名解析，适合 fork 或已发布的副本。把它加入 profile 的 `package.json`，并在补丁行里使用裸
包名：

```sh
dsh plugin --profile web add github:lunxian0809/dsh-web-keepalive
```

```yaml
- insert:
    - id: web-keepalive
      name: "dsh-web-keepalive"
```

## 结构说明

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边。让加载行在宿主平面激活，并且**不发布任何东西**——没有 service、没有路由、没有 tool，因此不需要 isolate realm，也不可能与其他会话冲突或遮蔽宿主状态。 |
| `lib/client.js` | 浏览器半边。真正的修复所在，使用 `window.__ModuleLoader__.load({...})` 形式。 |
| `package.json` | 声明 `dsh.client.platform = "web"` 与 `exports["./client"]`，这是 `@deepseek-ai/dsh-client-modules` 找到该 bundle 的依据。 |

宿主半边必须存在：`dsh-client-modules` 是通过加载行自身的模块说明符去定位包清单的，所以只有客户端 bundle
而没有宿主加载行的话，这个 bundle 永远不会被发现。加载行写成相对路径
（`./plugins/web-keepalive/lib/index.js`），因为加载行的名字是相对于组合目录解析的。

## 如何确认它真的在运行

打开浏览器控制台。bundle 挂载时会打印：

```
[web-keepalive] active: beating /api/remote.mux every 1000ms
```

若想从宿主侧观察效果，可以在页面闲置时统计网页服务器承载的 WebSocket 连接数。那条始终不断开的额外连接就是
本插件的载体，它的存活时间会远超网关原本约 6 秒的掐断点。

本仓库在发布前正是用这种方式验证自身结论的：以动态插件形式运行同样的逻辑，载体持续了 **43.5 秒**，跨越约
21 个心跳周期——发送 45 帧、零断开、零错误。如果机制有误，这个 socket 在 6 秒内就会被终止。

## 兼容性与注意事项

- **需要重启。** 用户补丁层只在启动时读取，运行中的进程不会热重载它。
- **它是一条额外的 socket。** 插件自己向 `/api/remote.mux` 建立连接，不碰产品原有的 socket，也不调用任何
  内部接口。即便宿主将来拒绝第二条 socket，载体也只是失效关闭，网页端表现与今天完全一致。
- **这是绕过，而不是改动宿主。** 2 秒 / 2 次丢包这种过窄的存活策略属于 `@deepseek-ai/dsh-api-gateway` 的
  上游行为。本插件只是让浏览器把自己那一端做好。若上游将来放宽该策略，本插件会变得**多余**——但不会有
  害处。
- **依赖内部端点行为。** 它依赖 `/api/remote.mux` 会接受针对未知 `streamId` 的 `cancel` 帧。这两点都已针对
  下方注明的 dsh 版本验证过；若将来的 dsh 版本拒绝该帧，socket 会以 `4002`/`1008` 关闭并重连——表现为控制台
  里可见的重连抖动，而不是静默失效。

构建与验证环境：**`dsh` 0.1.5-rc.2** 与 **`@deepseek-ai/dsh-api-gateway` 0.1.5-rc.2**，Node.js v24
（Windows）。无运行时依赖。

## 卸载

从 `<profile>/cordis.patch.yml` 中移除 `web-keepalive` 的 `insert` 项，删除
`<profile>/plugins/web-keepalive/`，然后重启 dsh。

## 测试

```sh
node test/install.test.mjs      # 或：npm test
```

覆盖安装脚本的形状判断、幂等性、dry-run，以及所有拒绝路径（均针对临时构造的 profile）。其中最强的一项检查
是把生成的 `cordis.patch.yml` 送进 **dsh 自己的补丁解析器**——也就是真实启动时所用的那个；dsh 解析不了的
补丁文件会让启动直接失败，所以这值得断言，而不是靠肉眼看。

该检查需要一个 dsh 安装。找不到时它会**明确跳过**而不是静默略过；可用下面的方式指定：

```sh
DSH_APP_BOOT=/path/to/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js \
DSH_INSTALL_ANCHOR=/path/to/dsh/package.json \
node test/install.test.mjs
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
