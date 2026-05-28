/**
 * Invitations page — shows a "send invite" form and explains the invite
 * flow. The actual member-add call hits POST /api/dashboard/members (the
 * same endpoint as the Members page inline invite), which proxies to
 * przm-access `POST /admin/tenants/:tenantId/members { email, role }`.
 *
 * The email / magic-link leg of the invite flow is future work in
 * przm-access (a dedicated `/admin/orgs/:id/invitations` endpoint with
 * Resend email delivery). Until that lands, inviting by email creates the
 * membership directly; the invitee will be notified out-of-band.
 *
 * A "pending invitations" list is shown when the backend returns a
 * `pendingInvitations` key in the members response. Today it isn't
 * emitted, so the list renders empty.
 */

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Mail, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ROLES = ["viewer", "editor", "admin", "owner"] as const;
type Role = (typeof ROLES)[number];

function isRole(v: string): v is Role {
  return (ROLES as ReadonlyArray<string>).includes(v);
}

// ---------------------------------------------------------------------------
// Invite form
// ---------------------------------------------------------------------------

function InviteForm(): React.ReactElement {
  const { toast } = useToast();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("viewer");
  const [sent, setSent] = React.useState<string[]>([]);

  const mutation = useMutation({
    mutationFn: async (data: { email: string; role: Role }) =>
      api("/api/dashboard/members", {
        method: "POST",
        body: data,
      }),
    onSuccess: () => {
      toast({ title: `Invited ${email}` });
      setSent((prev) => [email, ...prev]);
      setEmail("");
      setRole("viewer");
    },
    onError: (err) => {
      toast({
        title: "Invite failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    mutation.mutate({ email: email.trim(), role });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="inv-email">Email address</Label>
            <Input
              id="inv-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inv-role">Role</Label>
            <Select value={role} onValueChange={(v) => isRole(v) && setRole(v)}>
              <SelectTrigger id="inv-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Plus className="mr-2 size-4" />
              )}
              Invite
            </Button>
          </div>
        </div>
      </form>

      {sent.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Sent this session
          </p>
          <ul className="space-y-1">
            {sent.map((addr) => (
              <li
                key={addr}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Mail className="size-3.5 shrink-0" />
                {addr}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function InvitationsPage(): React.ReactElement {
  return (
    <main className="flex-1 space-y-4 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Mail className="size-5" />
          Invitations
        </h1>
        <p className="text-sm text-muted-foreground">
          Invite people by email. They're added directly to the tenant with
          the role you choose.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Send an invite</CardTitle>
          <CardDescription>
            The invitee is added to the tenant immediately. Magic-link email
            delivery is a future enhancement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InviteForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending invitations</CardTitle>
          <CardDescription>
            Tracked invitations will appear here once the invitation endpoint
            ships in przm-access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 py-4">
            <Badge variant="outline">Coming soon</Badge>
            <p className="text-sm text-muted-foreground">
              The magic-link invite flow (email + claim link) is being added to
              przm-access. In the meantime, invites add the member directly.
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
