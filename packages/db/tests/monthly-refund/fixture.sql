-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
CREATE SCHEMA monthly_test;
CREATE FUNCTION monthly_test.fixture(p_level text DEFAULT 'pro') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();u uuid:=gen_random_uuid();o uuid:=gen_random_uuid();s uuid:=gen_random_uuid();
 t uuid:=gen_random_uuid();pr uuid:=gen_random_uuid();p uuid;g uuid:=gen_random_uuid();tx uuid:=gen_random_uuid();snap jsonb;terms jsonb;
 paid timestamptz:=date_trunc('second',clock_timestamp())-interval '1 day';ending timestamptz;
BEGIN
 ending:=paid+interval '1 month';
 INSERT INTO profiles(id,role,credits,membership_level) VALUES(a,'admin',0,'free'),(u,'user',1500,p_level);
 SELECT id INTO p FROM membership_plans WHERE level=p_level LIMIT 1;
 IF p IS NULL THEN INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
 VALUES('Monthly synthetic',p_level,false,false,0) RETURNING id INTO p; END IF;
 snap:=jsonb_build_object('version',1,'item_type','membership_plan','item_id',p,
 'item_updated_at','2026-10-01T00:00:00Z','billing_cycle','monthly','currency','usd','unit','major',
 'price','69','discount','0','tax_behavior','inclusive','credits',1000,'bonus_credits',100);
 INSERT INTO user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,stripe_customer_id,
 billing_cycle,status,current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
 VALUES(s,u,p,'sub_'||s,'cus_'||u,'monthly','active',paid,ending,'stripe','acct_fixture','test',snap);
 INSERT INTO payment_provider_refs(id,channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle)
 VALUES(pr,'stripe','acct_fixture','test','price','price_'||o,p,'monthly');
 INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
 payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_membership_level,
 purchase_snapshot,amount_total,currency,fulfilled_at,subscription_id,price_ref_id)
 VALUES(o,u,'membership_plan',p,'monthly','subscription','completed','paid','stripe','acct_fixture','test',
 gen_random_uuid(),repeat('a',64),p_level,snap,6900,'usd',paid,s,pr);
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('stripe','acct_fixture','test','invoice','in_'||o,o);
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
 VALUES('stripe','acct_fixture','test','subscription','sub_'||s,s);
 INSERT INTO credit_transactions(id,user_id,amount,type,ledger_type,source_order_id,idempotency_key,created_at)
 VALUES(tx,u,1100,'purchase','grant',o,'monthly:'||o,paid);
 INSERT INTO subscription_credit_grants(id,user_id,membership_plan_id,stripe_subscription_id,stripe_invoice_id,
 billing_cycle,grant_type,grant_period_key,period_start,period_end,credits_granted,idempotency_key,
 credit_transaction_id,subscription_id,source_order_id,grant_snapshot,accounting_state,accounting_review_reason)
 VALUES(g,u,p,'sub_'||s,'in_'||o,'monthly','monthly_invoice','monthly:'||paid,paid,ending,1100,'monthly:'||o,
 tx,s,o,snap,'trusted',NULL);
 INSERT INTO tickets(id,user_id,title,description,category) VALUES(t,u,'Fixture','Synthetic','billing');
 terms:=jsonb_build_object('kind','monthly_first_purchase','orderId',o,'userId',u,'ticketId',t,'subscriptionId',s,
 'providerSubscriptionId','sub_'||s,'paymentIntentId','pi_'||o,'chargeId','ch_'||o,'invoiceId','in_'||o,
 'merchant','acct_fixture','mode','test','currency','usd','plan',p_level,'paidAt',paid,
 'submittedAt',(SELECT created_at FROM tickets WHERE id=t),'periodEnd',ending,'originalCancelAtPeriodEnd',false,
 'paidMinor',6900,'basisMinor',6900,'feeMinor',414,'netMinor',6486,'credits',1100,
 'feePermitted','confirmed','feeEvidence','fixture:law','evidenceRefs',jsonb_build_array('cash','history','ticket','ledger'),
 'snapshot',snap);
 RETURN jsonb_build_object('actor',a,'user',u,'order',o,'subscription',s,'grant',g,'ticket',t,'terms',terms);
END $$;
