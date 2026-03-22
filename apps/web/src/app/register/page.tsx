import { redirect } from 'next/navigation';
import { buildAuthHref } from '@/lib/site-config';

export default function RegisterPage() {
  redirect(buildAuthHref('/login?action=signup'));
}
