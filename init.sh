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

echo -n "检查 E2E 普通账号... "
if [ -n "$E2E_TEST_EMAIL" ] && [ -n "$E2E_TEST_PASSWORD" ]; then
    echo -e "${GREEN}✓ 已从当前 shell 注入${NC}"
elif grep -q "^E2E_TEST_EMAIL=" apps/web/.env 2>/dev/null || grep -q "^E2E_TEST_EMAIL=" apps/web/.env.local 2>/dev/null || grep -q "^E2E_TEST_EMAIL=" .env 2>/dev/null || grep -q "^E2E_TEST_EMAIL=" .env.local 2>/dev/null; then
    echo -e "${GREEN}✓ 已在本地 env 文件中声明${NC}"
else
    echo -e "${YELLOW}⚠ 未配置，关键用户巡检会自动跳过已登录流程${NC}"
fi

echo -n "检查 E2E 管理员账号... "
if [ -n "$E2E_ADMIN_EMAIL" ] && [ -n "$E2E_ADMIN_PASSWORD" ]; then
    echo -e "${GREEN}✓ 已从当前 shell 注入${NC}"
elif grep -q "^E2E_ADMIN_EMAIL=" apps/web/.env 2>/dev/null || grep -q "^E2E_ADMIN_EMAIL=" apps/web/.env.local 2>/dev/null || grep -q "^E2E_ADMIN_EMAIL=" .env 2>/dev/null || grep -q "^E2E_ADMIN_EMAIL=" .env.local 2>/dev/null; then
    echo -e "${GREEN}✓ 已在本地 env 文件中声明${NC}"
else
    echo -e "${YELLOW}⚠ 未配置，管理后台巡检会自动跳过管理员流程${NC}"
fi

# --- 5. 检查 dev server ---
echo ""
echo -n "检查 dev server... "
if curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 已运行在 http://localhost:3000${NC}"
else
    echo -e "${YELLOW}⚠ 未运行${NC}"
    echo -e "${YELLOW}  → 请运行: pnpm dev 或 npm run dev${NC}"
fi

if [ -f "apps/web/package.json" ] && grep -q '"test:e2e:critical"' apps/web/package.json 2>/dev/null; then
    echo -e "${GREEN}  → 关键巡检命令: pnpm --dir apps/web test:e2e:critical${NC}"
    echo -e "${YELLOW}  → 首次运行如缺少浏览器，请执行: pnpm --dir apps/web exec playwright install chromium${NC}"
fi

# --- 结果 ---
echo ""
echo "========================================"
if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✓ 本地环境检查完成；本脚本仅检查本地环境。开始仓库工作前仍须按当前 staging 的 AGENTS.md fresh-read GitHub live state 与 Owner 授权；本脚本本身不构成执行授权。${NC}"
else
    echo -e "${RED}✗ 存在问题，请先修复上述错误${NC}"
fi
echo "========================================"
echo ""
