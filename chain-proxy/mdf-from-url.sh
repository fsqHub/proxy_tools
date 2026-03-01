#!/usr/bin/env sh

set -eu

# ------------------------------------------------------------------------------
# 脚本名称: modify_proxy.sh
# 功能概述:
# 1) 从 Clash 订阅链接 A 下载 YAML 配置（不改订阅源内容）。
# 2) 新增一个 socks5 链式代理节点（dialer-proxy 指向“自动选择”类代理组）。
# 3) 将新增节点插入到顶层 proxies: 列表的最前面（第一个节点）。
# 4) 将新增节点名称追加到第一个 proxy-group 的 proxies: 列表中（作为第一项）。
# 5) 生成一个新的 YAML 文件输出。
#
# 使用方式:
# - 手动填写下方变量 SUBSCRIPTION_URL_A 和 NEW_PROXY_INFO。
# - 执行: sh modify_proxy.sh
#
# 输入变量说明:
# - SUBSCRIPTION_URL_A: Clash 订阅链接 A（http/https）。
# - NEW_PROXY_INFO: 新增节点信息，格式必须为 IP:PORT:USER:PASSWORD
#
# 输出说明:
# - 默认输出为 ./subscription.with-chain.yaml
# - 可通过 OUTPUT_YAML_PATH 手动指定输出路径。
# ------------------------------------------------------------------------------

# ===== 用户手动填写 =====
SUBSCRIPTION_URL_A="" # 例如: https://example.com/clash-subscription
NEW_PROXY_INFO=""     # 格式: IP:PORT:USER:PASSWORD
# ======================

# 新增节点名称（可修改，但必须保证在原 YAML 中不存在同名节点）
NEW_NODE_NAME="PrivateProxy"

# 留空则使用默认输出路径
OUTPUT_YAML_PATH=""

# 统一错误输出并退出
fail() {
  echo "ERROR: $1" >&2
  exit 1
}

TMP_SOURCE_FILE=""
TMP_OUTPUT_FILE=""

# 清理脚本运行时创建的临时文件
cleanup() {
  [ -n "$TMP_SOURCE_FILE" ] && [ -f "$TMP_SOURCE_FILE" ] && rm -f "$TMP_SOURCE_FILE"
  [ -n "$TMP_OUTPUT_FILE" ] && [ -f "$TMP_OUTPUT_FILE" ] && rm -f "$TMP_OUTPUT_FILE"
}
trap cleanup EXIT INT TERM

download_subscription() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 90 "$SUBSCRIPTION_URL_A" -o "$TMP_SOURCE_FILE" || fail "下载订阅失败（curl）"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$TMP_SOURCE_FILE" "$SUBSCRIPTION_URL_A" || fail "下载订阅失败（wget）"
    return
  fi

  fail "缺少下载工具，请安装 curl 或 wget"
}

# 基础输入校验
[ -n "$SUBSCRIPTION_URL_A" ] || fail "请先设置 SUBSCRIPTION_URL_A"
[ -n "$NEW_PROXY_INFO" ] || fail "请先设置 NEW_PROXY_INFO (IP:PORT:USER:PASSWORD)"
echo "$SUBSCRIPTION_URL_A" | grep -Eq '^https?://' || fail "SUBSCRIPTION_URL_A 必须是 http/https 链接"

old_ifs=$IFS
IFS=":"
set -- $NEW_PROXY_INFO
IFS=$old_ifs
[ "$#" -eq 4 ] || fail "NEW_PROXY_INFO 格式错误，应为 IP:PORT:USER:PASSWORD"

IP=$1
PORT=$2
PROXY_USER=$3
PROXY_PASSWORD=$4

echo "$PORT" | grep -Eq '^[0-9]+$' || fail "PORT 必须是数字"

# 未指定输出路径时使用默认新文件名，确保不改订阅源和原始内容
if [ -z "$OUTPUT_YAML_PATH" ]; then
  OUTPUT_YAML_PATH="./subscription.with-chain.yaml"
fi

# 下载订阅 A 到临时文件，再基于临时文件进行改造
TMP_SOURCE_FILE=$(mktemp 2>/dev/null || mktemp -t clash_sub_yaml)
download_subscription

SOURCE_YAML_PATH="$TMP_SOURCE_FILE"

grep -Eq '^proxies:[[:space:]]*$' "$SOURCE_YAML_PATH" || fail "订阅内容中未找到 proxies 段"
grep -Eq '^proxy-groups:[[:space:]]*$' "$SOURCE_YAML_PATH" || fail "订阅内容中未找到 proxy-groups 段"

# 优先匹配名称包含“自动选择”的代理组；找不到时，回退到 url-test/fallback/load-balance 类型组。
DIALER_GROUP=$(
  awk '
    BEGIN {
      in_groups = 0
      current_name = ""
      by_name = ""
      by_type = ""
    }
    /^proxy-groups:[[:space:]]*$/ { in_groups = 1; next }
    in_groups && /^[^[:space:]]/ { in_groups = 0 }
    !in_groups { next }
    /^  - name:[[:space:]]*/ {
      current_name = $0
      sub(/^  - name:[[:space:]]*/, "", current_name)
      gsub(/^["'\'']|["'\'']$/, "", current_name)
      if (by_name == "" && current_name ~ /自动选择/) {
        by_name = current_name
      }
      next
    }
    /^    type:[[:space:]]*/ {
      t = $0
      sub(/^    type:[[:space:]]*/, "", t)
      gsub(/^["'\'']|["'\'']$/, "", t)
      if (by_type == "" && (t == "url-test" || t == "fallback" || t == "load-balance") && current_name != "") {
        by_type = current_name
      }
      next
    }
    END {
      if (by_name != "") {
        print by_name
      } else if (by_type != "") {
        print by_type
      }
    }
  ' "$SOURCE_YAML_PATH"
)

[ -n "$DIALER_GROUP" ] || fail "未找到可用的自动选择代理组（name 包含“自动选择”或 type 为 url-test/fallback/load-balance）"

if awk -v target="$NEW_NODE_NAME" '
  /^  - name:[[:space:]]*/ {
    n = $0
    sub(/^  - name:[[:space:]]*/, "", n)
    gsub(/^["'\'']|["'\'']$/, "", n)
    if (n == target) {
      found = 1
    }
  }
  END { exit(found ? 0 : 1) }
' "$SOURCE_YAML_PATH"; then
  fail "节点名已存在: $NEW_NODE_NAME，请修改 NEW_NODE_NAME"
fi

TMP_OUTPUT_FILE=$(mktemp 2>/dev/null || mktemp -t chain_proxy)

# 一次扫描完成两件事:
# 1) 在顶层 proxies: 后插入新节点（因此该节点位于 proxies 列表最前面）。
# 2) 在第一个 proxy-group 的 proxies: 后插入新节点名（作为第一项）。
awk \
  -v q_name="$NEW_NODE_NAME" \
  -v q_ip="$IP" \
  -v port="$PORT" \
  -v q_user="$PROXY_USER" \
  -v q_password="$PROXY_PASSWORD" \
  -v q_dialer="$DIALER_GROUP" \
  '
    BEGIN {
      inserted_proxy_node = 0
      inserted_first_group_ref = 0
      in_groups = 0
      seen_first_group = 0
      in_first_group = 0
    }
    {
      # 顶层 proxies: 段开始，先输出该行，再立即插入节点，确保位于列表首位。
      if (!inserted_proxy_node && $0 ~ /^proxies:[[:space:]]*$/) {
        print $0
        print "  - name: " q_name
        print "    type: socks5"
        print "    server: " q_ip
        print "    port: " port
        print "    username: " q_user
        print "    password: " q_password
        print "    dialer-proxy: " q_dialer
        inserted_proxy_node = 1
        next
      }

      # 进入 proxy-groups 顶层段
      if ($0 ~ /^proxy-groups:[[:space:]]*$/) {
        in_groups = 1
      } else if (in_groups && $0 ~ /^[^[:space:]]/) {
        # 离开 proxy-groups 顶层段前，如第一个组缺少 proxies 字段，则兜底补上
        if (in_first_group && !inserted_first_group_ref) {
          print "    proxies:"
          print "      - " q_name
          inserted_first_group_ref = 1
        }
        in_groups = 0
        in_first_group = 0
      }

      if (in_groups) {
        # 锁定第一个代理组
        if (!seen_first_group && $0 ~ /^  - name:[[:space:]]*/) {
          seen_first_group = 1
          in_first_group = 1
        } else if (seen_first_group && in_first_group && $0 ~ /^  - name:[[:space:]]*/) {
          # 即将进入第二个组，若第一个组未找到 proxies 字段，兜底补充后结束第一个组处理
          if (!inserted_first_group_ref) {
            print "    proxies:"
            print "      - " q_name
            inserted_first_group_ref = 1
          }
          in_first_group = 0
        }

        # 在第一个组的 proxies: 后立刻插入该节点，确保在该组内也是第一项
        if (in_first_group && !inserted_first_group_ref && $0 ~ /^    proxies:[[:space:]]*$/) {
          print $0
          print "      - " q_name
          inserted_first_group_ref = 1
          next
        }
      }

      print $0
    }
    END {
      if (!inserted_proxy_node || !inserted_first_group_ref) {
        exit 2
      }
    }
  ' "$SOURCE_YAML_PATH" > "$TMP_OUTPUT_FILE" || {
    rm -f "$TMP_OUTPUT_FILE"
    TMP_OUTPUT_FILE=""
    fail "生成新 YAML 失败（可能未正确识别 proxies 或第一个 proxy-group）"
  }

mv "$TMP_OUTPUT_FILE" "$OUTPUT_YAML_PATH"
TMP_OUTPUT_FILE=""

echo "完成: 已生成 $OUTPUT_YAML_PATH"
echo "dialer-proxy 使用代理组: $DIALER_GROUP"
