/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseMainlandPhone, SMS_CODE_LENGTH, SMS_RESEND_SECONDS } from '@repo/api/src/shared/mainlandPhone';
import {
  PHONE_SEND_MESSAGES, phoneVerifyErrorMessage, requestPhoneCode,
} from '@/lib/phoneAuth';
import { createClient } from '@/lib/supabase';

export type PhoneStep = 'phone' | 'code';

/**
 * PHONE-OTP sign-in in the browser: number + both PIPL boxes → our send route → six-digit code →
 * verifyOtp, which signs in (a new number signs up). No password. The session lands in this browser like email sign-in.
 */
export function usePhoneSignIn(redirectTarget: string) {
  const [step, setStep] = useState<PhoneStep>('phone');
  const [phone, setPhone] = useState('');
  const [privacy, setPrivacy] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<'send' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (sentAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sentAt]);
  const waitSeconds = sentAt === null ? 0 : Math.max(0, SMS_RESEND_SECONDS - Math.floor((now - sentAt) / 1000));

  const send = useCallback(async () => {
    const parsed = parseMainlandPhone(phone);
    if (!parsed) return setError(PHONE_SEND_MESSAGES.PHONE_INVALID);
    if (!privacy || !transfer) return setError(PHONE_SEND_MESSAGES.CONSENT_REQUIRED);
    setPending('send');
    setError(null);
    try {
      const failure = await requestPhoneCode({ phone: parsed.e164, createUser: true, privacyConsent: privacy, transferConsent: transfer });
      if (failure) return setError(failure);
      setSentAt(Date.now());
      setNow(Date.now());
      setCode('');
      setStep('code');
    } finally {
      setPending(null);
    }
  }, [phone, privacy, transfer]);

  const verify = useCallback(async (value: string = code) => {
    const parsed = parseMainlandPhone(phone);
    if (!parsed || value.length !== SMS_CODE_LENGTH) return setError('请输入 6 位验证码。');
    setPending('verify');
    setError(null);
    const { error: verifyError } = await createClient().auth.verifyOtp({ phone: parsed.e164, token: value, type: 'sms' })
      .catch(() => ({ error: { code: 'network' } }));
    if (verifyError) {
      setPending(null);
      setCode('');
      return setError(phoneVerifyErrorMessage(verifyError));
    }
    window.location.assign(redirectTarget);
  }, [code, phone, redirectTarget]);

  const onCodeChange = useCallback((raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, SMS_CODE_LENGTH);
    setCode(digits);
    setError(null);
    if (digits.length === SMS_CODE_LENGTH && pending === null) void verify(digits);
  }, [pending, verify]);

  const changeNumber = useCallback(() => {
    setStep('phone');
    setCode('');
    setError(null);
  }, []);

  return {
    step, phone, setPhone: (value: string) => { setPhone(value.replace(/[^\d\s+-]/g, '')); setError(null); },
    privacy, setPrivacy, transfer, setTransfer, code, onCodeChange, pending, error, waitSeconds,
    maskedPhone: parseMainlandPhone(phone)?.national.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') ?? '',
    send, verify, changeNumber,
  };
}
