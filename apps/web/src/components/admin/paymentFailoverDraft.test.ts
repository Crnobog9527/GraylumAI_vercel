/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {expect,it} from 'vitest';
import {buildPaymentChannelSave,readPaymentChannelSetting} from './paymentFailoverDraft';
it('defaults only a valid legacy method route to Stripe and sends a version claim',()=>{
  expect(readPaymentChannelSetting({version:8,card:{enabled:true}})).toEqual({version:8,channel:'stripe'});
  expect(readPaymentChannelSetting({version:9,card:{enabled:true},newPurchaseChannel:'waffo'})).toEqual({version:9,channel:'waffo'});
  for(const value of [null,{channel:'stripe',version:1},{version:0,card:{enabled:true}},
    {version:1,card:{enabled:true},newPurchaseChannel:'paypal'}]) expect(readPaymentChannelSetting(value)).toBeNull();
  expect(buildPaymentChannelSave({version:8,channel:'stripe'},'waffo')).toEqual({expectedVersion:8,channel:'waffo'});
});
