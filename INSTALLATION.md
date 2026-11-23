# 本 fork 的安装与离线交付

适用于 `liuchuan01/openclaw-exporter-to-langfuse`，当前插件 **0.2.1**，宿主固定为 **OpenClaw 2026.11.5**。上游 npm 包和 OSS 制品不是本 fork，请勿混用。

离线交付分为两台机器：**联网构建机**准备编译产物和依赖；**离线运行机**加载已准备好的插件。目标机器不需要访问 npm/GitHub，但必须能访问配置的 Langfuse 地址。本文不包含 OpenClaw 本身和模型服务的离线部署。

## 1. 联网构建机：从源码构建

构建机使用与运行机一致的操作系统、CPU 架构和 Node.js 主版本。以下命令使用 Bash、Node.js、npm、git、tar 和 sha256sum。

```bash
git clone --branch feat/openclaw-2026-11-5 https://github.com/liuchuan01/openclaw-exporter-to-langfuse.git
cd openclaw-exporter-to-langfuse
# 正式交付前切换到审核过的 commit，并记录该 commit。
git rev-parse HEAD
npm ci --ignore-scripts
bash scripts/pack.sh
```

`pack.sh` 同步版本、编译、运行测试并生成 `release/v0.2.1/`。它会替换本地旧的 `release/` 目录，不会发布或上传制品。交付前请将需要保留的旧包移到仓库外。

生成目录包含：

- `openclaw-exporter-to-langfuse-0.2.1.tgz`：编译后的 npm 插件包，**不含运行依赖**。
- `install.sh`、`check-runtime.mjs`：宿主授权、热重载和自检工具。
- `README.md`、`INSTALLATION.md`、`VALIDATION.md`：说明文档。
- `build-info.json`：源 commit、工作区状态、Node 版本和兼容版本。
- `SHA256SUMS`：以上文件的校验和。

推荐使用干净的 git checkout，使 `build-info.json` 中 `workingTreeDirty` 为 `false`。GitHub 下载的源码 ZIP 不带 `.git`，不能直接运行依赖 git 信息的 `pack.sh`；请在联网构建机使用上述 clone 流程。

## 2. 联网构建机：制作含依赖的离线包

**仅拷贝上一步的 `.tgz` 不等于完全离线安装。** OpenClaw 普通本地包安装仍可能下载 npm 依赖。完全离线环境请继续在仓库根目录运行以下步骤，制作包含 `node_modules` 的完整目录包：

```bash
set -euo pipefail
OFFLINE_STAGE=$(mktemp -d)
OFFLINE_BUNDLE="$OFFLINE_STAGE/openclaw-exporter-to-langfuse-0.2.1-offline"
mkdir -p "$OFFLINE_BUNDLE/plugin"

# 提取已编译插件，再用源码的锁文件安装精确版本的生产依赖。
tar -xzf release/v0.2.1/openclaw-exporter-to-langfuse-0.2.1.tgz \
  -C "$OFFLINE_BUNDLE/plugin" --strip-components=1
cp package-lock.json "$OFFLINE_BUNDLE/plugin/"
npm ci --prefix "$OFFLINE_BUNDLE/plugin" --omit=dev --ignore-scripts --no-audit --no-fund

# 确认该目录独立具备加载插件所需的依赖；不连接 Langfuse。
(cd "$OFFLINE_BUNDLE/plugin" && node --input-type=module -e "await import('./dist/index.js')")

cp release/v0.2.1/{install.sh,check-runtime.mjs,README.md,INSTALLATION.md,VALIDATION.md,build-info.json} "$OFFLINE_BUNDLE/"
# 重新生成清单，覆盖离线目录中的文件（含生产依赖）。
(cd "$OFFLINE_BUNDLE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
tar -czf release/v0.2.1/openclaw-exporter-to-langfuse-0.2.1-offline.tar.gz \
  -C "$OFFLINE_STAGE" openclaw-exporter-to-langfuse-0.2.1-offline
(cd release/v0.2.1 && sha256sum openclaw-exporter-to-langfuse-0.2.1-offline.tar.gz \
  > openclaw-exporter-to-langfuse-0.2.1-offline.tar.gz.sha256)
```

向运行机交付两个文件：

```text
openclaw-exporter-to-langfuse-0.2.1-offline.tar.gz
openclaw-exporter-to-langfuse-0.2.1-offline.tar.gz.sha256
```

离线包不应包含 `.env`、Langfuse 密钥或客户配置。校验和用于核对传输前后的内容，需与可信渠道提供的清单比较；它不是发布者签名或 ClawHub 评审。

## 3. 离线运行机：校验并安装

使用**运行网关的同一用户、同一 OpenClaw profile/state 目录和 Node 环境**执行。先确认 CLI 确实指向 2026.11.5，避免 PATH 中旧版本抢先命中。

```bash
command -v openclaw
openclaw --version
node --version
```

在收到交付文件的目录中执行：

```bash
sha256sum -c openclaw-exporter-to-langfuse-0.2.1-offline.tar.gz.sha256
mkdir -p "$HOME/openclaw-plugins"
tar -xzf openclaw-exporter-to-langfuse-0.2.1-offline.tar.gz -C "$HOME/openclaw-plugins"
cd "$HOME/openclaw-plugins/openclaw-exporter-to-langfuse-0.2.1-offline"
sha256sum -c SHA256SUMS
(cd plugin && node --input-type=module -e "await import('./dist/index.js')")

openclaw plugins install --link "$PWD/plugin"
```

这里使用 OpenClaw 的本地目录 `--link` 安装，加载已经带齐依赖的目录。**安装后不能删除或移动该目录，也不要再对它执行普通 `.tgz` 安装或 npm update。** 不要将离线目录当成 npm `.tgz` 包再次安装。容器部署时，该目录必须在网关容器内持久挂载，并且 CLI 与网关能通过同一路径访问。

本地代码包属于非 ClawHub 来源。若宿主要求确认来源，请检查包和提示原因；审核通过后，可显式执行：

```bash
openclaw plugins install --link "$PWD/plugin" --force
```

`--force` 是对本地来源的明确确认，也可能覆盖同 ID 的既有安装；安装脚本不会自动添加它。若遇到安装策略阻断，应按实际策略处理，不要把它当作普通网络错误。旧插件升级请先阅读本文末尾的升级说明。

<a id="configure-the-endpoint-then-grant-host-authorization"></a>

## 4. 配置 Langfuse，授予会话访问权限

配置结构见 [README 的完整 JSON 示例](./README.md#langfuse-配置)。也可逐条设置，替换下列占位符：

```bash
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.config.endpoint 'https://<你的-Langfuse-域名>/api/public/otel'
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.config.headers '{"Authorization":"Basic <base64-public-key-colon-secret-key>"}'
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.config.serviceName 'openclaw-agent'
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.config.tags '["openclaw-2026.11.5"]'
```

Authorization 为 `Basic ` 加上 `public-key:secret-key` 的 Base64 编码；使用 Langfuse 项目 API Key，不是登录密码。含真实密钥的配置建议直接编辑受权限保护的 `openclaw.json`，避免留在 shell 历史中。保留已有 `plugins.allow` 和其他插件条目，并确保本插件 enabled/被允许加载。

等当前 Agent 请求结束，确保网关正在运行，再在离线包根目录执行：

```bash
bash ./install.sh
```

此处**不传包路径**：插件已经通过 `--link` 安装。脚本依次执行：

```bash
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.hooks.allowConversationAccess true
openclaw plugins reload openclaw-exporter-to-langfuse --wait
node ./check-runtime.mjs
```

授权属于 `plugins.entries.<id>.hooks`，**与 `config` 同级**。只有宿主配置能授权，插件和 manifest 都不能自行授权。脚本由操作者运行，不会在插件加载时自动执行。

授权修改通过热重载生效，通常不需要重启整个网关。热重载会结束本插件仍在跟踪的请求，因此应选空闲时段执行。若网关未运行或 reload 失败，脚本会报错退出，不会自行重启网关或宣称安装成功。

## 5. 验收：注册成功与数据送达分别检查

自检脚本读取：

```bash
openclaw plugins inspect openclaw-exporter-to-langfuse --runtime --json
```

必须同时满足：

- 插件 loaded、enabled、activated。
- `plugin.hookCount === 8`，`typedHooks` 包含全部 8 个必需 hook。
- `diagnostics` 无 blocked 提示或 error；无效 JSON、字段缺失或 CLI 失败同样判为失败。

必需 hook：`llm_input`、`llm_output`、`agent_end`、`model_call_started`、`model_call_ended`、`before_tool_call`、`after_tool_call`、`before_message_write`。

**只有 5 个 hook 时，先查会话授权。** 即使插件显示 loaded/activated、服务已启动、Langfuse 端点可访问，`llm_input`、`llm_output`、`agent_end` 仍可能被宿主拦截，且没有明显 error 日志。本插件依靠 `llm_input` 开始根 span、`agent_end` 结束根 span，缺少这些 hook 就不能正常上报。

自检通过只证明运行时注册正确，不能证明数据已送达。再发一个会调用工具的真实请求，等待请求结束和批量上报，然后在对应 Langfuse 项目查看：

- 一条 `invoke_agent` trace 包含问题和最终答案。
- 每轮 `react_step` 下有 `model_call` 和对应工具节点。
- 模型输入、输出、token 用量以及工具参数、结果正确。
- 失败工具为 ERROR；0.2.1 还会在能唯一匹配调用时补录“不存在的工具”失败节点。

如要重新自检，在离线包根目录运行 `node ./check-runtime.mjs`。已完成的验证及限制见 [VALIDATION.md](./VALIDATION.md)。

## 可访问 npm 的机器：普通本地包安装

若运行机能访问 npm，不需要制作含依赖的目录包。将 `release/v0.2.1/` 整个目录拷贝过去，进入该目录后执行：

```bash
sha256sum -c SHA256SUMS
openclaw plugins install ./openclaw-exporter-to-langfuse-0.2.1.tgz
```

随后按第 4、5 节配置并运行 `bash ./install.sh`。不要把此流程称为完全离线安装。`install.sh` 也支持一个已经审核的本地 `.tgz` 参数，但只接受包文件，不接受目录或远程地址；它不下载 OSS 安装器，不替用户配置密钥，也不自动加 `--force`。

## 升级、回滚与卸载

升级前保留原配置、旧包及其安装路径，等运行中的 Agent 请求结束。新离线包解压到新的版本目录，按同样流程校验、`--link` 安装、配置、热重载和验收；如果已有同 ID 安装，确认提示后显式使用 `--force`。不要在网关正在使用的旧目录中直接覆盖 `node_modules` 或代码，也不要同时保留两个有效的同 ID 加载入口。

从普通包安装切换到 `--link` 后，通过 `openclaw plugins inspect` 核对实际来源路径、版本和诊断，确保没有旧 extension 路径重复加载。若宿主提示冲突，先保留配置和旧制品，查看 `openclaw plugins uninstall --help` 再清理旧安装记录，不要直接删除整个 extensions 目录。

回滚时重新指向保留的旧版本目录或安装旧包，恢复所需配置，再执行授权、自检和真实请求验证。历史 trace 不会因升级或回滚而重建。卸载仅针对本插件；本 fork 的旧 OSS 卸载脚本保持禁用。

命令依据：[OpenClaw 插件安装文档](https://docs.openclaw.ai/cli/plugins/install)、[固定版本 2026.11.5 的 CLI 源码](https://github.com/openclaw/openclaw/blob/v2026.11.5/src/cli/plugins-cli.ts)。宿主版本变化后需重新验证，不能直接套用本指南。
