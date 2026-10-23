该插件是vibe项目，给苏科大学生快速完成内网电子仿真实验室（lbwedu智慧实验室）中的实验的，下载插件后直接开新对话告诉dsh要做哪个实验即可。插件不保存账号密码，纯靠苏科大的自动登录，所以等身份验证平台出来之后记得登录一下进入实验室。这个实验室超级卡，虽然理论上可以在后台挂着去干别的，但是不建议，如果没有一直开着浏览器界面会掉线很频繁甚至掉登录，掉线之后dsh可能会强行跳出刷新界面，所以建议一直开着浏览器界面。

# dsh-plugin-ibwedu-lab

一个 DeepSeek Harness (DSH) Host 插件：把「苏科大 Ibwedu 智慧实验室」的网页操作、noVNC 虚拟机操作和实验手册 PDF 读取封装成 6 个工具，让 DSH 能在对话里直接完成实验。

## 安装

npm（如果已发布）：

```bash
npm install dsh-plugin-ibwedu-lab
```

在 DSH 里安装（推荐）：

```text
plugin_manager action=install_bundle target=dsh-plugin-ibwedu-lab
```

本地开发时可以直接指向源码目录：

```text
plugin_manager action=install_bundle target=D:\path\to\dsh-plugin-usts-lbwedu-exp-automation
```

安装后**重启一次 DSH**，新对话即可看到 `lab_*` 工具。

## 使用

新开一个对话，直接说要做哪个实验，例如：

```text
做实验3
```

助手会按「加载实验 → 读手册 → 打开虚拟机 → 写代码 → 运行 → 截图 → 完成实验」的流程操作。

首次使用需要：

1. 打开 DSH 使用的 Edge 窗口，在统一身份认证 / Ibwedu 平台登录一次；
2. 保持这个浏览器窗口开着（可以最小化，但不要关）；
3. 若要使用后台 CDP 模式，先运行 `scripts/start-edge-cdp.ps1`，让 Edge 带 `--remote-debugging-port=9222` 启动（脚本会用独立 profile，避免和日常 Edge 冲突）。

## 工具

| 工具 | 作用 |
|---|---|
| `lab_session` | 直连实验虚拟机的 RFB/VNC（`connect` / `status` / `disconnect` / `discover`），按实验页给出的端口自动解析 |
| `lab_shot` | 截取虚拟机画面，支持 `crop` / `maxSide` / `save` / `diff` |
| `lab_act` | 批量键鼠动作（`click` / `type` / `key` / `paste` / `wheel` 等），一次调用完成一串操作 |
| `lab_platform` | Windows UI Automation 操作平台页面：切标签、点击、输入、找按钮、完成实验；也可打开网关 noVNC 页面 |
| `lab_browser` | 通过 Chrome DevTools Protocol 后台操作 Edge：截图、读 DOM、点击、输入，不需要把 Edge 切到前台 |
| `lab_pdf` | 读取实验手册 PDF 文本 / 渲染页面为图片 |

## 架构

```
DSH 对话
  └─ plugin.js  (注册 6 个 tool，inject = ["tools"])
       ├─ rfb.js      RFB 3.8 over WebSocket + 纯 JS DES + 自带 PNG 编码（无 npm 依赖）
       ├─ cdp.js      Chrome DevTools Protocol 客户端（后台截图 / 点击 / 输入 / Runtime.evaluate）
       ├─ platform.js 调用 scripts/platform.ps1（UIA + SendKeys + 屏幕截图，UTF-8 BOM）
       └─ pdf.js      Python + PyMuPDF（读取手册 PDF）
```

- **虚拟机层**：优先直连内网 VNC（RFB 3.8，WebSocket 传输）；Web VPN 网关形态下改用浏览器里的 noVNC，通过 CDP 把画布坐标点击 / 键盘事件送进虚拟机。
- **平台层**：`lab_platform` 用 Windows UI Automation 定位按钮、切换标签、读取页面文本，不依赖屏幕坐标；`lab_browser` 则直接和渲染进程通信，适合后台批量操作。
- **手册层**：`lab_pdf` 用 PyMuPDF 抽取文本 / 渲染页面，便于把实验步骤读出来。
- **无账号密码**：插件不保存任何账号、密码或 token；平台登录完全依赖浏览器里已有的统一身份认证会话。VNC 密码只从参数或环境变量读取（`IBWEDU_VNC_HOST` / `IBWEDU_VNC_PASSWORD`）。

## 环境要求

- Windows（平台操作依赖 UIA/SendKeys）
- Node.js >= 22（DSH 宿主即可）
- Microsoft Edge，且已登录学校统一身份认证 / Ibwedu 平台
- 使用 `lab_browser` 时：Edge 以 `--remote-debugging-port=9222` 启动（见 `scripts/start-edge-cdp.ps1`）
- 使用 `lab_pdf` 时：Python 3 + PyMuPDF

## 隐私与安全

- 仓库不包含实验截图、实验报告、课程内容、账号、密码、token、内网 IP 或本机路径。
- 平台登录状态保存在你自己的 Edge profile 里，插件只使用、不导出。
- 调试输出仅包含页面文本、坐标和工具结果；不会写入凭据。

## 已知限制

- Ibwedu 平台本身很卡，长时间不操作会掉线甚至掉登录，建议保持浏览器窗口开着。
- 平台 DOM 会随版本变化，`lab_platform` / `lab_browser` 的按钮文本与选择器可能需要小幅调整。
- `lab_platform` 的键鼠操作需要 Edge 在前台；`lab_browser` 可在后台工作，但要求 Edge 开着 CDP 端口。
- 实验虚拟机目录号与课程实验号可能不同（例如课程实验 4 对应 `exp05`），以实验手册为准。

## 开发

```bash
node test/des.test.mjs
node test/png.test.mjs
node test/endpoint.test.mjs
node test/rfb.test.mjs   # 本地 mock websockify + VNC，不需要实验网络
node test/apply.test.mjs
node test/cordis.test.mjs
```

