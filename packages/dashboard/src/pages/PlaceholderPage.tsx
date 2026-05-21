import * as React from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Generic "coming online" page. The wizard and ops teammates fill in
 * real implementations on their own worktrees — placeholders here
 * keep the router wired up and the sidebar clickable.
 */

interface PlaceholderPageProps {
  title: string;
  /** Which teammate is responsible for the real implementation. */
  owner: string;
  /** Short description of what the page will eventually do. */
  description?: string;
}

export function PlaceholderPage({
  title,
  owner,
  description,
}: PlaceholderPageProps): React.ReactElement {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Coming online</CardTitle>
          <CardDescription>{owner} teammate landing.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This surface isn't built yet. Check back after the {owner}{" "}
            teammate's branch lands on{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              feat/dashboard-base
            </code>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function NotFoundPage(): React.ReactElement {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
        <p className="text-sm text-muted-foreground">
          That URL doesn't match any dashboard route.
        </p>
      </header>
    </div>
  );
}
