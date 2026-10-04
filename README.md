# code-review — 代码审核 agent

一个 DSH **agent preset**：只读代码审核。在 GUI 的「新任务 / 模式」里选中它，它就以审核员身份工作——给出分级缺陷清单、证据定位与可执行修复建议。

- preset id：`code-review`
- 预设名（GUI 显示）：**代码审核**
- 目标 profile：`$DSH_HOME/profiles/$DSH_PROFILE/cordis.patch.yml`（本机 GUI 为 `desktop`）

## 它由什么组成

DSH 里的「agent」= preset = 一组 Cordis 插件行（身份、工具、技能、压缩策略）。本 preset 的行：

| 行 | 作用 |
|---|---|
| `dsh-persona` | 审核员身份与纪律：结论必须落到 `文件:行号` 或真实命令输出、先自我反驳再上报、只读边界、报告输出契约 |
| `dsh-agent-instructions` | 读取仓库 `AGENTS.md` / `CLAUDE.md` 等约定（64 KiB 预算） |
| `dsh-tool-bash` / `dsh-tool-pwsh` | 跑测试、类型检查、lint、构建、`git diff`（按平台二选一） |
| `dsh-tool-fs` | `read` / `read_image` / `write` / `edit` |
| `dsh-tool-fs-search` | `glob` / `grep` |
| `dsh-tool-jobs` | 后台任务（长测试、构建） |
| `dsh-skill-filesystem` + `dsh-tool-skill` | 按需加载 `skills/code-review/SKILL.md` 的深度审核清单 |
| `dsh-compaction-basic` + `dsh-command-compact` + `dsh-compaction-tool-result-pruner` | 长审核会话的压缩与工具结果裁剪 |
| `dsh-tool-todo` / `dsh-tool-ask-user` / `dsh-tool-web` / `dsh-tool-present` | 进度、提问、外部资料核对、把报告作为文件卡片交付 |

身份文本常驻系统提示；深度清单放在技能里按需加载——既保证纪律始终生效，又不必每次请求都付全量清单的 token。

## 安装

```bash
cd code-review-agent
./install.sh            # 安装到 $DSH_HOME/profiles/$DSH_PROFILE（DSH 终端里即 desktop）
./install.sh status     # 是否已安装
./install.sh verify     # 校验片段 + 已安装文件（+ CLI 可组合时打印组合结果）
./install.sh uninstall  # 卸载（保留备份）
DSH_PROFILE=web ./install.sh install   # 指定另一个 profile
```

安装顺序：校验片段 → 备份目标文件（`<target>.bak.<时间戳>` 与 `backup/`）→ 原子替换哨兵块之间的内容。重复执行是幂等的，只会替换标记块，不动文件里的其它内容。

`code-review-agent` 目录可以整体搬走：片段里的 `__SKILLS_DIR__` 由 `install.sh` 在安装时替换为当前绝对路径，移动后重新运行 `./install.sh` 即可。

## 使用

1. GUI 里新任务时选择 **代码审核**（设置 → Agent presets 里能看到它，也可以「View configuration」查看它的组合 YAML）。
2. 直接给范围即可，例如：
   - `审核这次改动（相对 main）`
   - `审核 src/parser/ 下的实现，重点看错误处理和并发`
   - `这个 PR 有什么风险`
3. 输出：先给能否合入的结论，再按 **阻塞 / 重要 / 次要 / 建议** 分级列出问题（每条含位置、失败场景、证据、修复建议），最后给存疑项与未覆盖范围；没有问题会直说。
4. 建议在会话里选一个强模型——审核质量对模型敏感。
5. 本 preset 是「提示层只读」：persona 要求不修改文件、不提交；如果还想在权限层收紧，可在会话的 Permissions 预设里选择更严格的沙箱/审批档位。审核本身不需要写权限。

## 验证

本次安装已核实（2026-10-04）：

- 应用运行时为 `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.2**（与 CLI 同版本线），preset 引用的 18 个插件包在该运行时内全部存在；片段与安装后的文件都通过 `verify.mjs`。
- 写入前后对比：除追加的标记块外，`cordis.patch.yml` **无任何行被修改或删除**（`diff` 只有新增行）。
- profile patch 是多个写入方共享的文件：官方写入路径是「按 id 读改写 + 原子替换」，无关条目会被保留（已观察到既有的 `insert`（chrome-devtools MCP）行在应用多次重写后仍然存在）；本次安装后文件的 marker 与 preset 行各 1 处，mtime/hash 稳定。
- 仍需人工确认的一步：GUI「设置 → Agent presets」列表中出现 **代码审核** 卡片。该 profile 由应用独占管理，CLI 无法组合校验，故以 GUI 为准。

- `node verify.mjs [file]`：离线校验。检查 YAML（含 `!!js` 标签）、preset 声明能否通过 `@deepseek-ai/dsh-agent-preset` 自己的 schema、每个子行引用的包是否存在、每个插件的 `config` 能否通过该插件自己的 `Config` schema、未知配置键（DSH 运行时会静默保留，这里直接判失败以拦住拼写错误）、以及 `customSkillDirs` 指向的技能是否有合法 frontmatter。传片段路径或整个 profile patch 文件都可以。
- `./install.sh verify`：额外确认标记块存在、已安装文件可解析。
- 关于 `desktop` profile：它由 Electron 应用独占管理，`dsh --profile desktop --dump-config` 会被拒绝，因此该 profile 以 GUI 的预设列表为准；`web` 等 CLI profile 会打印真实组合结果。
- 若 GUI 里没出现：确认 profile 的 patch 文件里仍有标记块（`./install.sh status`），并重启应用；应用设置变更若意外覆盖了该块，重新 `./install.sh install` 即可。

## 回滚

```bash
./install.sh uninstall
# 或直接还原备份：
cp backup/desktop-cordis.patch.yml.<时间戳> ~/.dsh/profiles/desktop/cordis.patch.yml
```

## 设计边界（已知取舍）

- **只读是提示层约束**：`dsh-tool-fs` 不拆分读写，preset 里仍有 `write`/`edit`。要硬隔离，用 Permissions 预设或沙箱模式。
- **未包含**：subagent/workflow 委派、goal、plan-mode、MCP。大仓库并行审核可在 `plugins` 里加 `delegation` 组（参考 `dsh-web-app/presets/standard.patch.yml`）。
- **技能目录是绝对路径**：片段里的 `__SKILLS_DIR__` 由安装脚本注入；手工编辑片段时记得替换。
- **profile patch 是应用也会写的共享文件**：本 preset 以一个顶层 `insert` 行加进去（与已有 MCP insert 同级），应用按 id 读改写其它行时不会影响它；但应用大版本升级后建议跑一次 `./install.sh verify`。

## 文件

| 文件 | 说明 |
|---|---|
| [`preset-code-review.yml`](preset-code-review.yml) | 唯一的 patch 片段（事实来源） |
| [`skills/code-review/SKILL.md`](skills/code-review/SKILL.md) | 深度审核清单（9 个维度 + 分级标准 + 反模式） |
| [`verify.mjs`](verify.mjs) | 离线校验器 |
| [`install.sh`](install.sh) | 安装 / 卸载 / 状态 / 验证 |
| `backup/` | 每次改写前的目标文件副本 |
