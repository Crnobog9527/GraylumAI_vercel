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

# --- 5. 安装依赖 ---
echo ""
echo "安装依赖..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# --- 6. 检查 task.json ---
echo ""
echo -n "检查三文件... "
MISSING_FILES=0
for file in task.json progress.md findings.md; do
    if [ ! -f "$file" ]; then
        MISSING_FILES=1
        break
    fi
done

if [ $MISSING_FILES -eq 0 ]; then
    echo -e "${GREEN}✓ task.json / progress.md / findings.md 已存在${NC}"
else
    echo -e "${RED}✗ 缺少三文件中的至少一个${NC}"
    echo -e "${YELLOW}  → 模板目录: docs/task-json-workflow-templates${NC}"
    FAIL=1
fi

echo -n "检查 task.json 结构... "
if [ -f "task.json" ]; then
    if command -v jq >/dev/null 2>&1; then
        if jq empty task.json >/dev/null 2>&1; then
            echo -e "${GREEN}✓ JSON 可解析${NC}"
        else
            echo -e "${RED}✗ task.json 不是合法 JSON${NC}"
            FAIL=1
        fi
    else
        if grep -q '"tasks"' task.json 2>/dev/null; then
            echo -e "${YELLOW}⚠ 未安装 jq，已跳过严格 JSON 校验${NC}"
        else
            echo -e "${RED}✗ 未检测到 tasks 字段${NC}"
            FAIL=1
        fi
    fi
else
    echo -e "${RED}✗ task.json 不存在${NC}"
    FAIL=1
fi

echo -n "检查任务进度... "
if [ -f "task.json" ] && command -v jq >/dev/null 2>&1 && jq empty task.json >/dev/null 2>&1; then
    TOTAL=$(jq '.tasks | length' task.json)
    DONE=$(jq '[.tasks[] | select(.passes == true)] | length' task.json)
    BLOCKED=$(jq '[.tasks[] | select(.blocked == true)] | length' task.json)
    REMAINING=$(jq '[.tasks[] | select(.passes != true and .blocked != true)] | length' task.json)
    echo -e "${GREEN}✓ ${DONE}/${TOTAL} 已完成，${REMAINING} 项可继续，${BLOCKED} 项阻塞${NC}"

    NEXT_TASK=$(jq -r '
      def prio_rank:
        if .priority == "P0" then 0
        elif .priority == "P1" then 1
        elif .priority == "P2" then 2
        elif .priority == "P3" then 3
        else 9 end;
      [.tasks[]
        | select(.passes != true and .blocked != true)
        | . + {prio_rank: prio_rank}]
      | sort_by(.step, .prio_rank, .id)
      | .[0]
      | if . == null then "" else "\(.id) |\(.title)| step \(.step) | \(.priority)" end
    ' task.json)

    if [ -n "$NEXT_TASK" ]; then
        echo -e "${GREEN}  → 建议下一项: ${NEXT_TASK}${NC}"
    fi

    FIRST_BLOCKED=$(jq -r '
      [.tasks[] | select(.blocked == true)][0]
      | if . == null then "" else "\(.id) |\(.title)| \(.block_reason // "blocked")" end
    ' task.json)

    if [ -n "$FIRST_BLOCKED" ]; then
        echo -e "${YELLOW}  → 当前阻塞示例: ${FIRST_BLOCKED}${NC}"
    fi
else
    if [ -f "task.json" ]; then
        REMAINING=$(grep -c '"passes": false' task.json 2>/dev/null || echo "0")
        TOTAL=$(grep -c '"passes"' task.json 2>/dev/null || echo "0")
        DONE=$((TOTAL - REMAINING))
        echo -e "${YELLOW}⚠ 使用回退统计: ${DONE}/${TOTAL} 已完成${NC}"
    else
        echo -e "${YELLOW}⚠ 无法统计${NC}"
    fi
fi

echo -n "检查 task_plan.md 状态... "
if [ -f "task_plan.md" ]; then
    echo -e "${YELLOW}⚠ 已存在，当前仅作为历史归档，不再作为计划源${NC}"
else
    echo -e "${GREEN}✓ 未发现旧计划文件${NC}"
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

if [ -f "apps/web/package.json" ] && grep -q '"test:e2e:critical"' apps/web/package.json 2>/dev/null; then
    echo -e "${GREEN}  → 关键巡检命令: pnpm --dir apps/web test:e2e:critical${NC}"
    echo -e "${YELLOW}  → 首次运行如缺少浏览器，请执行: pnpm --dir apps/web exec playwright install chromium${NC}"
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
