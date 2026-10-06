-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
CREATE SCHEMA refund_test;
CREATE FUNCTION refund_test.fixture() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();u uuid:=gen_random_uuid();o uuid:=gen_random_uuid();
 t uuid:=gen_random_uuid();p uuid:=gen_random_uuid();snap jsonb;cash jsonb;paid timestamptz:=now()-interval '1 day';
BEGIN
 INSERT INTO profiles(id,role,credits) VALUES(a,'admin',0),(u,'user',1500);
 INSERT INTO credit_packages(id,name,credits_amount,price,bonus_credits) VALUES(p,'Refund fixture',1000,100,100);
 snap:=jsonb_build_object('version',1,'item_type','credit_package','item_id',p,
   'item_updated_at','2026-10-01T00:00:00Z','billing_cycle','one_time','currency','usd','unit','major',
   'price','100','discount','0','tax_behavior','inclusive','credits',1000,'bonus_credits',100);
 INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
   payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,
   purchase_snapshot,amount_total,currency,fulfilled_at,metadata)
 VALUES(o,u,'credit_package',p,'one_time','payment','completed','paid','stripe','acct_fixture','test',
   gen_random_uuid(),repeat('a',64),snap,10000,'usd',paid,jsonb_build_object('grantedCredits',1100));
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
 VALUES('stripe','acct_fixture','test','payment','pi_'||o,o);
 INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key,created_at)
 VALUES(u,1100,'purchase','grant',o,'pay-common:package:'||o,paid);
 INSERT INTO tickets(id,user_id,title,description,category) VALUES(t,u,'Fixture','Synthetic','billing');
 cash:=jsonb_build_object('orderId',o,'merchant','acct_fixture','mode','test','currency','usd',
   'paidMinor',10000,'refundedMinor',0,'refundCount',0,'disputed',false,'chargeId','ch_'||o,
   'paymentIntentId','pi_'||o,'paidAt',paid);
 RETURN jsonb_build_object('actor',a,'user',u,'order',o,'ticket',t,'cash',cash);
END $$;
