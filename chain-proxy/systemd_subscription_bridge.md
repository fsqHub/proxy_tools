# subscription_bridge_server.js 的 systemd 自动拉起配置

## 1. 创建 systemd service 文件

在远程主机创建文件：`/etc/systemd/system/subscription-bridge.service`

```ini
[Unit]
Description=Subscription Bridge Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/the/parent_dir
ExecStart=/usr/bin/node /path/to/parent_dir/subscription_bridge_server.js start
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

## 2. 重新加载并启动服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now subscription-bridge.service
```

## 3. 查看状态与日志

```bash
systemctl status subscription-bridge.service --no-pager
journalctl -u subscription-bridge.service -f
```

## 4. 常用运维命令

```bash
sudo systemctl restart subscription-bridge.service
sudo systemctl stop subscription-bridge.service
sudo systemctl start subscription-bridge.service
```

## 说明

- 以上配置可实现：
  - 进程异常退出后自动重启（`Restart=always`）。
  - 主机重启后自动启动（`enable` 后生效）。
- 如果 `node` 路径不是 `/usr/bin/node`，请先用 `which node` 确认并替换 `ExecStart`。
