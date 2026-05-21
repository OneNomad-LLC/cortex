import * as React from "react";
import { useLocation } from "wouter";

/**
 * Sits high in the tree and reacts to the `cortex:unauthorized`
 * window event dispatched by the `api()` helper on 401. Sends the
 * user to /login regardless of which page threw — saves every page
 * + every query callback from having to plumb auth-errors manually.
 *
 * Implemented as a sibling to <AuthProvider> rather than a true
 * ErrorBoundary because the unauthorized signal is an event, not a
 * thrown render error. React's error-boundary surface would need
 * each query to actually throw during render to fire, which would
 * need `suspense: true` everywhere — not worth the change.
 */
export function AuthErrorBoundary({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [location, navigate] = useLocation();

  React.useEffect(() => {
    const handler = () => {
      // Avoid bouncing the user off the login page itself.
      if (location !== "/login") navigate("/login");
    };
    window.addEventListener("cortex:unauthorized", handler);
    return () => window.removeEventListener("cortex:unauthorized", handler);
  }, [location, navigate]);

  return <>{children}</>;
}
