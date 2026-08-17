# dsh-plan-mode-enhanced

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（官方项目）的 **Plan 模式增强**插件，整合两个能力于一身：

1. **权限下拉加 Plan Mode 选项**：下拉框出现 `Read Only / Plan Mode / Workspace Write / Full access`，选 Plan Mode 真正进入计划模式（`plan/mode` 状态、`exit_plan_mode` 工具、计划审阅卡片全部可用），选其他项退出；通过 `/plan off` 或 `exit_plan_mode` 退出时自动恢复切换前的权限预设。
2. **计划审阅卡片增强**：官方审阅卡片只能"确认执行 / 拒绝 / 去聊天里说"，点"去聊天里说"计划内容就从界面消失；本插件让卡片保留完整计划正文 + **修改意见输入框**（提交后模型收到反馈并重写计划，再弹新卡片）+ 内置**右侧预览面板**。

**零外部依赖**：仅使用官方运行时提供的组件（`react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives` 等），不依赖任何第三方插件，官方仓库文件零改动。

---

## 功能

| 能力 | 说明 |
|---|---|
| 权限下拉 Plan Mode | 下拉出现 Plan Mode 选项，选择即进入真实计划模式（host 端事件桥接） |
| 预设自动恢复 | `/plan off` 或批准计划退出计划模式时，下拉自动恢复为切换前的权限预设 |
| 计划审阅卡片 | 与官方卡片同款观感：`计划待审` 条带 + Markdown 正文 |
| 修改意见反馈 | 卡片内输入框 + 提交；反馈经答案 `custom` 字段回传模型（官方 plan-mode 服务原生支持），模型收到 `their feedback: <文本>` 并重写计划 |
| 预览计划 | 卡片右上角"预览计划"按钮，右侧弹出内置面板完整渲染计划 Markdown（标题/列表/表格）；关闭按钮 / Esc / 点击遮罩均可关闭 |
| 三操作按钮 | 确认执行（批准退出计划模式）/ 拒绝（Keep planning）/ 去聊天里说（取消，与官方一致） |
| 隔离性 | 仅在 `plan-review` 交互时接管输入框；普通 `ask_user_question` 仍走官方问题流 |

## 安装

> 前提：已安装官方 DeepSeek Harness（`deepseek-harness` 项目，含 desktop / web 两种运行形态，本插件通用），且机器上有 Node.js（DSH 本身要求 Node ≥ 20）。

### 一键安装（推荐）

clone（或下载解压）本仓库到任意目录后，在该目录运行：

```
node install.mjs
```

脚本会自动完成全部安装：把插件链接进 `~/.dsh/profiles/desktop`（或检测到的 profile）的 `node_modules`，并追加 `cordis.patch.yml` 所需的全部配置（`permission` 预设表、`plan-mode` 重新启用、插件条目）。

- 指定其他 profile：`node install.mjs --profile web`
- **幂等**：重复运行安全，已装的部分自动跳过，不会产生重复条目
- **跨平台**：Windows 用 junction（无需管理员），macOS/Linux 用符号链接
- **与手动安装共存**：已手动装过则报告"已就绪"直接退出
- 每次修改 patch 前会先备份为 `cordis.patch.yml.bak-install-<时间戳>`

装完**重启 DeepSeek Harness** 生效。

### 手动安装（备选）

无法运行 Node 时，按以下三步手动操作：

1. **放置插件源码**：clone（或下载解压）本仓库到任意目录，例如 `~/dsh-work/dsh-plan-mode-enhanced`。
2. **链接进 profile 的 node_modules**：在目标 profile（如 `desktop` 或 `web`）的 `node_modules` 下创建 junction/软链接指向插件目录。
   Windows（junction）：
   ```
   mklink /J %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plan-mode-enhanced %USERPROFILE%\dsh-work\dsh-plan-mode-enhanced
   ```
   macOS / Linux（符号链接）：
   ```
   ln -s ~/dsh-work/dsh-plan-mode-enhanced ~/.dsh/profiles/desktop/node_modules/dsh-plan-mode-enhanced
   ```
3. **在 profile 的 `cordis.patch.yml` 注册**（追加）：
   ```yaml
   # Plan Mode 权限预设表（sandbox read-only + approval ask）
   - id: permission
     config:
       presets:
         read-only:
           sandbox: read-only
           approval: ask
         plan-mode:
           sandbox: read-only
           approval: ask
           name: Plan Mode
           description: Explore and design before presenting the complete plan through exit_plan_mode.
         workspace-write:
           sandbox: workspace-write
           approval: ask
         danger-full-access:
           sandbox: danger-full-access
           approval: never

   # web-app 组合默认禁用了 plan-mode 服务，需重新启用（否则桥接拿不到 planMode）
   - id: plan-mode
     disabled: false

   - insert:
       - id: plan-mode-enhanced
         name: 'dsh-plan-mode-enhanced'
   ```
4. **重启 DeepSeek Harness**（改 profile patch 需要重启加载）。

> 说明：上面的 `permission` 预设表和 `plan-mode disabled: false` 是**运行本插件必需的配套配置**（预设表定义下拉选项，`planMode` 服务是桥接与卡片的依赖），不是插件代码的一部分，需要留在 profile 层；`install.mjs` 会一次性写入。

## 使用

1. 权限下拉选 **Plan Mode**，进入计划模式（会话日志出现 `plan/mode active: true`）。
2. 给模型一个任务；模型探索后调用 `exit_plan_mode` 提交计划。
3. 卡片弹出：正文完整可见；想细读点右上角 **预览计划**（右侧面板，宽幅排版）。
4. 要改计划：在输入框写修改要求 → **提交修改意见** → 模型重写计划 → 再次弹卡（可再预览对比）。
5. 满意后点 **确认执行**，退出计划模式开始执行（下拉自动恢复原权限预设）；或 **拒绝** 让模型继续改；或 **去聊天里说** 切回聊天。

## 工作原理（简述）

- **权限桥接（host）**：监听 `session/event` 的 `permission/preset`，选 `plan-mode` 时 `setImmediate` 延迟调用 `ctx.planMode.set(agent, true)`（延迟避免 session append 重入）；`plan/mode` 退出时若下拉仍在 Plan Mode，恢复切换前预设。
- **审阅卡片（client）**：通过 `conversation.composer` 链式槽位以 `priority: -20` 抢先接管 `plan-review` 交互（官方卡片在 priority 0），其余问题返回 `null` 落回官方流程。
- **修改意见**：提交为 `{ id, selected: [], custom: <文本> }`——官方 `dsh-plan-mode` 对带 `custom` 的答案自动走 keep-planning 分支，模型收到反馈文本。
- **预览面板**：用官方 `MarkdownText` 直接渲染卡片内存中的计划文本，**不写文件、不注册任何后端路由**。

## 开发

- 无构建步骤：`client.js` 为手写 CJS bundle（`window.__ModuleLoader__` 格式），`index.js` 为纯 ESM host 入口，改完直接重启生效。
- 修改后检查语法：`node --check client.js` / `node --check index.js`。

## 许可

MIT
