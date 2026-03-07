"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function sanitizeRedirectTarget(redirect: string | null) {
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('//')) {
    return '/profile';
  }

  return redirect;
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [redirectTarget, setRedirectTarget] = useState('/profile');
  const [action, setAction] = useState<string | null>(null);
  const isSignupIntent = action === 'signup';

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRedirectTarget(sanitizeRedirectTarget(params.get('redirect')));
    setAction(params.get('action'));
  }, []);

  const handleLogin = async () => {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage(error.message);
    } else {
      setMessage('Logged in successfully! Redirecting...');
      window.location.assign(redirectTarget);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen">
      <Card className="w-[350px]">
        <CardHeader>
          <CardTitle>{isSignupIntent ? 'Get Started' : 'Login'}</CardTitle>
          <CardDescription>
            {isSignupIntent ? 'Continue to the app with your GraylumAI account.' : 'Sign in to continue to GraylumAI.'}
          </CardDescription>
          {redirectTarget !== '/profile' && (
            <p className="text-xs text-muted-foreground">
              You will return to <span className="font-mono">{redirectTarget}</span> after login.
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="m@example.com" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <Button onClick={handleLogin} className="w-full">Login</Button>
            {message && <p className="text-sm text-center text-red-500">{message}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
