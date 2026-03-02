# 注意
## 开启TUN模式代理时，ssh可能会失败，报错：
```shell
kex_exchange_identification: Connection closed by remote host
Connection closed by 198.18.0.7 port 22
```
解决方法：
1. 放行22端口（脚本中已实现）
```yaml
rules:
  - DST-PORT,22,DIRECT
  - SRC-PORT,22,DIRECT
```
2. 以全局模式代理tun模式

**说明**：
规则模式+tun时，rules规则仍然生效，与全局模式有所区别。