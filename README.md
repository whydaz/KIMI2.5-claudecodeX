# claude-code-sourcemap

[![linux.do](https://img.shields.io/badge/linux.do-huo0-blue?logo=linux&logoColor=white)](https://linux.do)

> [!WARNING]
> This repository is **unofficial** and is reconstructed from the public npm package and source map analysis, **for research purposes only**.
> It does **not** represent the original internal development repository structure.
>
> 本仓库为**非官方**整理版，基于公开 npm 发布包与 source map 分析还原，**仅供研究使用**。
> **不代表**官方原始内部开发仓库结构。
> 一切基于L站"飘然与我同"的情报提供

## 概述

本仓库通过 npm 发布包（`@anthropic-ai/claude-code`）内附带的 source map（`cli.js.map`）还原的 TypeScript 源码，版本为 `2.1.88`。

## 来源

- npm 包：[@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- 还原版本：`2.1.88`
- 还原文件数：**4756 个**（含 1884 个 `.ts`/`.tsx` 源文件）
- 还原方式：提取 `cli.js.map` 中的 `sourcesContent` 字段

## 目录结构

```
restored-src/src/
├── main.tsx              # CLI 入口
├── tools/                # 工具实现（Bash、FileEdit、Grep、MCP 等 30+ 个）
├── commands/             # 命令实现（commit、review、config 等 40+ 个）
├── services/             # API、MCP、分析等服务
├── utils/                # 工具函数（git、model、auth、env 等）
├── context/              # React Context
├── coordinator/          # 多 Agent 协调模式
├── assistant/            # 助手模式（KAIROS）
├── buddy/                # AI 伴侣 UI
├── remote/               # 远程会话
├── plugins/              # 插件系统
├── skills/               # 技能系统
├── voice/                # 语音交互
└── vim/                  # Vim 模式
```

## KIMI2.5 部署

Open-source Claude Code with KIMI2.5 backend support. Simply enter your KIMI API KEY to complete deployment.

### 1. 配置 API Key

在项目根目录创建 `.env` 文件（该文件已被 `.gitignore` 忽略，不会提交到仓库）：

```
KIMI_API_KEY=sk-your-kimi-api-key-here
```

> 可参考 `.env.example` 模板。API Key 从 [Moonshot AI 开放平台](https://platform.moonshot.cn/) 获取。

### 2. 启动

确保已安装 **Node.js >= 18**，然后在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File start-claudecodeX.ps1
```

脚本会自动：
1. 从 `.env` 读取 `KIMI_API_KEY`
2. 启动本地 Anthropic → Kimi 协议转换代理（端口 4010）
3. 启动 claudecodeX CLI（`--bare --dangerously-skip-permissions` 模式）

### 截图

<img width="485" height="193" alt="image" src="https://github.com/user-attachments/assets/483db6a1-76ee-4317-9566-9b7b543ffc3b" />

<img width="1044" height="88" alt="image" src="https://github.com/user-attachments/assets/3eda8577-3d46-46d8-89c7-c74fa8fb4768" />

<img width="827" height="363" alt="image" src="https://github.com/user-attachments/assets/33145d38-3bf8-4e97-a69c-6c2d04497f74" />



## 声明

- 源码版权归 [Anthropic](https://www.anthropic.com) 所有
- 本仓库仅用于技术研究与学习，请勿用于商业用途
- 如有侵权，请联系删除
