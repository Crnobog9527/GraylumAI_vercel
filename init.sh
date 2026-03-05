#!/bin/bash

# =============================================================================
# init.sh - GraylumAI 环境初始化脚本
# =============================================================================
# 每次新 session 开始时运行，确保开发环境正确就绪。
# 用法: ./init.sh
# =============================================================================

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "========================================"
echo "  GraylumAI 环境初始化"
echo "========================================"
echo ""

FAIL=0

# --- 1. 检查 Node.js ---
echo -n "检查 Node.js... "
if command -v node &> /dev/null; then
    echo -e "${GREEN}✓ $(node -v)${NC}"
else
    echo -e "${RED}✗ 未安装 Node.js${NC}"
    FAIL=1
fi

# --- 2. 检查 pnpm ---
echo -n "检查 pnpm... "
if command -v pnpm &> /dev/null; then
    echo -e "${GREEN}✓ $(pnpm -v)${NC}"
else
    echo -e "${RED}✗ 未安装 pnpm${NC}"
    FAIL=1
fi

# --- 3. 检查 .env 文件 ---
echo -n "检查 .env 文件... "
if [ -f "apps/web/.env" ] || [ -f "apps/web/.env.local" ] || [ -f ".env" ]; then
    echo -e "${GREEN}✓ 存在${NC}"
else
    echo -e "${RED}✗ 缺少 .env 文件${NC}"
    echo -e "${YELLOW}  → 请复制 .env.example 并填写必要配置${NC}"
    FAIL=1
fi

# --- 4. 检查关键环境变量 ---
echo -n "检查 SUPABASE_URL... "
if [ -n "$NEXT_PUBLIC_SUPABASE_URL" ] || grep -q "NEXT_PUBLIC_SUPABASE_URL" apps/web/.env 2>/dev/null || grep -q "NEXT_PUBLIC_SUPABASE_URL" apps/web/.env.local 2>/dev/null || grep -q "NEXT_PUBLIC_SUPABASE_URL" .env 2>/dev/null; then
    echo -e "${GREEN}✓ 已配置${NC}"
else
    echo -e "${YELLOW}⚠ 未检测到（可能在 Vercel 环境变量中）${NC}"
fi

# --- 5. 安装依赖 ---
echo ""
echo "安装依赖..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# --- 6. 检查 task.json ---
echo ""
echo -n "检查 task.json... "
if [ -f "task.json" ]; then
    REMAINING=$(grep -c '"passes": false' task.json 2>/dev/null || echo "0")
    TOTAL=$(grep -c '"passes"' task.json 2>/dev/null || echo "0")
    DONE=$((TOTAL - REMAINING))
    echo -e "${GREEN}✓ ${DONE}/${TOTAL} 任务已完成，${REMAINING} 项待处理${NC}"
else
    echo -e "${YELLOW}⚠ task.json 不存在${NC}"
fi

# --- 7. 启动 dev server ---
echo ""
echo -n "检查 dev server... "
if curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 已运行在 http://localhost:3000${NC}"
else
    echo -e "${YELLOW}⚠ 未运行${NC}"
    echo -e "${YELLOW}  → 请运行: pnpm dev 或 npm run dev${NC}"
fi

# --- 结果 ---
echo ""
echo "========================================"
if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✓ 环境初始化完成，可以开始工作${NC}"
else
    echo -e "${RED}✗ 存在问题，请先修复上述错误${NC}"
fi
echo "========================================"
echo ""
