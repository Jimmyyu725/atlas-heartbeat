# Atlas Heartbeat

把 Atlas 的实时系统状态变成一颗会呼吸的互动星球。

CPU 会改变星球自转与呼吸速度，内存会改变核心光，磁盘占用会闭合外环，系统负载则决定星尘密度。页面只读，不会更改服务器状态；点击星球或“发送一次脉冲”只是触发视觉效果。

## 启动

项目只需要 Python 3.10 或更高版本，不需要安装第三方依赖。

```bash
cd /home/jingtianyu/projects/atlas-heartbeat
python3 -m atlas_heartbeat --port 8765
```

然后在 Atlas 上访问 `http://127.0.0.1:8765`。从自己的电脑查看时，保持服务绑定在回环地址，并通过现有 Atlas SSH 连接建立端口转发：

```bash
ssh -L 8765:127.0.0.1:8765 atlas-ewr
```

浏览器仍打开 `http://127.0.0.1:8765`。如果本机 SSH 配置使用不同的 Atlas 别名，请替换命令最后一项。

## 操作

- 点击星球、按 Enter/空格，或点击“发送一次脉冲”，会发出一圈视觉脉冲。
- 打开“静谧模式”，会暂停轨道与呼吸并减弱星尘。
- 系统启用“减少动态效果”时，页面会自动尊重该设置。
- 页面每 2 秒更新一次；信号中断时保留最后一次有效数据并自动重试。

## 测试

```bash
python3 -m unittest discover -s tests -v
node --test tests/state.test.mjs
node --check web/app.js
```

先启动服务后，可执行真实 Chrome 交互检查：

```bash
node scripts/verify_browser.mjs http://127.0.0.1:8765/
```

该检查会验证真实指标、六张遥测卡、桌面与手机无横向溢出、按钮脉冲、键盘脉冲、静谧模式和浏览器错误，并把截图写入 `/tmp/atlas-heartbeat-verified-desktop.png` 与 `/tmp/atlas-heartbeat-verified-mobile.png`。

## 只读边界

- 服务默认只监听 `127.0.0.1`。
- 仅允许 GET 与 HEAD；写请求返回 405。
- API 只暴露聚合系统指标，不返回进程、网络连接、文件内容或凭据。
- 静态文件路径经过根目录约束，无法通过 URL 读取项目外文件。
- 备份卡只读取 `atlas-restic-backup.timer` 状态，不启动、停止或修改计时器。

设计说明与逐步实施记录位于 `docs/superpowers/`。
