import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchProjects,
  ingestToCortex,
  pingCortex,
  type CortexProject,
} from "../lib/cortex-api";
import {
  DEFAULT_API_BASE,
  DEFAULT_DASHBOARD_BASE,
  DEFAULT_SCOPE_MODE,
  DEFAULT_TYPE,
  getApiBase,
  getDashboardBase,
  getLastProject,
  getLastType,
  getPausedHosts,
  getRecentIngests,
  getScopeHosts,
  getScopeMode,
  pauseHost,
  pushRecentIngest,
  setApiBase,
  setDashboardBase,
  setLastProject,
  setLastType,
  setScopeHosts,
  setScopeMode,
  unpauseHost,
  type ScopeMode,
} from "../lib/storage";
import type {
  CortexType,
  ExtractorResult,
  InboundMessage,
  OutboundMessage,
  RecentIngest,
} from "../lib/types";

const TYPE_OPTIONS: CortexType[] = [
  "doc",
  "conversation",
  "note",
  "meeting",
  "brief",
  "decision",
  "digest",
  "code",
];

type Status = "idle" | "working" | "success" | "error";
type Health = "unknown" | "ok" | "down";

interface Banner {
  kind: "success" | "error" | "info";
  message: string;
}

export function Popup(): JSX.Element {
  const [apiBase, setApiBaseState] = useState(DEFAULT_API_BASE);
  const [dashboardBase, setDashboardBaseState] = useState(DEFAULT_DASHBOARD_BASE);
  const [health, setHealth] = useState<Health>("unknown");
  const [projects, setProjects] = useState<CortexProject[]>([]);
  const [project, setProject] = useState<string>("");
  const [type, setType] = useState<CortexType>(DEFAULT_TYPE);
  const [tags, setTags] = useState<string>("");
  const [tabTitle, setTabTitle] = useState("");
  const [tabUrl, setTabUrl] = useState("");
  const [tabHost, setTabHost] = useState<string>("");
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [extracted, setExtracted] = useState<ExtractorResult | null>(null);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [recent, setRecent] = useState<RecentIngest[]>([]);

  // Bridge scope + pause state.
  const [scopeMode, setScopeModeState] = useState<ScopeMode>(DEFAULT_SCOPE_MODE);
  const [scopeHostsInput, setScopeHostsInput] = useState("");
  const [pausedHosts, setPausedHostsState] = useState<string[]>([]);

  /* Bootstrap: read storage, active tab, projects, ping /health. */
  useEffect(() => {
    void (async () => {
      const [
        base,
        dashBase,
        lastProject,
        lastType,
        recents,
        sMode,
        sHosts,
        pHosts,
      ] = await Promise.all([
        getApiBase(),
        getDashboardBase(),
        getLastProject(),
        getLastType(),
        getRecentIngests(),
        getScopeMode(),
        getScopeHosts(),
        getPausedHosts(),
      ]);
      setApiBaseState(base);
      setDashboardBaseState(dashBase);
      setProject(lastProject);
      setType(lastType);
      setRecent(recents);
      setScopeModeState(sMode);
      setScopeHostsInput(sHosts.join(", "));
      setPausedHostsState(pHosts);

      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        setTabTitle(tab.title ?? "");
        setTabUrl(tab.url ?? "");
        setTabId(tab.id);
        setTitle(tab.title ?? "");
        setTabHost(hostnameOf(tab.url ?? ""));
      }

      // Health + projects in parallel — projects gets an empty array on
      // failure so the UI stays usable even if the server is down.
      const [ok, list] = await Promise.all([
        pingCortex(base),
        fetchProjects(base),
      ]);
      setHealth(ok ? "ok" : "down");
      setProjects(list);
    })();
  }, []);

  const persistApiBase = useCallback(
    async (next: string): Promise<void> => {
      setApiBaseState(next);
      await setApiBase(next);
      const [ok, list] = await Promise.all([
        pingCortex(next),
        fetchProjects(next),
      ]);
      setHealth(ok ? "ok" : "down");
      setProjects(list);
    },
    [],
  );

  const onExtract = useCallback(async () => {
    if (tabId === undefined) {
      setBanner({ kind: "error", message: "No active tab." });
      return;
    }
    setStatus("working");
    setBanner({ kind: "info", message: "Extracting page content…" });
    try {
      const resp = (await chrome.tabs.sendMessage(tabId, {
        type: "EXTRACT_THREAD",
      } as InboundMessage)) as OutboundMessage | undefined;
      if (!resp || resp.type !== "EXTRACT_RESULT") {
        throw new Error("No response from content script.");
      }
      if (!resp.ok) throw new Error(resp.error);
      setExtracted(resp.result);
      setContent(resp.result.content);
      setTitle(resp.result.title);
      // Suggest a type based on the extractor but don't override an
      // already-picked type — the user may have a preference.
      setType((prev) => prev || resp.result.suggestedType);
      setStatus("idle");
      setBanner({
        kind: "success",
        message: `Extracted ${resp.result.content.length.toLocaleString()} chars from ${resp.result.source}.`,
      });
    } catch (err) {
      setStatus("error");
      setBanner({
        kind: "error",
        message: `Extract failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [tabId]);

  const onIngest = useCallback(async () => {
    if (!project.trim()) {
      setBanner({ kind: "error", message: "Pick or type a project first." });
      return;
    }
    if (!content.trim()) {
      setBanner({
        kind: "error",
        message: "Nothing to ingest — extract the page or paste content first.",
      });
      return;
    }
    setStatus("working");
    setBanner({ kind: "info", message: "Sending to Cortex…" });
    const sourceId =
      extracted?.sourceId ?? `page:${btoa(tabUrl || `unknown-${Date.now()}`)}`;
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const result = await ingestToCortex(apiBase, {
      content,
      project: project.trim(),
      type,
      sourceId,
      title: title || tabTitle,
      sourceUrl: extracted?.sourceUrl ?? tabUrl,
      tags: tagList,
      source: extracted ? mapExtractorSource(extracted.source) : "manual",
    });

    if (!result.ok) {
      setStatus("error");
      setBanner({
        kind: "error",
        message: `Ingest failed: ${result.error ?? "unknown error"}`,
      });
      return;
    }
    await Promise.all([
      setLastProject(project.trim()),
      setLastType(type),
      pushRecentIngest({
        sourceId,
        title: title || tabTitle || "untitled",
        project: project.trim(),
        type,
        sourceUrl: extracted?.sourceUrl ?? tabUrl,
        at: new Date().toISOString(),
      }),
    ]);
    setRecent(await getRecentIngests());
    setStatus("success");
    setBanner({
      kind: "success",
      message: `Ingested ${result.count ?? 1} memor${(result.count ?? 1) === 1 ? "y" : "ies"} into ${project.trim()}.`,
    });
  }, [
    apiBase,
    content,
    extracted,
    project,
    tabTitle,
    tabUrl,
    tags,
    title,
    type,
  ]);

  const projectOptions = useMemo(
    () =>
      projects.map((p) => ({
        value: p.slug,
        label: p.name ? `${p.slug} — ${p.name}` : p.slug,
      })),
    [projects],
  );

  const onScopeChange = useCallback(async (next: ScopeMode) => {
    setScopeModeState(next);
    await setScopeMode(next);
  }, []);

  const onScopeHostsBlur = useCallback(async () => {
    const hosts = scopeHostsInput
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    await setScopeHosts(hosts);
    setScopeHostsInput(hosts.join(", "));
  }, [scopeHostsInput]);

  const isPaused = !!tabHost && pausedHosts.includes(tabHost);
  const onTogglePause = useCallback(async () => {
    if (!tabHost) return;
    if (isPaused) {
      await unpauseHost(tabHost);
    } else {
      await pauseHost(tabHost);
    }
    setPausedHostsState(await getPausedHosts());
  }, [tabHost, isPaused]);

  return (
    <div className="cortex-popup flex w-[380px] flex-col gap-3 p-3 text-[13px] text-neutral-900 dark:text-neutral-100 dark:bg-neutral-950 bg-white">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-tight text-base">Cortex</span>
          <StatusDot health={health} />
        </div>
        <a
          className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
          href={`${dashboardBase}/`}
          target="_blank"
          rel="noreferrer"
        >
          dashboard ↗
        </a>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">API base</span>
          <input
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            value={apiBase}
            onChange={(e) => setApiBaseState(e.target.value)}
            onBlur={() => void persistApiBase(apiBase)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Dashboard URL</span>
          <input
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            value={dashboardBase}
            onChange={(e) => setDashboardBaseState(e.target.value)}
            onBlur={() => void setDashboardBase(dashboardBase)}
          />
        </label>
      </div>

      <section className="rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
            Scope (what Claude can see)
          </span>
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <ScopeRadio
            name="cortex-scope"
            current={scopeMode}
            value="all"
            label="All tabs"
            onChange={onScopeChange}
          />
          <ScopeRadio
            name="cortex-scope"
            current={scopeMode}
            value="active"
            label="Active tab only"
            onChange={onScopeChange}
          />
          <ScopeRadio
            name="cortex-scope"
            current={scopeMode}
            value="allowlist"
            label="Allowlist"
            onChange={onScopeChange}
          />
        </div>
        {scopeMode === "allowlist" ? (
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-[10px] text-neutral-500">
              Comma-separated hosts (e.g. outlook.office.com, jira.atlassian.net)
            </span>
            <input
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              value={scopeHostsInput}
              onChange={(e) => setScopeHostsInput(e.target.value)}
              onBlur={() => void onScopeHostsBlur()}
              placeholder="outlook.office.com, jira.atlassian.net"
            />
          </label>
        ) : null}
        {tabHost ? (
          <button
            className="mt-2 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            onClick={() => void onTogglePause()}
            type="button"
          >
            {isPaused
              ? `Resume Cortex on ${tabHost}`
              : `Pause Cortex on ${tabHost}`}
          </button>
        ) : null}
      </section>

      <section className="rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="text-xs text-neutral-500">Active tab</div>
        <div className="truncate font-medium" title={tabTitle}>
          {tabTitle || "(no title)"}
        </div>
        <div className="truncate text-xs text-neutral-500" title={tabUrl}>
          {tabUrl}
        </div>
        <button
          className="mt-2 w-full rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          onClick={() => void onExtract()}
          disabled={status === "working" || tabId === undefined}
        >
          Extract thread
        </button>
      </section>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">Content</span>
        <textarea
          className="h-32 w-full resize-none rounded border border-neutral-300 bg-white p-2 font-mono text-[11px] dark:border-neutral-700 dark:bg-neutral-900"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Click 'Extract thread' or paste content here."
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Project</span>
          <input
            list="cortex-projects"
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="project-slug"
          />
          <datalist id="cortex-projects">
            {projectOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Type</span>
          <select
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            value={type}
            onChange={(e) => setType(e.target.value as CortexType)}
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">Title (optional)</span>
        <input
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">
          Tags (comma-separated)
        </span>
        <input
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="e.g. followup, q2-plan"
        />
      </label>

      <button
        className="w-full rounded bg-emerald-600 px-2 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        onClick={() => void onIngest()}
        disabled={status === "working"}
      >
        {status === "working" ? "Ingesting…" : "Ingest to Cortex"}
      </button>

      {banner ? (
        <div
          className={`rounded px-2 py-1 text-xs ${
            banner.kind === "success"
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
              : banner.kind === "error"
                ? "bg-rose-100 text-rose-900 dark:bg-rose-900 dark:text-rose-100"
                : "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      {recent.length > 0 ? (
        <section>
          <div className="mb-1 text-xs font-medium text-neutral-500">
            Recent
          </div>
          <ul className="flex flex-col gap-1">
            {recent.slice(0, 10).map((r) => (
              <li
                key={`${r.sourceId}-${r.at}`}
                className="truncate rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800"
                title={`${r.project} / ${r.type} — ${r.at}`}
              >
                <a
                  href={r.sourceUrl}
                  className="text-indigo-600 hover:underline dark:text-indigo-400"
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.title || r.sourceId}
                </a>{" "}
                <span className="text-neutral-500">
                  · {r.project} · {r.type}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ScopeRadio({
  name,
  current,
  value,
  label,
  onChange,
}: {
  name: string;
  current: ScopeMode;
  value: ScopeMode;
  label: string;
  onChange: (v: ScopeMode) => void | Promise<void>;
}): JSX.Element {
  return (
    <label className="inline-flex items-center gap-2">
      <input
        type="radio"
        name={name}
        checked={current === value}
        onChange={() => void onChange(value)}
      />
      <span>{label}</span>
    </label>
  );
}

function StatusDot({ health }: { health: Health }): JSX.Element {
  const color =
    health === "ok"
      ? "bg-emerald-500"
      : health === "down"
        ? "bg-rose-500"
        : "bg-neutral-400";
  const label =
    health === "ok" ? "connected" : health === "down" ? "unreachable" : "…";
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${color}`}
      title={`Cortex API: ${label}`}
      aria-label={`Cortex API ${label}`}
    />
  );
}

function mapExtractorSource(
  s: ExtractorResult["source"],
): "slack" | "email" | "teams" | "manual" {
  return s;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
