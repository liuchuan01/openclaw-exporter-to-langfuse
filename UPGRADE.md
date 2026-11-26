# 升级到 0.4.0：离线安装与验收

本指南用于将本 fork 的旧版插件升级到 **0.4.0**。已验证 OpenClaw
**2026.11.1、2026.11.5**，无需升级 OpenClaw 本体，也无需修改 Langfuse 项目密钥。

## 本版变化与升级前提

- 长任务不再因连续 20 分钟无 hook 被提前结束，以宿主 executionSettled 为最终完成依据。
- 评测登记、完成结果保存在宿主 state 目录，完成后默认保留 24 小时。
- 排队等待默认不限时，最多保留 10000 条登记；这三个值均可配置。
- 插件重启后能续查已完成结果；重启时仍在执行的请求返回 unknown，不自动重跑。
- 不会重建重启前丢失的内存 span，也不会自动回读宿主历史补答案。

**0.3.x 结果只在内存中，无法随升级迁移。** 升级前应让调用方取回旧结果，并安排停机窗口。
如果选择直接停机，未结束请求可能中断或失去完整 trace。插件配置的等待时间不改变
OpenClaw 本身或模型提供商的执行超时。

以下命令使用运行网关的同一用户、Node 环境、profile/state 目录执行。默认配置路径为
`$HOME/.openclaw/openclaw.json`；使用其他目录时替换实际路径。Docker 部署应在相同容器
环境内执行 CLI，插件目录和 state 目录都必须持久挂载。

## 1. 准备文件并确认当前版本

交付两个文件：

```text
openclaw-exporter-to-langfuse-0.4.0-offline.tar.gz
openclaw-exporter-to-langfuse-0.4.0-offline.tar.gz.sha256
```

离线包包含生产依赖，无需访问 npm/GitHub。不要用上游 npm 包、OSS 安装脚本替代本包。
在接收文件的目录执行：

```bash
command -v openclaw
openclaw --version
node --version
openclaw plugins inspect openclaw-exporter-to-langfuse --runtime --json \
  > langfuse-plugin-before.json
```

确认 OpenClaw 为 2026.11.1 或 2026.11.5，记下报告的 `plugin.rootDir`（旧插件目录）。

## 2. 校验、解压、备份

```bash
sha256sum -c openclaw-exporter-to-langfuse-0.4.0-offline.tar.gz.sha256
mkdir -p "$HOME/openclaw-plugins"
tar -xzf openclaw-exporter-to-langfuse-0.4.0-offline.tar.gz \
  -C "$HOME/openclaw-plugins"
cd "$HOME/openclaw-plugins/openclaw-exporter-to-langfuse-0.4.0-offline"
sha256sum -c SHA256SUMS
(cd plugin && node --input-type=module -e "await import('./dist/index.js')")
cp -p "$HOME/.openclaw/openclaw.json" \
  "$HOME/.openclaw/openclaw.json.before-langfuse-040"
```

校验失败不要继续。保留旧插件目录、原包和配置备份，不要覆盖旧目录里的代码或依赖。

## 3. 停止网关，替换旧加载入口

服务安装使用：

```bash
openclaw gateway stop
```

若已有 systemd user 服务，可使用 `systemctl --user stop openclaw-gateway.service`。
Docker 或其他进程管理器则使用原部署的停止命令。不要在同一网关上混用不同启动方式。

编辑实际 `openclaw.json`，只将 `plugins.load.paths` 中本插件的旧目录替换为新版
**绝对路径**，其他插件条目保留。例如：

```json
"load": {
  "paths": [
    "/home/实际用户名/openclaw-plugins/openclaw-exporter-to-langfuse-0.4.0-offline/plugin"
  ]
}
```

**这里是替换，不是追加。** 同时保留 0.3.x 与 0.4.0 会出现 duplicate plugin id，可能继续
加载旧版，或报 no authoritative package-owner metadata。先修正路径，不要反复强制安装。

如果旧版是普通包安装、位于 `~/.openclaw/extensions/`，先依据 inspect 报告和
`openclaw plugins uninstall --help` 处理该插件的旧安装记录；不要删除整个 extensions
目录。保留本插件配置和备份后再切换到 --link，确保只有一个同 ID 的发现入口。

## 4. 安装新目录、保留配置并启动

```bash
openclaw plugins install \
  --link "$HOME/openclaw-plugins/openclaw-exporter-to-langfuse-0.4.0-offline/plugin" \
  --force --accept-capabilities

openclaw config set \
  plugins.entries.openclaw-exporter-to-langfuse.hooks.allowConversationAccess true
```

`--force` 确认本地来源，`--accept-capabilities` 确认插件声明的能力；两者不替代宿主会话授权。
`hooks` 必须与 `config` 同级。保留原有 endpoint、Authorization、tags 和 evaluationEnabled。
无需重新复制密钥，也不要在聊天或命令历史中暴露密钥。

仅在需要评测接入、且之前未开启时执行：

```bash
openclaw config set \
  plugins.entries.openclaw-exporter-to-langfuse.config.evaluationEnabled true
```

新配置默认值已经生效，无需逐条设置：

| config 字段 | 默认值 | 含义 |
| --- | --- | --- |
| evaluationResultTtlMs | 86400000 | 完成或 unknown 后保留 24 小时，查询不续期 |
| evaluationPreparedTimeoutMs | 0 | 不限制 prepare 后的排队等待 |
| evaluationMaxEntries | 10000 | 所有保留登记的总容量，不提前淘汰未过期结果 |

用原部署方式启动网关，例如：

```bash
openclaw gateway start
```

如果第 3 步使用 systemd，则执行 `systemctl --user start openclaw-gateway.service`。
安装目录是长期加载路径，安装后不能移动或删除。

## 5. 验收实际运行版本与上报

等待网关和插件服务初始化完成。端口开始监听不代表插件已经就绪。

```bash
cd "$HOME/openclaw-plugins/openclaw-exporter-to-langfuse-0.4.0-offline"
node ./check-runtime.mjs
openclaw plugins inspect openclaw-exporter-to-langfuse --runtime --json
```

检查：

- version 为 0.4.0，source/rootDir 指向新目录；loaded、enabled、activated 均正常。
- hookCount 为 8，没有 blocked/error 或 duplicate plugin id 诊断。
- 开启评测时包含 langfuse.agent.prepare、langfuse.agent.result 两个接口。

发起一条真实问题，最好包含一次只读工具调用。在 Langfuse 核对问题、最终答案、模型与
工具节点。使用 VSE 时，确认 experiment 结果与 Agent 输出一致。

若要验证持久化，先让一条评测完成并记录 request_id，然后在空闲时热重载：

```bash
openclaw plugins reload openclaw-exporter-to-langfuse --wait
openclaw gateway call langfuse.agent.result \
  --params '{"request_id":"替换为刚才完成的request_id"}' --json
```

结果应仍为 completed，output、trace_id 和 observationId 与重载前一致。不要拿升级前的
0.3.x 请求做持久化验收。重启时仍运行的任务应是 unknown；它不是失败证明，不应自动重发。

持久化目录位于当前宿主 state 目录的：

```text
plugins/openclaw-exporter-to-langfuse/evaluations/
```

目录包含问题、答案及请求元数据，仅供同一网关使用，需限制访问并保留持久磁盘。
完整生命周期约定见 [EVALUATION.md](./EVALUATION.md#生命周期与评分)。

## 6. 回滚

停止网关，恢复配置备份，再安装旧版 rootDir。下面的路径必须替换为第 1 步记下的值：

```bash
openclaw gateway stop
cp -p "$HOME/.openclaw/openclaw.json.before-langfuse-040" \
  "$HOME/.openclaw/openclaw.json"
openclaw plugins install --link "/旧版插件的绝对路径" --force --accept-capabilities
openclaw gateway start
```

如使用 systemd/Docker，停止与启动依然沿用原方式。重新 inspect 并发真实请求验收。
不要删除 0.4.0 的持久化目录；旧版不会读取这些结果，回滚也不会补回丢失的 trace。
