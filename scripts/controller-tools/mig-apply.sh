#!/bin/zsh
# usage: mig-apply.sh <num> <pr> <head-sha> <migration-name-without-.sql>
set -e
[ "$MIG_REVIEWED" = "1" ] || { echo CONTROLLER_CONFIRMATION_REQUIRED; exit 2; }
N=$1; PR=$2; H=$3; NAME=$4
T=~/.graylum/controller-tools; M=$T/m$N; cd $T
CHECKER="$T/structure-check/scripts/staging-structure.mjs"
[ "$(cat sb/supabase/.temp/project-ref 2>/dev/null)" = "gvcpmcunmfrbxuwimxfa" ] || { echo NOT_STAGING; exit 2; }
[ -z "$ALLOW_EXTRA" ] || { echo ALLOW_EXTRA_IS_NOT_SUPPORTED; exit 2; }
cur=$(gh pr view $PR -R Crnobog9527/GraylumAI_vercel --json headRefOid --jq .headRefOid)
[ "$cur" = "$H" ] || { echo "HEAD MOVED $cur"; exit 2; }
dr=$(gh pr view $PR -R Crnobog9527/GraylumAI_vercel --json isDraft --jq .isDraft)
[ "$dr" = "false" ] || { echo "PR IS DRAFT: mark ready first"; exit 2; }
[ "$(gh pr view $PR -R Crnobog9527/GraylumAI_vercel --json baseRefName --jq .baseRefName)" = "staging" ] || {
  echo NOT_STAGING_BASE; exit 2
}
node "$CHECKER" sql > $M/capture-direct.sql
supabase db query --linked --workdir sb -f $M/capture-direct.sql -o json > $M/direct-before.json
node "$CHECKER" compare-staging $M/direct-before.json $M/stg.json > $M/direct-before-compare.json || {
  cat $M/direct-before-compare.json; echo BEFORE_CHECK_FAILED; exit 2
}
supabase db query --linked --workdir sb -f $M/$N.sql -o json > $M/apply-out.json 2>$M/apply-err.txt || { echo APPLY_FAILED; tail -5 $M/apply-err.txt; exit 3; }
echo "insert into supabase_migrations.schema_migrations(version,name) values (to_char(now() at time zone 'utc','YYYYMMDDHH24MISS'),'$NAME') returning version;" > $M/rec.sql
V=$(supabase db query --linked --workdir sb -f $M/rec.sql -o json 2>/dev/null | python3 -c "import json,sys;t=sys.stdin.read();d,_=json.JSONDecoder().raw_decode(t[t.index('{'):]);print(d['rows'][0]['version'])")
[ -n "$V" ] || { echo RECORD_FAILED_CHECK_MANUALLY; exit 5; }
echo "recorded $V"
node "$CHECKER" sql > $M/capture-after.sql
supabase db query --linked --workdir sb -f $M/capture-after.sql -o json > $M/after.json
node "$CHECKER" compare-staging $M/after.json $M/built.json > $M/after-compare.json || {
  cat $M/after-compare.json
  echo "UNEXPECTED AFTER DIFF: applied but not merged; inspect before retrying"
  exit 4
}
for try in 1 2 3 4; do gh pr merge $PR -R Crnobog9527/GraylumAI_vercel --squash --match-head-commit $H && break; [ $try = 4 ] && { echo "APPLIED BUT NOT MERGED: merge it, do not apply again"; exit 8; }; sleep 8; done
MC=$(gh pr view $PR -R Crnobog9527/GraylumAI_vercel --json mergeCommit --jq '.mergeCommit.oid[0:8]')
echo "merged $MC"
echo "$V $MC" > $M/result.txt
