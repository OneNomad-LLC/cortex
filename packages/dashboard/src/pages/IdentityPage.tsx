import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Edit, User, Briefcase } from "lucide-react";
import { z } from "zod";

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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, apiPost } from "@/lib/api";

/**
 * Identity page — surfaces the workspace's "self" person + (when
 * configured) the user's job profile. Edit dialogs POST patches to
 * the dashboard identity endpoints, which wrap the cortex MCP tools.
 *
 * Job profile is a private-modules tool: if it's not wired on this
 * cortex install, the API returns 404 + `error: "module_unavailable"`
 * and we render the "not configured" affordance instead.
 */

interface PersonInfo {
  slug: string;
  name: string;
  email?: string;
  role?: string;
  team?: string;
  timezone?: string;
  workHours?: string;
  projects?: string[];
  aliases?: string[];
}

interface JobProfileInfo {
  title?: string;
  employer?: string;
  team?: string;
  focusAreas?: string[];
  responsibilities?: string;
  stack?: string[];
  managerSlug?: string;
  directReports?: string[];
}

interface IdentityResponse {
  self: PersonInfo | null;
  jobProfile: { available: true; profile: JobProfileInfo | null } | { available: false };
}

function useIdentity() {
  return useQuery({
    queryKey: ["dashboard", "identity"],
    queryFn: () => api<IdentityResponse>("/api/dashboard/identity"),
  });
}

export function IdentityPage(): React.ReactElement {
  const { data, isLoading, error } = useIdentity();
  const [editSelfOpen, setEditSelfOpen] = React.useState(false);
  const [editJobOpen, setEditJobOpen] = React.useState(false);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Identity</h1>
        <p className="text-sm text-muted-foreground">
          Who you are to this workspace, and what you do.
        </p>
      </header>

      {error && (
        <p className="text-sm text-destructive">Failed to load identity.</p>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <User className="size-4" />
              Self person
            </CardTitle>
            <CardDescription>
              The person marked <code>self: true</code> in
              <code> people.yaml</code>.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditSelfOpen(true)}
          >
            <Edit className="size-3" />
            Edit
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading && <Skeleton className="h-24 w-full" />}
          {!isLoading && data && !data.self && (
            <p className="text-sm text-muted-foreground">
              Not configured yet. Hit Edit to add a self person.
            </p>
          )}
          {!isLoading && data?.self && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <Field label="Slug" value={data.self.slug} mono />
              <Field label="Name" value={data.self.name} />
              <Field label="Email" value={data.self.email} />
              <Field label="Role" value={data.self.role} />
              <Field label="Team" value={data.self.team} />
              <Field label="Timezone" value={data.self.timezone} />
              <Field label="Working hours" value={data.self.workHours} />
              <Field label="Projects" value={(data.self.projects ?? []).join(", ")} />
              <Field label="Aliases" value={(data.self.aliases ?? []).join(", ")} />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Briefcase className="size-4" />
              Job profile
            </CardTitle>
            <CardDescription>
              Title, focus areas, stack — context for work-related
              prompts.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={data?.jobProfile.available === false}
            onClick={() => setEditJobOpen(true)}
          >
            <Edit className="size-3" />
            Edit
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading && <Skeleton className="h-24 w-full" />}
          {!isLoading && data?.jobProfile.available === false && (
            <p className="text-sm text-muted-foreground">
              Job profile not configured on this Cortex install.
            </p>
          )}
          {!isLoading &&
            data?.jobProfile.available === true &&
            !data.jobProfile.profile && (
              <p className="text-sm text-muted-foreground">
                Not configured yet. Hit Edit to add a job profile.
              </p>
            )}
          {!isLoading &&
            data?.jobProfile.available === true &&
            data.jobProfile.profile && (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                <Field label="Title" value={data.jobProfile.profile.title} />
                <Field label="Employer" value={data.jobProfile.profile.employer} />
                <Field label="Team" value={data.jobProfile.profile.team} />
                <Field label="Manager slug" value={data.jobProfile.profile.managerSlug} mono />
                <Field
                  label="Focus areas"
                  value={(data.jobProfile.profile.focusAreas ?? []).join(", ")}
                />
                <Field
                  label="Stack"
                  value={(data.jobProfile.profile.stack ?? []).join(", ")}
                />
                <Field
                  label="Direct reports"
                  value={(data.jobProfile.profile.directReports ?? []).join(", ")}
                />
                <Field
                  label="Responsibilities"
                  value={data.jobProfile.profile.responsibilities}
                  fullWidth
                />
              </dl>
            )}
        </CardContent>
      </Card>

      <EditSelfDialog
        open={editSelfOpen}
        onOpenChange={setEditSelfOpen}
        initial={data?.self ?? null}
      />
      <EditJobProfileDialog
        open={editJobOpen}
        onOpenChange={setEditJobOpen}
        initial={
          data?.jobProfile.available === true ? data.jobProfile.profile : null
        }
      />
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string | undefined;
  mono?: boolean;
  fullWidth?: boolean;
}

function Field({ label, value, mono, fullWidth }: FieldProps): React.ReactElement {
  return (
    <div className={fullWidth ? "sm:col-span-2" : undefined}>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={mono ? "font-mono text-sm" : "text-sm"}>
        {value && value.length > 0 ? value : (
          <span className="text-muted-foreground">—</span>
        )}
      </dd>
    </div>
  );
}

const selfSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be kebab-case"),
  name: z.string().min(1, "Name required"),
  email: z.string().email("Valid email required"),
  role: z.string().optional(),
  team: z.string().optional(),
  timezone: z.string().optional(),
  workHours: z.string().optional(),
  projects: z.string().optional(),
  aliases: z.string().optional(),
});

type SelfFormShape = z.infer<typeof selfSchema>;

interface EditSelfDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: PersonInfo | null;
}

function EditSelfDialog({
  open,
  onOpenChange,
  initial,
}: EditSelfDialogProps): React.ReactElement {
  const qc = useQueryClient();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<SelfFormShape>({
      defaultValues: {
        slug: initial?.slug ?? "",
        name: initial?.name ?? "",
        email: initial?.email ?? "",
        role: initial?.role ?? "",
        team: initial?.team ?? "",
        timezone: initial?.timezone ?? "",
        workHours: initial?.workHours ?? "",
        projects: (initial?.projects ?? []).join(", "),
        aliases: (initial?.aliases ?? []).join(", "),
      },
    });

  React.useEffect(() => {
    if (!open) return;
    reset({
      slug: initial?.slug ?? "",
      name: initial?.name ?? "",
      email: initial?.email ?? "",
      role: initial?.role ?? "",
      team: initial?.team ?? "",
      timezone: initial?.timezone ?? "",
      workHours: initial?.workHours ?? "",
      projects: (initial?.projects ?? []).join(", "),
      aliases: (initial?.aliases ?? []).join(", "),
    });
    setServerError(null);
  }, [open, initial, reset]);

  const mut = useMutation({
    mutationFn: (values: SelfFormShape) =>
      apiPost("/api/dashboard/identity/self", {
        slug: values.slug,
        name: values.name,
        email: values.email,
        ...(values.role ? { role: values.role } : {}),
        ...(values.team ? { team: values.team } : {}),
        ...(values.timezone ? { timezone: values.timezone } : {}),
        ...(values.workHours ? { workHours: values.workHours } : {}),
        ...(values.projects
          ? { projects: splitList(values.projects) }
          : {}),
        ...(values.aliases ? { aliases: splitList(values.aliases) } : {}),
      }),
    async onSuccess() {
      await qc.invalidateQueries({ queryKey: ["dashboard", "identity"] });
      onOpenChange(false);
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const parsed = selfSchema.safeParse(values);
    if (!parsed.success) {
      setServerError(parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    try {
      await mut.mutateAsync(parsed.data);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.body.error ?? "Save failed");
        return;
      }
      setServerError("Save failed");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit self person</DialogTitle>
          <DialogDescription>
            Updates the workspace's people.yaml. Comma-separate
            multi-value fields.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={onSubmit} noValidate>
          <Row>
            <Field2 label="Slug" htmlFor="slug" error={errors.slug?.message}>
              <Input id="slug" {...register("slug")} />
            </Field2>
            <Field2 label="Name" htmlFor="name" error={errors.name?.message}>
              <Input id="name" {...register("name")} />
            </Field2>
          </Row>
          <Field2 label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" {...register("email")} />
          </Field2>
          <Row>
            <Field2 label="Role" htmlFor="role">
              <Input id="role" {...register("role")} />
            </Field2>
            <Field2 label="Team" htmlFor="team">
              <Input id="team" {...register("team")} />
            </Field2>
          </Row>
          <Row>
            <Field2 label="Timezone" htmlFor="timezone">
              <Input id="timezone" {...register("timezone")} />
            </Field2>
            <Field2 label="Working hours" htmlFor="workHours">
              <Input id="workHours" {...register("workHours")} />
            </Field2>
          </Row>
          <Field2 label="Projects (comma-separated)" htmlFor="projects">
            <Input id="projects" {...register("projects")} />
          </Field2>
          <Field2 label="Aliases (comma-separated)" htmlFor="aliases">
            <Input id="aliases" {...register("aliases")} />
          </Field2>
          {serverError && (
            <p className="text-xs text-destructive" role="alert">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const jobSchema = z.object({
  title: z.string().optional(),
  employer: z.string().optional(),
  team: z.string().optional(),
  managerSlug: z.string().optional(),
  focusAreas: z.string().optional(),
  responsibilities: z.string().optional(),
  stack: z.string().optional(),
  directReports: z.string().optional(),
});

type JobFormShape = z.infer<typeof jobSchema>;

interface EditJobProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: JobProfileInfo | null;
}

function EditJobProfileDialog({
  open,
  onOpenChange,
  initial,
}: EditJobProfileDialogProps): React.ReactElement {
  const qc = useQueryClient();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { isSubmitting } } =
    useForm<JobFormShape>({
      defaultValues: {
        title: initial?.title ?? "",
        employer: initial?.employer ?? "",
        team: initial?.team ?? "",
        managerSlug: initial?.managerSlug ?? "",
        focusAreas: (initial?.focusAreas ?? []).join(", "),
        responsibilities: initial?.responsibilities ?? "",
        stack: (initial?.stack ?? []).join(", "),
        directReports: (initial?.directReports ?? []).join(", "),
      },
    });

  React.useEffect(() => {
    if (!open) return;
    reset({
      title: initial?.title ?? "",
      employer: initial?.employer ?? "",
      team: initial?.team ?? "",
      managerSlug: initial?.managerSlug ?? "",
      focusAreas: (initial?.focusAreas ?? []).join(", "),
      responsibilities: initial?.responsibilities ?? "",
      stack: (initial?.stack ?? []).join(", "),
      directReports: (initial?.directReports ?? []).join(", "),
    });
    setServerError(null);
  }, [open, initial, reset]);

  const mut = useMutation({
    mutationFn: (values: JobFormShape) =>
      apiPost("/api/dashboard/identity/job-profile", {
        ...(values.title ? { title: values.title } : {}),
        ...(values.employer ? { employer: values.employer } : {}),
        ...(values.team ? { team: values.team } : {}),
        ...(values.managerSlug ? { managerSlug: values.managerSlug } : {}),
        ...(values.focusAreas
          ? { focusAreas: splitList(values.focusAreas) }
          : {}),
        ...(values.responsibilities
          ? { responsibilities: values.responsibilities }
          : {}),
        ...(values.stack ? { stack: splitList(values.stack) } : {}),
        ...(values.directReports
          ? { directReports: splitList(values.directReports) }
          : {}),
      }),
    async onSuccess() {
      await qc.invalidateQueries({ queryKey: ["dashboard", "identity"] });
      onOpenChange(false);
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const parsed = jobSchema.safeParse(values);
    if (!parsed.success) {
      setServerError(parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    try {
      await mut.mutateAsync(parsed.data);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404 && err.body.error === "module_unavailable") {
          setServerError(
            "Job profile module not installed on this Cortex instance.",
          );
          return;
        }
        setServerError(err.body.error ?? "Save failed");
        return;
      }
      setServerError("Save failed");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit job profile</DialogTitle>
          <DialogDescription>
            Patches only the fields you set. Comma-separate
            multi-value fields.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={onSubmit} noValidate>
          <Row>
            <Field2 label="Title" htmlFor="title">
              <Input id="title" {...register("title")} />
            </Field2>
            <Field2 label="Employer" htmlFor="employer">
              <Input id="employer" {...register("employer")} />
            </Field2>
          </Row>
          <Row>
            <Field2 label="Team" htmlFor="team">
              <Input id="team" {...register("team")} />
            </Field2>
            <Field2 label="Manager slug" htmlFor="managerSlug">
              <Input id="managerSlug" {...register("managerSlug")} />
            </Field2>
          </Row>
          <Field2 label="Focus areas (comma-separated)" htmlFor="focusAreas">
            <Input id="focusAreas" {...register("focusAreas")} />
          </Field2>
          <Field2 label="Stack (comma-separated)" htmlFor="stack">
            <Input id="stack" {...register("stack")} />
          </Field2>
          <Field2 label="Direct reports (comma-separated)" htmlFor="directReports">
            <Input id="directReports" {...register("directReports")} />
          </Field2>
          <Field2 label="Responsibilities" htmlFor="responsibilities">
            <Input id="responsibilities" {...register("responsibilities")} />
          </Field2>
          {serverError && (
            <p className="text-xs text-destructive" role="alert">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}

function Field2({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
