#!/bin/bash
# 自动同步远程代码并重启开发服务器
# 用法: ./scripts/dev-watch.sh

BRANCH=$(git branch --show-current)

echo "🔄 启动开发服务器 (自动同步模式)"
echo "📌 当前分支: $BRANCH"
echo "💡 按 Ctrl+C 停止"
echo ""

# 启动开发服务器（后台）
pnpm dev &
DEV_PID=$!

# 清理函数
cleanup() {
  echo ""
  echo "🛑 停止开发服务器..."
  kill $DEV_PID 2>/dev/null
  exit 0
}

trap cleanup SIGINT SIGTERM

# 每 10 秒检查远程更新
while true; do
  sleep 10

  # 获取远程更新
  git fetch origin $BRANCH --quiet 2>/dev/null

  # 检查是否有新提交
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse origin/$BRANCH 2>/dev/null)

  if [ "$LOCAL" != "$REMOTE" ] && [ -n "$REMOTE" ]; then
    echo ""
    echo "📥 检测到新代码，正在同步..."
    git pull origin $BRANCH --quiet
    echo "✅ 代码已同步，开发服务器将自动重载"
  fi
done
