-- Synthetic local-only boundary checks. Never apply to a remote database.
BEGIN;
DO $$
DECLARE a uuid:=gen_random_uuid();r uuid:=gen_random_uuid();c uuid:=gen_random_uuid();v jsonb;cfg jsonb;conversation uuid:=gen_random_uuid();
BEGIN
 INSERT INTO profiles(id,credits) VALUES(a,100);
 INSERT INTO conversations(id,user_id,title) VALUES(conversation,a,'Synthetic stop-loss');
 cfg:=jsonb_build_object('version',1,'userDailyUsd','1','siteDailyUsd',NULL,'siteAlertUsd','1',
  'providerBalanceAlertUsd',NULL,'notificationChannel',NULL);
 INSERT INTO system_settings(key,value) VALUES('runtime_stop_loss',cfg) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 PERFORM runtime_stop_loss_assert(a,true);
 INSERT INTO bill2_runs(id,actor_id,request_id,scope,payload,reserved,budget_usd,credits_per_usd,multiplier,max_calls,deadline)
 VALUES(r,a,gen_random_uuid(),'{}','{}',1,10,100,1,10,now()+interval '1 hour');
 INSERT INTO bill2_calls(id,run_id,sequence,payload,provider,account_namespace,model,upper_usd)
 VALUES(c,r,1,'{}','fixture','synthetic','synthetic',1);
 -- A previous UTC day does not count in today's cap.
 INSERT INTO credit_transactions(user_id,amount,type,reason_code,idempotency_key,balance_before,balance_after,metadata,created_at)
 VALUES(a,0,'adjustment','bill2_release',gen_random_uuid()::text,100,100,'{"providerCostUsd":"100"}',((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC')-interval '1 second');
 PERFORM runtime_stop_loss_assert(a,true);
 INSERT INTO credit_transactions(user_id,amount,type,reason_code,idempotency_key,balance_before,balance_after,metadata)
 VALUES(a,0,'adjustment','bill2_release',gen_random_uuid()::text,100,100,'{"providerCostUsd":"0.999999999999"}');
 PERFORM runtime_stop_loss_assert(a,true);
 INSERT INTO credit_transactions(user_id,amount,type,reason_code,idempotency_key,balance_before,balance_after,metadata)
 VALUES(a,0,'adjustment','bill2_release',gen_random_uuid()::text,100,100,'{"providerCostUsd":"0.000000000001"}');
 BEGIN PERFORM runtime_stop_loss_assert(a,true);RAISE EXCEPTION 'expected user denial';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'RUNTIME_USER_DAILY_USD_LIMIT' THEN RAISE;END IF;END;
 -- New call insertion cannot bypass the monetary check.
 BEGIN
  INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd)
  VALUES(r,2,'{}','fixture','synthetic','synthetic',1);
  RAISE EXCEPTION 'expected insert denial';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'RUNTIME_USER_DAILY_USD_LIMIT' THEN RAISE;END IF;END;
 -- A frozen call may still dispatch and settle despite a monetary cap.
 UPDATE bill2_calls SET dispatched_at=clock_timestamp() WHERE id=c;
 INSERT INTO credit_transactions(user_id,amount,type,reason_code,idempotency_key,balance_before,balance_after,metadata)
 VALUES(a,0,'adjustment','bill2_release',gen_random_uuid()::text,100,100,'{"providerCostUsd":"0.25"}');
 v:=runtime_stop_loss_usage(a);
 IF (v->>'userUsd')::numeric<>1.25 THEN RAISE EXCEPTION 'incorrect exact total: %',v;END IF;
 PERFORM runtime_stop_loss_observe(a);PERFORM runtime_stop_loss_observe(a);
 IF EXISTS(SELECT 1 FROM diagnostic_results WHERE details ? 'actorId' OR details::text LIKE '%'||a::text||'%')
 THEN RAISE EXCEPTION 'alert retained an actor identifier';END IF;
 IF (SELECT count(*) FROM diagnostic_results WHERE test_id='runtime_stop_loss_userDailyUsd')<>1
 THEN RAISE EXCEPTION 'duplicate threshold alert';END IF;
 cfg:=jsonb_set(jsonb_set(cfg,'{userDailyUsd}','null'),'{siteDailyUsd}','"1.25"');
 UPDATE system_settings SET value=cfg WHERE key='runtime_stop_loss';
 BEGIN PERFORM runtime_stop_loss_assert(gen_random_uuid(),true);RAISE EXCEPTION 'expected site denial';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'RUNTIME_SITE_DAILY_USD_LIMIT' THEN RAISE;END IF;END;
 UPDATE system_settings SET value=jsonb_set(cfg,'{notificationChannel}','"   "') WHERE key='runtime_stop_loss';
 BEGIN PERFORM runtime_stop_loss_assert(a,true);RAISE EXCEPTION 'expected invalid channel denial';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'RUNTIME_STOP_LOSS_CONFIG_INVALID' THEN RAISE;END IF;END;
 DELETE FROM system_settings WHERE key='runtime_stop_loss';
 PERFORM runtime_stop_loss_assert(a,true);
 INSERT INTO system_settings(key,value) VALUES('runtime_rate_limits','{"stopNewCalls":true}')
 ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 BEGIN PERFORM runtime_stop_loss_assert(a,false);RAISE EXCEPTION 'expected stop denial';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'RUNTIME_NEW_CALLS_STOPPED' THEN RAISE;END IF;END;
 -- Settlement continues while stopped and with malformed monitoring config.
 INSERT INTO system_settings(key,value) VALUES('runtime_stop_loss','{"version":999}');
 INSERT INTO credit_transactions(user_id,amount,type,reason_code,idempotency_key,balance_before,balance_after,metadata)
 VALUES(a,0,'adjustment','bill2_release',gen_random_uuid()::text,100,100,'{"providerCostUsd":"0.1"}');
 IF NOT EXISTS(SELECT 1 FROM diagnostic_results WHERE test_id='runtime_stop_loss_monitor_unavailable')
 THEN RAISE EXCEPTION 'missing monitor failure';END IF;
 DELETE FROM system_settings WHERE key='runtime_stop_loss';
 UPDATE system_settings SET value='{"stopNewCalls":false}' WHERE key='runtime_rate_limits';
 PERFORM runtime_stop_loss_assert(a,true);
 IF has_function_privilege('authenticated','runtime_stop_loss_usage(uuid)','execute')
 OR has_function_privilege('authenticated','runtime_stop_loss_observe(uuid)','execute')
 THEN RAISE EXCEPTION 'user can access private global spend';END IF;
END $$;
ROLLBACK;
