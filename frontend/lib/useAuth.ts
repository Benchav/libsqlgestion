"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from './api';

export type CurrentUser = {
  sub: string;
  email: string;
};

/**
 * Auth guard hook. Redirects to /login when there is no active session.
 * Returns the current user payload once loaded.
 */
export function useAuth() {
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ user: CurrentUser }>('/me')
      .then((result) => {
        setUser(result.user);
        setLoading(false);
      })
      .catch(() => {
        router.replace('/login');
      });
  }, [router]);

  return { user, loading };
}
