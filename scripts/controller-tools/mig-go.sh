#!/bin/zsh
# usage: mig-go.sh <pr> [--check|--apply]   STAGING ONLY.
# Execution windows only run --check (the default). Only the controller uses MIG_REVIEWED=1 with --apply.
# Every migration requires controller confirmation, regardless of its SQL keywords.
set -e
PR=$1; MODE=${2:---check}; REPO=Crnobog9527/GraylumAI_vercel
T=~/.graylum/controller-tools; cd $T
R="${GRAYLUM_REPO:-$HOME/Graylum_AI/GraylumAI_vercel}"
CHECKER="$T/structure-check/scripts/staging-structure.mjs"
LOCK=~/.graylum/mig-lock
fail() { echo "STOP: $1"; exit 2; }
[ -n "$PR" ] || fail "usage: mig-go.sh <pr> [--check|--apply]"
case "$MODE" in
  --check) ;;
  --apply) [ "$MIG_REVIEWED" = "1" ] || fail "only the controller may apply migrations (MIG_REVIEWED=1 required)" ;;
  *) fail "unknown mode: $MODE" ;;
esac

if ! mkdir $LOCK 2>/dev/null; then echo "QUEUE BUSY: $(cat $LOCK/who 2>/dev/null)"; exit 3; fi
trap 'rm -rf $LOCK' EXIT
echo "PR $PR since $(date -u +%H:%M:%S)" > $LOCK/who

# Staging only: the link must be the staging project.
[ "$(cat sb/supabase/.temp/project-ref 2>/dev/null)" = "gvcpmcunmfrbxuwimxfa" ] || fail "supabase link is not staging"

H=$(gh pr view $PR -R $REPO --json headRefOid --jq .headRefOid)
[ "$(gh pr view $PR -R $REPO --json isDraft --jq .isDraft)" = "false" ] || fail "PR is a draft"
[ "$(gh pr view $PR -R $REPO --json baseRefName --jq .baseRefName)" = "staging" ] || fail "base is not staging"
bad=$(gh pr view $PR -R $REPO --json statusCheckRollup --jq '[.statusCheckRollup[]|select((.conclusion//.state)|IN("SUCCESS","SKIPPED","NEUTRAL")|not)|(.name//.context)]|join(", ")')
[ -z "$bad" ] || fail "checks not green: $bad"
ncheck=$(gh pr view $PR -R $REPO --json statusCheckRollup --jq '[.statusCheckRollup[]|select((.conclusion//.state)=="SUCCESS")]|length')
[ "${ncheck:-0}" -ge 10 ] || fail "only ${ncheck:-0} successful checks (CI did not run fully)"
rc=$(gh api repos/$REPO/issues/$PR/comments --paginate --jq '[.[]|select(.user.login|test("codex"))]|.[-1].body' | grep -oE 'Reviewed commit:\*\* `[0-9a-f]+' | grep -oE '[0-9a-f]+$' | tail -1)
if ! { [ -n "$rc" ] && [[ "$H" == $rc* ]]; }; then
  # Owner 2026-11-11 "同意临时审查" (MASTER_PLAN 2.1): while the Codex bot is out of quota, an independent
  # independent review with an exact full-commit passing receipt counts as the review.
  review_file=$(mktemp "$T/independent-review.XXXXXX")
  gh api repos/$REPO/issues/$PR/comments --paginate --slurp --jq 'add' > "$review_file"
  if ! node "$T/structure-check/scripts/controller-review.mjs" "$H" "$review_file"; then
    rm -f "$review_file"
    fail "no explicit passing independent review receipt covers this version (bot reviewed: ${rc:-none})"
  fi
  rm -f "$review_file"
  echo "review: explicit independent review receipt covers $H"

fi
open=$(gh api graphql -F n=$PR -f query='query($n:Int!){repository(owner:"Crnobog9527",name:"GraylumAI_vercel"){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}}}}}' --jq '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)]|length')
[ "$open" = "0" ] || fail "$open unresolved review threads"

git -C "$R" fetch -q origin staging "refs/pull/$PR/head"
files=("${(@f)$(git -C "$R" diff --name-only --diff-filter=A origin/staging...$H -- packages/db/migrations)}")
[ -n "${files[1]}" ] || fail "no new migration in this PR; merge it the normal way"
missing=$(comm -23 <(git -C "$R" ls-tree --name-only origin/staging packages/db/migrations/ | sort) <(git -C "$R" ls-tree --name-only $H packages/db/migrations/ | sort))
[ -z "$missing" ] || fail "PR lacks staging migrations, sync first: $missing"
changed=$(git -C "$R" diff --name-only --diff-filter=MD origin/staging...$H -- packages/db/migrations)
[ -z "$changed" ] || fail "an applied migration file was changed: $changed"
max=$(git -C "$R" ls-tree --name-only origin/staging packages/db/migrations/ | sed -E 's#.*/([0-9]{4})_.*#\1#' | grep -E '^[0-9]{4}$' | sort -n | tail -1)
N=""; S=""
for f in $files; do
  n=$(basename "$f" | cut -c1-4)
  [ "$n" = "9999" ] && fail "placeholder number 9999 in $f: rename it to the next real number (above $max) in the PR before applying"
  [ "$n" -gt "$max" ] || fail "$n is not above staging's highest number $max: rename it"
  N=$n; S="$S$(git -C "$R" show "${H}:$f")"$'\n'
done
M=$T/m$N; mkdir -p $M
print -r -- "$S" > $M/$N.sql
git -C "$R" show "${H}:packages/db/tests/baseline/built-fingerprint.json" > $M/built.json
git -C "$R" show "origin/staging:packages/db/tests/baseline/built-fingerprint.json" > $M/stg.json

if grep -qiE '^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|DROP (TABLE|INDEX)|LOCK TABLE)' $M/$N.sql; then
  grep -qi 'lock_timeout' $M/$N.sql || fail "changes a table without SET LOCAL lock_timeout"
fi
grep -qiE 'CREATE +INDEX +CONCURRENTLY' $M/$N.sql && fail "CREATE INDEX CONCURRENTLY cannot run in this batch"
grep -qE 'graylum-production|[^a-z]prod[^a-z]' <<<"$(grep -iE 'project|host' $M/$N.sql | head -5)" && fail "migration names production"

node "$CHECKER" sql > $M/capture.sql
supabase db query --linked --workdir sb -f $M/capture.sql -o json > $M/before.json
node "$CHECKER" compare-staging $M/before.json $M/stg.json > $M/before-compare.json || {
  cat $M/before-compare.json
  fail "staging differs from staging's files; exact structure check failed"
}
echo "--- this PR changes:"
git -C "$R" diff origin/staging $H -- packages/db/tests/baseline/built-fingerprint.json

[ "$MODE" = "--check" ] && { echo "ALL GATES PASSED, not applied"; exit 0; }

first=$(basename "$files[-1]" .sql)
./mig-apply.sh $N $PR $H "$first"
for f in ${files[1,-2]}; do
  name=$(basename "$f" .sql)
  echo "insert into supabase_migrations.schema_migrations(version,name) values (to_char(clock_timestamp() at time zone 'utc','YYYYMMDDHH24MISSMS'),'$name');" > $M/rec2.sql
  supabase db query --linked --workdir sb -f $M/rec2.sql -o json >/dev/null 2>&1 || echo "RECORD FAILED: $name, tell the controller"
done
echo "DONE $(cat $M/result.txt)"
printf '\n## %s mig-go: #%s %s -> %s\n' "$(date +%F)" "$PR" "$first" "$(cat $M/result.txt)" >> controller-state.md
