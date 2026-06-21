"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from './api';

export type CurrentUser = {
  sub: string;
  email: string;
  roles?: string[];
  permissions?: string[];
};

export function useAuth() {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ user: CurrentUser }>('/me')
      .then((result) => {
        if (!cancelled) {
          setUser(result.user);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          router.replace('/login');
        }
      });
    return () => { cancelled = true; };
  }, [router]);

  return { user, loading };
}
