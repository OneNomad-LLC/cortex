import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Placeholder shimmer — used by ProtectedRoute while the AuthProvider
 * resolves the initial whoami call, and by pages that gate themselves
 * on a query result. Matches the shadcn API so swapping for the
 * official skeleton package later is a no-op.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
