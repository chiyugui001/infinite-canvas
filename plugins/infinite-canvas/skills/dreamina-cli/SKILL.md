---
name: dreamina-cli
description: 使用本机已经登录的即梦 Dreamina CLI 查询账号、管理任务以及生成图片或视频；在 Infinite Canvas 中可把 CLI 下载的媒体导入当前画布。
---

# 即梦 CLI

优先使用 `DREAMINA_CLI_PATH` 指定的入口或 PATH 中的 `dreamina`。Windows 默认安装位置为：

```text
%USERPROFILE%\Documents\Codex\bin\dreamina.cmd
```

调用前先运行对应子命令的 `-h`，以 CLI 当前帮助为准，不要硬编码模型、尺寸或参数。

## 安全边界

- 即梦 CLI 明确说明所有生成操作都会消耗积分。提交任何图片或视频生成任务前，必须向用户说明将消耗积分并获得明确同意。
- 用户要求零积分测试时，只允许使用 `-h`、`version`、`user_credit`、`list_task`、`query_result` 等只读操作；不得运行生成子命令。
- 不显示或复制登录凭据、设备码、Token 等敏感信息。
- 复用现有登录状态，除非用户明确要求重新登录或退出。

## 工作流

1. 先解析可用 CLI 入口；PATH 不可用时再检查平台默认安装位置。
2. 生成前读取 `user_credit`，并在用户明确同意扣积分后才提交。
3. 异步任务只有在 `gen_status=success` 时才算成功；若仍为 `querying`，保存 `submit_id` 并继续调用 `query_result`。
4. 下载结果到本地绝对路径。
5. 在 Infinite Canvas 场景中，使用 `canvas_import_local_media` 把下载的图片、视频或音频导入当前画布。
