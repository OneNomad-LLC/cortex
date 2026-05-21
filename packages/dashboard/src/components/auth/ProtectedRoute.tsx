import * as React from "react";
import { Redirect } from "wouter";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth-context";

/**
 * Gate a subtree on `useAuth().status`. Loading renders skeletons,
 * anon redirects to /login, authed renders children.
 *
 * Kept tiny — pages don't have to think about auth at all when
 * wrapped here.
 */
interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps): React.ReactElement {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="space-y-3 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (status === "anon") {
    // Wouter's <Redirect> uses the router base prefix automatically.
    return <Redirect to="/login" />;
  }

  return <>{children}</>;
}
