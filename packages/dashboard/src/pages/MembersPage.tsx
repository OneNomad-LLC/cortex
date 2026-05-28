/**
 * Members page — list, invite, and manage org members.
 *
 * - Invite by email: admin enters email + role → POST /api/dashboard/members
 * - Role edit: inline PATCH per row
 * - Active-seat toggle: PATCH /api/dashboard/seats/:userId (Business+ only)
 * - Seat counter pulled from GET /api/dashboard/seats
 *
 * The seat toggle is only shown when the seat endpoint responds (i.e.
 * PRZM_ACCESS_ORG_ID is configured in the workspace .env).
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SeatToggle } from "@/components/SeatToggle";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui/toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemberUser {
  id: string;
  email: string | null;
  name: string | null;
}

interface MemberRow {
  id: string;
  userId: string;
  tenantId: string;
  role: string;
  active: boolean;
  createdAt: string;
  user?: MemberUser;
}

interface MembersResponse {
  members: MemberRow[];
}

interface SeatsResponse {
  organizationId: string;
  seatsUsed: number;
  seatCount: number | null;
}

const ROLES = ["viewer", "editor", "admin", "owner"] as const;
type Role = (typeof ROLES)[number];

function isRole(v: string): v is Role {
  return (ROLES as ReadonlyArray<string>).includes(v);
}

// ---------------------------------------------------------------------------
// Invite dialog
// ---------------------------------------------------------------------------

function InviteDialog(props: {
  onInvited: () => void;
}): React.ReactElement {
  const { onInvited } = props;
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("viewer");

  const mutation = useMutation({
    mutationFn: async ({ email: e, role: r }: { email: string; role: Role }) =>
      api("/api/dashboard/members", {
        method: "POST",
        body: { email: e, role: r },
      }),
    onSuccess: () => {
      toast({ title: `Invited ${email}`, description: `Role: ${role}` });
      setEmail("");
      setRole("viewer");
      setOpen(false);
      onInvited();
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 size-4" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            They'll be added to the tenant with the role you specify.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => isRole(v) && setRole(v)}>
              <SelectTrigger id="invite-role">
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
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Send invite
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Role editor (inline select per row)
// ---------------------------------------------------------------------------

function RoleCell(props: {
  member: MemberRow;
  onRoleChange: (userId: string, role: Role) => void;
  isPending: boolean;
}): React.ReactElement {
  const { member, onRoleChange, isPending } = props;
  return (
    <Select
      value={member.role}
      onValueChange={(v) => isRole(v) && onRoleChange(member.userId, v)}
      disabled={isPending}
    >
      <SelectTrigger className="h-7 w-28 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r} value={r} className="text-xs">
            {r}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function MembersPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingRoleId, setPendingRoleId] = React.useState<string | null>(null);
  const [pendingSeatId, setPendingSeatId] = React.useState<string | null>(null);

  const membersQuery = useQuery<MembersResponse, ApiError>({
    queryKey: ["dashboard", "members"],
    queryFn: () => api<MembersResponse>("/api/dashboard/members"),
    refetchOnWindowFocus: false,
  });

  const seatsQuery = useQuery<SeatsResponse, ApiError>({
    queryKey: ["dashboard", "seats"],
    queryFn: () => api<SeatsResponse>("/api/dashboard/seats"),
    refetchOnWindowFocus: false,
    // Seats are optional (requires PRZM_ACCESS_ORG_ID) — don't treat 400 as fatal.
    retry: false,
  });

  const roleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role }) => {
      setPendingRoleId(userId);
      return api(`/api/dashboard/members/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: { role },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "members"] });
    },
    onError: (err) => {
      toast({
        title: "Role update failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
    onSettled: () => setPendingRoleId(null),
  });

  const seatMutation = useMutation({
    mutationFn: async ({
      userId,
      active,
    }: {
      userId: string;
      active: boolean;
    }) => {
      setPendingSeatId(userId);
      return api(`/api/dashboard/seats/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: { active },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "seats"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "members"] });
    },
    onError: (err) => {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 429) {
        toast({
          title: "Seat flip rate-limited",
          description: "Too many seat changes in the last 30 days.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Seat toggle failed",
          description: err.message,
          variant: "destructive",
        });
      }
    },
    onSettled: () => setPendingSeatId(null),
  });

  const invalidateMembers = () => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard", "members"] });
  };

  const seatsConfigured = seatsQuery.isSuccess;
  const seats = seatsQuery.data;
  const members = membersQuery.data?.members ?? [];

  return (
    <TooltipProvider>
      <main className="flex-1 space-y-4 p-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Users className="size-5" />
              Members
            </h1>
            <p className="text-sm text-muted-foreground">
              Manage tenant membership, roles, and active seats.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {seatsConfigured && seats ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {seats.seatsUsed}
                </span>
                {seats.seatCount !== null ? ` / ${seats.seatCount}` : ""} active
                seats
              </p>
            ) : null}
            <InviteDialog onInvited={invalidateMembers} />
          </div>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tenant members</CardTitle>
            <CardDescription>
              Edit roles inline. Seat toggles require PRZM_ACCESS_ORG_ID.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {membersQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : membersQuery.isError ? (
              <p className="text-sm text-destructive">
                Failed to load members:{" "}
                {membersQuery.error instanceof ApiError
                  ? membersQuery.error.status === 400
                    ? "przm-access not configured (PRZM_ACCESS_ADMIN_URL, PRZM_ACCESS_OPERATOR_KEY, PRZM_ACCESS_TENANT_ID required)"
                    : membersQuery.error.message
                  : String(membersQuery.error)}
              </p>
            ) : members.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No members yet. Invite someone to get started.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="pb-2 pr-3 font-medium">Email / ID</th>
                      <th className="pb-2 pr-3 font-medium">Name</th>
                      <th className="pb-2 pr-3 font-medium">Role</th>
                      {seatsConfigured ? (
                        <th className="pb-2 pr-3 font-medium">Active seat</th>
                      ) : null}
                      <th className="pb-2 pr-3 font-medium">Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id} className="border-t">
                        <td className="py-2 pr-3 align-middle font-medium">
                          {m.user?.email ?? (
                            <span className="font-mono text-xs text-muted-foreground">
                              {m.userId}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 align-middle text-muted-foreground">
                          {m.user?.name ?? "—"}
                        </td>
                        <td className="py-2 pr-3 align-middle">
                          <RoleCell
                            member={m}
                            onRoleChange={(uid, r) =>
                              roleMutation.mutate({ userId: uid, role: r })
                            }
                            isPending={pendingRoleId === m.userId}
                          />
                        </td>
                        {seatsConfigured ? (
                          <td className="py-2 pr-3 align-middle">
                            <SeatToggle
                              userId={m.userId}
                              active={m.active}
                              isPending={pendingSeatId === m.userId}
                              onToggle={(uid, next) =>
                                seatMutation.mutate({ userId: uid, active: next })
                              }
                            />
                          </td>
                        ) : null}
                        <td className="py-2 pr-3 align-middle text-xs text-muted-foreground">
                          {formatDate(m.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {seatsConfigured && seats && seats.seatCount !== null ? (
          <p className="text-xs text-muted-foreground">
            <Badge variant="outline" className="mr-1.5">
              Business+
            </Badge>
            Seat management is active. Deactivating a seat frees the slot for
            another user.
          </p>
        ) : null}
      </main>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  return new Date(d).toLocaleDateString();
}
