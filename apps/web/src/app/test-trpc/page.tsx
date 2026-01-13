'use client';

import { trpc } from '@/trpc/client';

export default function TestTRPCPage() {
  const { data, isLoading } = trpc.chat.hello.useQuery({ text: 'World' });

  if (isLoading) return <div>Loading...</div>;

  return <div>{data?.greeting}</div>;
}
