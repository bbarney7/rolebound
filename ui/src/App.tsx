import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AccountDetailPayload,
  type AddressesPayload,
  type Application,
  type ApplicationDetailPayload,
  type ATSAccount,
  type Overview,
  type ProfilePayload,
  type QueueItem,
  type ResumesPayload,
  type RunStartBody,
  type RunSummary,
} from "../shared/types";
import {
  fetchApplication,
  fetchApplications,
  fetchOverview,
  fetchQueue,
  removeQueueItem,
} from "./api";
import { fetchAccount, fetchAccounts } from "./accounts";
import { fetchAddresses, fetchProfile, fetchResumes } from "./profile";
import ApplicationList, { RecentApplications } from "./ApplicationList";
import ApplicationDetail from "./ApplicationDetail";
import QueueList from "./QueueList";
import QueueAdd from "./QueueAdd";
import AccountsList from "./AccountsList";
import AccountDetail from "./AccountDetail";
import AccountAdd from "./AccountAdd";
import { overviewResourceLoadFlags } from "./overviewLoadState";
// Named SettingsPanel.tsx, not Settings.tsx: TypeScript 7's bundler module
// resolution probes the ".ts" extension before ".tsx" and, on a
// case-insensitive filesystem, that probe case-insensitively matches
// settings.ts before ever trying Settings.tsx — resolving "./Settings" to the
// wrong module. A component name distinct from the helper module's stem
// sidesteps the collision instead of relying on a compiler flag.
import Settings from "./SettingsPanel";
import ProfileView from "./ProfileView";
import SetupView from "./SetupView";
import { useRun, type RunEntry } from "./useRun";
import { fetchConnections, fetchReadiness } from "./settings";
import type { ConnectionList } from "../shared/providers";
import type { ReadinessPayload } from "../shared/types";
import { connectSse } from "./sse";
import type { ConnectionState } from "./sse";
import { parseRoute, pathForRoute, type RouteView } from "./router";
import ChatPane from "./chat/ChatPane";
import { planChatModelSwitch } from "./chat/chatModelSwitch";
import { connectionLabelFor, effectiveChatSelection } from "./chat/modelSelection";
import ChatShell, { type ModelPillState } from "./chat/ChatShell";
import FirstLaunch from "./chat/FirstLaunch";
import SearchRail from "./chat/SearchRail";
import WorkspaceDrawer, {
  WORKSPACE_SECTION_STORAGE,
  activeWorkspaceSection,
  hrefForStoredSection,
  type WorkspaceSectionId,
} from "./chat/WorkspaceDrawer";
import { applyTheme, readTheme, resolvedTheme, type ThemeChoice } from "./chat/theme";
import TodayView from "./components/TodayView";
import DiscoverView from "./components/DiscoverView";
import InstructionsView from "./InstructionsView";
import Topbar from "./Topbar";

type View = Exclude<RouteView, "not-found">;

/**
 * The rail's five static views. Selection is carried by `aria-current` on the
 * button: index.css keys the inset accent bar, weight and fill off that
 * attribute, so the visual and the assistive-tech signal cannot drift apart
 * and no state is conveyed by colour alone.
 *
 * "Run" is NOT in this list: its trailing slot holds a live status stamp
 * rather than a count, so ViewNav renders it directly.
 *
 * Profile goes LAST here, which puts it ABOVE Run on screen — a deliberate
 * move, not a no-op. The row it replaces was rendered after the Run button, so
 * Profile used to sit at the bottom. Run keeps the last slot on purpose: it is
 * the transient, status-carrying row, and grouping the navigable sections above
 * it is the reason VIEWS exists as a list at all.
 */
/**
 * What a view shows before its data has arrived. `error` is checked first so
 * an outage (every fetch failing) shows the failure rather than "Loading…".
 *
 * `error` now means "the newest whole refresh did not succeed": `refresh`
 * clears it only when all three of its fetches came back, so a list route that
 * 500s beside a working overview shows the failure instead of sitting on
 * "Loading…" forever. The detail fetch keeps its own `detailError` and does not
 * participate. The connection line still reports the error too — this block is
 * additive.
 */
function Pending({ error }: { error: string | null }) {
  if (error !== null) {
    return (
      <div className="state crit">
        <span className="glyph" aria-hidden="true">
          !
        </span>
        <p>{`API error: ${error}`}</p>
        <p className="mono">Is the API server running on 127.0.0.1:4747?</p>
      </div>
    );
  }
  return (
    <div className="state">
      <p>Loading…</p>
    </div>
  );
}

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const initialRoute = parseRoute(window.location.href);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialRoute.slug ?? null);
  const [detail, setDetail] = useState<ApplicationDetailPayload | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [search, setSearch] = useState(initialRoute.search);
  const [tabRequest, setTabRequest] = useState(0);
  const [statusFilter, setStatusFilter] = useState(initialRoute.status);
  const [applyStateFilter, setApplyStateFilter] = useState(initialRoute.applyState);
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [fromDate, setFromDate] = useState(initialRoute.from);
  const [toDate, setToDate] = useState(initialRoute.to);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [view, setView] = useState<View>(initialRoute.view === "not-found" ? "chat" : initialRoute.view);
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [runHistory, setRunHistory] = useState<RunEntry[]>([]);
  const [chatNotes, setChatNotes] = useState<RunEntry[]>([]);
  const continueFromRef = useRef<string | null>(null);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readTheme());
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const [route404, setRoute404] = useState(initialRoute.view === "not-found");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ATSAccount[]>([]);
  const [accountDetail, setAccountDetail] = useState<AccountDetailPayload | null>(null);
  const [accountDetailError, setAccountDetailError] = useState<string | null>(null);
  const [selectedAccountHost, setSelectedAccountHost] = useState<string | null>(initialRoute.accountHost ?? null);
  const [accountFilter, setAccountFilter] = useState("");
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [resumes, setResumes] = useState<ResumesPayload | null>(null);
  const [addresses, setAddresses] = useState<AddressesPayload | null>(null);

  const navigate = useCallback((next: View, options: { replace?: boolean; slug?: string; accountHost?: string; tab?: string; search?: string; status?: string; applyState?: string; from?: string; to?: string } = {}) => {
    const path = pathForRoute({
      view: next,
      slug: options.slug,
      accountHost: options.accountHost,
      tab: options.tab ?? (next === "profile" ? new URLSearchParams(window.location.search).get("tab") ?? "" : ""),
      search: options.search ?? search,
      status: options.status ?? statusFilter,
      applyState: options.applyState ?? applyStateFilter,
      from: options.from ?? fromDate,
      to: options.to ?? toDate,
    });
    if (window.location.pathname !== path) {
      window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
    }
    setRoute404(false);
    setView(next);
  }, [applyStateFilter, fromDate, search, statusFilter, toDate]);

  const navigateHref = useCallback((href: string) => {
    const route = parseRoute(href.startsWith("http") ? href : `http://127.0.0.1${href.startsWith("/") ? href : `/${href}`}`);
    if (route.view === "not-found") return;
    if (route.tab) {
      const path = pathForRoute(route);
      window.history.pushState({}, "", path);
      // ProfileView owns its tab state; this tells it to re-read the tab from the URL.
      setTabRequest((n) => n + 1);
    }
    setSearch(route.search);
    setStatusFilter(route.status);
    setApplyStateFilter(route.applyState);
    setFromDate(route.from);
    setToDate(route.to);
    navigate(route.view, { tab: route.tab, search: route.search, status: route.status, applyState: route.applyState, from: route.from, to: route.to });
  }, [navigate]);

  const openApplication = useCallback((slug: string) => {
    setSelectedSlug(slug);
    navigate("applications", { slug });
  }, [navigate]);

  const openAccount = useCallback((host: string) => {
    setSelectedAccountHost(host);
    navigate("accounts", { accountHost: host });
  }, [navigate]);

  useEffect(() => {
    if (view !== "applications" || selectedSlug) return;
    const next = pathForRoute({ view: "applications", tab: "", search, status: statusFilter, applyState: applyStateFilter, from: fromDate, to: toDate });
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState({}, "", next);
  }, [applyStateFilter, fromDate, search, selectedSlug, statusFilter, toDate, view]);

  useEffect(() => {
    const onPopState = () => {
      setSelectedSlug(null);
      setSelectedAccountHost(null);
      const next = parseRoute(window.location.href);
      setRoute404(next.view === "not-found");
      if (next.view !== "not-found") {
        setView(next.view);
        setSearch(next.search);
        setStatusFilter(next.status);
        setApplyStateFilter(next.applyState);
        setFromDate(next.from);
        setToDate(next.to);
        setSelectedSlug(next.slug ?? null);
        setSelectedAccountHost(next.accountHost ?? null);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  // SECTION-LOCAL, and never the global `error`. `settle` owns that one and it
  // drives the rail and the connection line, so a failing profile route voting
  // there would block an unrelated view's error from ever clearing. The profile
  // chain sets this under `fresh()` and clears it on success; the profile branch
  // renders it as `profileError ?? error`, exactly as detailError stays out of
  // the global banner.
  const [profileError, setProfileError] = useState<string | null>(null);
  // True from the instant the stream reaches `open` until the cold-start refresh
  // that follows it has settled. In that window the socket is live but the
  // rendered data is still whatever was on screen before the outage, so
  // reporting "connected" would present a stale view as current. `open` alone
  // means "the stream is live"; `open && !resyncing` means "the stream is live
  // AND the data is current", and only the second may be shown as normal status.
  const [resyncing, setResyncing] = useState(false);

  // The agent run is a whole second data source with its own stream, its own
  // lifecycle and its own errors, so it lives in its own hook rather than in
  // the state block above. Nothing in `refresh` or the watcher SSE effect
  // knows about it.
  const {
    run,
    entries: runEntries,
    busy: runBusy,
    error: runError,
    draft: runDraft,
    setDraft: setRunDraft,
    start: runStart,
    reply: runReply,
    respondUi: runRespondUi,
    abort: runAbort,
    finish: runFinish,
  } = useRun();

  const prevRunIdRef = useRef<string | null>(null);
  const prevRunEntriesRef = useRef<RunEntry[]>([]);

  // The refs are written here, after the commit, never during render: in the
  // render where the runId changes, runEntries already belong to the NEW run.
  useEffect(() => {
    const runId = run?.runId ?? null;
    const prevId = prevRunIdRef.current;
    if (prevId !== null && runId !== prevId && prevRunEntriesRef.current.length > 0) {
      // Entry keys are `e<seq>`, and seq restarts with the server process, so
      // archived entries get a run-scoped key that cannot collide with live ones.
      const archived = prevRunEntriesRef.current.map((entry) => ({ ...entry, key: `${prevId}-${entry.key}` }));
      setRunHistory((history) => [
        ...history,
        ...archived,
        { kind: "system", key: `end-${prevId}`, text: "Session ended" },
      ]);
    }
    prevRunIdRef.current = runId;
    prevRunEntriesRef.current = runEntries;
  }, [run?.runId, runEntries]);

  useEffect(() => {
    if (view === "chat" || view === "run") return;
    const tab = new URLSearchParams(window.location.search).get("tab") ?? "";
    const section = activeWorkspaceSection(view, tab);
    if (!section) return;
    try {
      window.localStorage.setItem(WORKSPACE_SECTION_STORAGE, section);
    } catch {
      /* ignore */
    }
  }, [view]);

  // Mirrors selectedSlug for `refresh`, whose dependency array must stay []
  // so the SSE effect never re-subscribes. Also the staleness discriminator:
  // an in-flight detail response is dropped unless this still matches the
  // slug it was issued for. Written by the selection effect below.
  const selectedSlugRef = useRef<string | null>(null);

  // Monotonic detail-request version. The slug check alone cannot order two
  // requests for the SAME slug: a GET issued before a PATCH can resolve after it
  // and overwrite the authoritative PATCH payload with pre-edit data. Every
  // detail request takes a version; a response is applied only if its version is
  // still the newest. handleSaved bumps it so in-flight GETs are invalidated.
  const detailRequestRef = useRef(0);

  // Mirrors selectedAccountHost for `refresh`, whose dependency array must stay
  // [] so the SSE effect never re-subscribes. Also the staleness discriminator
  // for the account detail, exactly as selectedSlugRef is for the application
  // detail. Written by the selection effect below — and by hand in the two
  // handlers that start a refresh in their own tick, because an effect runs
  // after the commit and is therefore too late for them.
  const selectedAccountHostRef = useRef<string | null>(null);

  // Monotonic account-detail request version, the accounts twin of
  // detailRequestRef and there for the same reason: the host check alone cannot
  // order two requests for the SAME host, so a GET issued before a PATCH can
  // resolve after it and overwrite post-edit data with pre-edit data.
  const accountDetailRequestRef = useRef(0);

  // Monotonic version for EVERY refresh, whatever triggered it. `resyncing`
  // clears only when the newest issued refresh settles.
  //
  // Versioning just the connection transition is not enough: a change event
  // arriving during a cold-start resync issues a second refresh, and if the
  // first settles last it would clear `resyncing` while strictly newer data is
  // still in flight — declaring the view current at the one moment we know it
  // is not. Entering `open` also bumps this, so an in-flight refresh from a
  // previous connection cannot clear the resync belonging to this one.
  const refreshSeqRef = useRef(0);

  // Whether the CURRENT connection's server-side watcher is confirmed armed.
  // Reset on every `open`, set only by a confirmed `watching` frame.
  //
  // One rule governs the whole currency question: `resyncing` may be cleared
  // only by a refresh issued AFTER this is true. Everything else — a refresh on
  // provisional grace readiness, or one triggered by a change event that
  // arrived before `watching` — is worth making but cannot certify the result,
  // because until the initial scan finishes a write to an as-yet-unscanned path
  // is invisible to both the read and the stream.
  //
  // A change event is NOT proof on its own: chokidar's `ignoreInitial`
  // suppresses initial *adds*, not genuine *changes* to paths it has already
  // attached to, so a real change can arrive mid-scan.
  const watcherConfirmedRef = useRef(false);

  const refresh = useCallback((seq: number) => {
    // A refresh is superseded the moment a newer one is issued, so every write
    // below is gated on still being the newest. Two refreshes are routinely in
    // flight at once — a cold start racing a change event — and HTTP responses
    // are not guaranteed to arrive in request order, so the older one can land
    // last and overwrite newer data.
    //
    // That was survivable before `resyncing` existed, because the UI made no
    // claim about currency and the next event corrected it. It is not
    // survivable now: `resyncing` clears when the NEWEST refresh settles, so an
    // older response landing after that paints stale data underneath a status
    // line that says the view is current — exactly the thing AC #3 forbids.
    // The detail fetch below has always been guarded this way; this extends the
    // same discipline to the two writes that were not.
    const fresh = () => refreshSeqRef.current === seq;
    // Each chain reports whether it SUCCEEDED, because clearing the error is a
    // decision about the refresh as a whole and no single fetch can make it.
    // The overview used to clear it on its own success, which hid a failing
    // list route behind a permanent "Loading…".
    const overviewDone = fetchOverview()
      .then((o) => {
        if (fresh()) setOverview(o);
        return true;
      })
      .catch((e) => {
        if (fresh()) setError(String(e));
        return false;
      });
    const listDone = fetchApplications()
      .then((a) => {
        if (fresh()) setApplications(a);
        return true;
      })
      .catch((e) => {
        if (fresh()) setError(String(e));
        return false;
      });
    // ABOVE the early return below, deliberately. `refresh` short-circuits when
    // no row is selected, and the list view — the only view that shows the
    // queue — is exactly the case where nothing is selected. A queue fetch
    // placed after that return would never run where it is needed.
    //
    // It joins `fresh()` rather than carrying its own version counter: that gate
    // already retires superseded responses, and a queue mutation invalidates
    // in-flight fetches by bumping refreshSeqRef, exactly as handleSaved does
    // for the list. One sequence, one rule.
    const queueDone = fetchQueue()
      .then((q) => {
        if (fresh()) setQueue(q);
        return true;
      })
      .catch((e) => {
        if (fresh()) setError(String(e));
        return false;
      });
    // ABOVE the early return below for the same reason the queue chain is: the
    // accounts view is another case where nothing is selected, so an accounts
    // fetch placed after that return would never run where it is needed. It
    // joins `fresh()` rather than carrying its own counter — one sequence, one
    // rule — and an account mutation invalidates in-flight fetches by bumping
    // refreshSeqRef, exactly as a queue mutation does.
    const accountsDone = fetchAccounts()
      .then((a) => {
        if (fresh()) setAccounts(a);
        return true;
      })
      .catch((e) => {
        if (fresh()) setError(String(e));
        return false;
      });
    // ABOVE the early return below for the same reason the queue and accounts
    // chains are: the profile view is another case where nothing is selected,
    // so a fetch placed after that return would never run where it is needed.
    // It joins `fresh()` rather than carrying its own request-version ref —
    // one sequence, one rule — because there is no per-item selection to order.
    //
    // Its failure is reported through `profileError` ALONE and never votes in
    // `settle`. The three routes move together: they are one section's data, and
    // a partial write of them would paint a resume table against a stale
    // profile. Awaited by Promise.all, which is what the caller needs, but its
    // value is never destructured — exactly as accountDetailDone's is not.
    const readinessDone = fetchReadiness()
      .then((value) => {
        if (fresh()) setReadiness(value);
      })
      .catch(() => {
        if (fresh()) setReadiness(null);
      });
    const connectionsDone = fetchConnections()
      .then((value) => {
        if (fresh()) setConnections(value);
      })
      .catch(() => {
        if (fresh()) setConnections(null);
      });
    const profileDone: Promise<void> = Promise.all([
      fetchProfile(),
      fetchResumes(),
      fetchAddresses(),
    ])
      .then(([p, r, a]) => {
        if (fresh()) {
          setProfile(p);
          setResumes(r);
          setAddresses(a);
          setProfileError(null);
        }
      })
      .catch((e) => {
        if (fresh()) setProfileError(String(e));
      });
    // Keep an open ACCOUNT detail live, exactly as detailDone below does for an
    // open application: a credentials.json write from outside this tab — the
    // agent creating an account mid-run, or a second browser tab — has to reach
    // the open account and not just the list (AC 8).
    //
    // Fenced by its own version ref AND a host check, because neither orders
    // two requests on its own. With nothing selected there is nothing to fetch
    // and no version to burn, so it resolves immediately; either way it is
    // awaited but never destructured, exactly as detailDone is.
    const accountHost = selectedAccountHostRef.current;
    let accountDetailDone: Promise<void> = Promise.resolve();
    if (accountHost !== null) {
      const accountVersion = ++accountDetailRequestRef.current;
      const accountCurrent = () =>
        accountDetailRequestRef.current === accountVersion && selectedAccountHostRef.current === accountHost;
      accountDetailDone = fetchAccount(accountHost)
        .then((d) => {
          // Clearing the error on success is what makes a transient failure
          // recoverable, for the same reason it is on the application detail:
          // accountDetailError takes precedence in the render switch and is
          // otherwise only reset when selectedAccountHost changes.
          if (accountCurrent()) {
            setAccountDetail(d);
            setAccountDetailError(null);
          }
        })
        .catch((e) => {
          if (accountCurrent()) setAccountDetailError(String(e));
        });
    }
    // Keep an open detail view live. Without this, a status changed in another
    // tab, or any workspace write the applier makes, refreshes the list behind
    // the detail while the detail itself stays stale indefinitely — even though
    // the SSE event did arrive.
    // Clearing the error is decided HERE, once, on the whole refresh — and the
    // `fresh()` re-check at aggregate time is the point of doing it here. A
    // superseded refresh that happens to succeed after a newer one has already
    // failed must not clear the newer failure, and by the time this runs
    // `refreshSeqRef.current !== seq` says so. The fencing above is unchanged.
    const settle = (overviewOk: boolean, listOk: boolean, queueOk: boolean, accountsOk: boolean) => {
      if (fresh() && overviewOk && listOk && queueOk && accountsOk) setError(null);
    };
    const slug = selectedSlugRef.current;
    if (!slug) {
      return Promise.all([overviewDone, listDone, queueDone, accountsDone, profileDone, readinessDone, connectionsDone, accountDetailDone]).then(([o, l, q, a]) => settle(o, l, q, a));
    }
    const version = ++detailRequestRef.current;
    const current = () => detailRequestRef.current === version && selectedSlugRef.current === slug;
    const detailDone = fetchApplication(slug)
      .then((d) => {
        // Clearing the error on success is what makes a transient failure
        // recoverable. detailError takes precedence in the render switch and
        // is otherwise only reset when selectedSlug changes, so without this a
        // single failed refresh — the dev server restarting under `tsx watch`
        // is enough — wedges the detail view in an error state forever while
        // fresh data keeps arriving behind it.
        if (current()) {
          setDetail(d);
          setDetailError(null);
        }
      })
      .catch((e) => {
        if (current()) setDetailError(String(e));
      });
    return Promise.all([overviewDone, listDone, queueDone, accountsDone, profileDone, readinessDone, connectionsDone, detailDone, accountDetailDone]).then(([o, l, q, a]) =>
      settle(o, l, q, a),
    );
  }, []);

  // One refresh, version-stamped, that clears `resyncing` only if it is still
  // the newest one outstanding when it settles. Stable identity: `refresh` has
  // [] deps and the two setters are useState setters, so this does not
  // destabilise the SSE effect's [refresh] dependency array.
  const runRefresh = useCallback((currentAfter: boolean) => {
    const seq = ++refreshSeqRef.current;
    void refresh(seq).finally(() => {
      // `currentAfter` is false only for a refresh issued because the readiness
      // grace timer expired without the server confirming its watcher is armed.
      // That refresh is still worth making — it is the freshest data available —
      // but it cannot be called *current*, because a write during chokidar's
      // initial scan is invisible to both it and the stream. `syncing…` holds
      // until the confirming `watching` frame arrives and its refresh lands.
      if (!currentAfter) return;
      if (refreshSeqRef.current === seq) setResyncing(false);
    });
  }, [refresh]);

  // The driver owns the socket, the backoff timer and the liveness watchdog;
  // this effect owns only the subscription. `setConnection`, `setResyncing` and
  // `setLastEvent` are useState setters and `connectSse` is a module import, so
  // none of them is a reactive value — the dependency array stays [refresh], and
  // refresh's own [] deps stay [], or the stream re-subscribes on every render.
  useEffect(() => {
    return connectSse({
      url: "/api/events",
      onState: (state) => {
        setConnection(state);
        if (state !== "open") return;
        // New connection, new watcher: nothing is confirmed until this one says
        // so. Without the reset, a reconnect would inherit the previous
        // connection's confirmation and certify data mid-scan.
        watcherConfirmedRef.current = false;
        // Invalidate any refresh still in flight from the previous connection:
        // its result predates this reconnect and must not clear this resync.
        refreshSeqRef.current += 1;
        // Every reconnect is a cold start: the server writes no `id:` and never
        // reads Last-Event-ID, and it builds a fresh watcher, so anything that
        // changed during the gap was never announced. Refreshing on each open
        // makes "the stream is live" and "the data is current" one invariant,
        // for the first connect and every reconnect alike.
        //
        // The socket being open is NOT the same as the data being current, and
        // the gap between them is a whole round-trip during which the screen
        // still holds pre-outage data. Hold `resyncing` across that gap so the
        // status line never says "watching workspace…" over a stale view.
        //
        // No refresh is issued here — see onReady. Refreshing at `open` would
        // read the workspace before the server's watcher is armed, so a write
        // landing in that window is missed by the read AND swallowed by
        // chokidar's initial scan.
        setResyncing(true);
      },
      onReady: (confirmed) => {
        // Only a confirmed `watching` frame proves that from here on a write is
        // either visible to this read or announced on the stream — which is
        // exactly what makes a settled refresh mean "current".
        if (confirmed) watcherConfirmedRef.current = true;
        runRefresh(confirmed);
      },
      onChange: (file) => {
        if (file !== null) setLastEvent(file);
        // Certifying depends on whether the watcher is confirmed YET, not on
        // the change event itself — see watcherConfirmedRef.
        runRefresh(watcherConfirmedRef.current);
      },
    });
  }, [refresh, runRefresh]);

  useEffect(() => {
    selectedSlugRef.current = selectedSlug;
    setDetail(null);
    setDetailError(null);
    if (!selectedSlug) return;
    // `cancelled` discards a response whose row is no longer selected. Without
    // it, clicking row A then row B before A resolves renders A's payload under
    // B's heading — fetch resolution order is not selection order.
    let cancelled = false;
    const version = ++detailRequestRef.current;
    fetchApplication(selectedSlug)
      .then((d) => {
        if (!cancelled && detailRequestRef.current === version) {
          setDetail(d);
          setDetailError(null);
        }
      })
      .catch((e) => {
        if (!cancelled && detailRequestRef.current === version) setDetailError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug]);

  // The accounts twin of the selection effect above, `cancelled` flag included:
  // opening account A then account B before A resolves must not paint A's
  // payload under B's heading, and fetch resolution order is not selection
  // order.
  //
  // Clearing accountDetail AND accountDetailError on every transition —
  // including the one back to null — is what makes the render branch's error
  // escape hatch self-healing: going back to the list drops the error along
  // with the selection, and nothing else ever clears it. That is deliberate: a
  // stale error must not vanish on its own while the failure is still true.
  //
  // This is also the only writer of selectedAccountHostRef that runs on a
  // schedule, and it runs after the commit — which is exactly why
  // handleAccountDeleted and leaveDetailAnd write the ref by hand. They do not
  // conflict: both assign the same value, so this write is idempotent when it
  // lands.
  useEffect(() => {
    selectedAccountHostRef.current = selectedAccountHost;
    setAccountDetail(null);
    setAccountDetailError(null);
    if (!selectedAccountHost) return;
    let cancelled = false;
    const version = ++accountDetailRequestRef.current;
    fetchAccount(selectedAccountHost)
      .then((d) => {
        if (!cancelled && accountDetailRequestRef.current === version) {
          setAccountDetail(d);
          setAccountDetailError(null);
        }
      })
      .catch((e) => {
        if (!cancelled && accountDetailRequestRef.current === version) setAccountDetailError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountHost]);

  // Keep the list row in step with the PATCH response so returning to the list
  // does not show the pre-edit status until the next SSE-driven refresh. The
  // list update is unconditional — that row's data is correct wherever the user
  // now is — but setDetail is guarded: a PATCH for A that resolves after the
  // user has navigated back and opened B must not paint A under B's heading.
  const handleSaved = useCallback((next: ApplicationDetailPayload) => {
    // Invalidate every in-flight detail GET. The PATCH response is authoritative
    // and strictly newer, so a GET issued before it must not land on top of it.
    detailRequestRef.current += 1;
    // Same reasoning for the LIST. A /api/applications request issued before
    // this PATCH can resolve after it and restore the pre-edit row, silently
    // undoing the user's save until some later event repairs it. Bumping the
    // refresh sequence retires those responses too.
    refreshSeqRef.current += 1;
    if (selectedSlugRef.current === next.application.slug) setDetail(next);
    setApplications((prev) =>
      prev.map((a) => (a.slug === next.application.slug ? next.application : a)),
    );
    // Retiring a refresh is not free: if the one just invalidated was the only
    // one outstanding, nothing is left to settle. During a resync that leaves
    // `syncing…` on screen with no refresh coming to clear it, and at any time
    // it leaves the overview counters stale — a pipeline-status edit changes
    // byPipelineStatus, which the PATCH response does not carry. The SSE change
    // event for this write is debounced and not guaranteed to arrive, so the
    // replacement is issued here rather than waited for.
    runRefresh(watcherConfirmedRef.current);
  }, [runRefresh]);

  // Both queue handlers copy handleSaved's shape above, for the same reasons.
  // Bumping refreshSeqRef retires every in-flight fetch, so a GET issued before
  // this mutation cannot resolve afterwards and restore a row the user just
  // deleted. And because retiring a refresh can leave nothing outstanding to
  // clear `resyncing`, a replacement is issued rather than waited for — the SSE
  // change event for this write is debounced and not guaranteed to arrive.
  // The replacement also repairs overview.queue, which the mutation payload
  // does not carry.
  //
  // THE MUTATION PAYLOAD'S `queue` IS DELIBERATELY NOT APPLIED. It is a
  // snapshot of the moment the server committed, and two mutations can commit
  // in one order and respond in the other — so applying snapshots lets an older
  // one repaint a row a newer one removed. Ordering them client-side does not
  // work either: the client can observe response order, which is not commit
  // order, and every counting scheme built on that has the same hole.
  //
  // So the version-fenced refresh below is the SOLE source of queue state. It
  // reads current state rather than a snapshot, `refreshSeqRef` guarantees only
  // the newest one lands, and it is issued immediately rather than waited for.
  // The cost is one round-trip before the row appears or disappears; the
  // benefit is that there is no stale-snapshot case left to reason about.
  //
  // (This also repairs `overview.queue`, which the payload does not carry.)
  const applyQueueMutation = useCallback(() => {
    refreshSeqRef.current += 1;
    runRefresh(watcherConfirmedRef.current);
  }, [runRefresh]);

  const handleQueueMutated = useCallback(() => {
    setRemoveError(null);
    applyQueueMutation();
  }, [applyQueueMutation]);

  const handleRemove = useCallback(
    (slug: string) => {
      setRemoving(true);
      setRemoveError(null);
      removeQueueItem(slug)
        .then(() => {
          applyQueueMutation();
          setConfirmSlug(null);
          setRemoving(false);
        })
        .catch((e) => {
          setRemoveError(String(e));
          setRemoving(false);
        });
    },
    [applyQueueMutation],
  );

  // The accounts twin of applyQueueMutation, for the same reasons: bumping
  // refreshSeqRef retires every in-flight fetch, so a GET issued before this
  // mutation cannot resolve afterwards and restore a row the user just changed;
  // and because retiring a refresh can leave nothing outstanding to clear
  // `resyncing`, a replacement is issued rather than waited for — the SSE change
  // event for this write is debounced and not guaranteed to arrive. It also
  // repairs `overview.accounts`, which no mutation payload carries.
  //
  // The AccountMutationResult snapshot is deliberately NOT applied, exactly as
  // the queue's is not: it describes the moment the server committed, and two
  // mutations can commit in one order and respond in the other. The
  // version-fenced refresh below is the sole source of accounts state.
  const applyAccountMutation = useCallback(() => {
    refreshSeqRef.current += 1;
    runRefresh(watcherConfirmedRef.current);
  }, [runRefresh]);

  // "An account was added" — AccountAdd's onMutated.
  const handleAccountMutated = useCallback(() => {
    applyAccountMutation();
  }, [applyAccountMutation]);

  // "The open account changed, re-read it" — AccountDetail's onSaved. It leaves
  // selectedAccountHost alone on purpose, so the selection effect and refresh's
  // account-detail chain re-read the still-open account.
  //
  // Identical in body to handleAccountMutated today, and still declared
  // separately: the two answer different questions, so a later "keep the
  // detail's scroll position" or "clear the add form's status line" lands on
  // one without silently changing the other.
  const handleAccountSaved = useCallback(() => {
    applyAccountMutation();
  }, [applyAccountMutation]);

  // "The open account is gone, leave the detail" — AccountDetail's onDeleted.
  const handleAccountDeleted = useCallback(() => {
    // Synchronous, because the refresh below reads the ref in this same tick.
    // selectedAccountHostRef is written by the selection effect, and an effect
    // runs AFTER the render commit — so setSelectedAccountHost(null) alone
    // leaves the ref still holding the host that was just deleted. refresh's
    // account-detail chain would fetch it, get a 404, and set
    // accountDetailError, dropping the user into the error branch immediately
    // after a delete that in fact succeeded. handleSaved reaches into
    // detailRequestRef and refreshSeqRef by hand for exactly this class of
    // reason: a ref a refresh is about to read cannot wait for an effect.
    selectedAccountHostRef.current = null;
    setSelectedAccountHost(null);
    setAccountDetail(null);
    setAccountDetailError(null);
    applyAccountMutation();
  }, [applyAccountMutation]);

  // "A profile section was written" — ProfileView's onMutated, and the twin of
  // applyAccountMutation for the same two reasons: refreshSeqRef retires every
  // in-flight GET so one cannot resolve afterwards and restore what was just
  // saved, and a replacement refresh is issued rather than waited for, because
  // the SSE change event for this write is debounced and not guaranteed.
  //
  // The ProfileMutationResult snapshot is deliberately not applied here either.
  // ProfileView commits its own draft off that response — it needs the exact
  // value the writer stored — but the VIEW's data comes from this refresh alone.
  const handleProfileMutated = useCallback(() => {
    refreshSeqRef.current += 1;
    runRefresh(watcherConfirmedRef.current);
  }, [runRefresh]);

  const live = connection === "open" && !resyncing && !error;
  // Per-resource "has the first fetch landed" gates, from the server's own
  // counts (which arrive with `overview`) — exact for the cases that matter:
  // server says zero → empty state; list non-empty → loaded. Nothing inside
  // `refresh` changes for this.
  const corruptFiles = overview?.corrupt ?? [];
  const { overviewLoaded, applicationsLoaded, accountsLoaded } = overviewResourceLoadFlags(
    overview,
    applications.length,
    accounts.length,
  );
  const queueLoaded = overview !== null && (queue.length > 0 || overview.queue === 0);
  // NOT gated on `overview !== null` like the four above it: the profile payload
  // comes from its own route and carries no count the overview could confirm, so
  // `profile !== null` is the honest predicate. It is also true of a workspace
  // with no profile.md at all — that payload is `exists: false`, which is a
  // state ProfileView renders, not an absence of data.
  const profileLoaded = profile !== null;
  // The rail stays mounted while a detail is open — it is the persistent
  // chrome (wordmark, connection line). A rail click leaves the detail with
  // the same single call the back control makes, then switches view, so there
  // is still exactly one meaning for "leave the detail".
  const leaveDetailAnd = (next: View) => {
    setSelectedSlug(null);
    // Leave the ACCOUNT detail too, or a rail click would switch the view with
    // selectedAccountHost, accountDetail and accountDetailError all still set —
    // so coming back to Accounts would drop the user into the still-open detail
    // or a stale error instead of the list.
    //
    // setSelectedAccountHost(null) alone would do it, since the selection
    // effect clears the other two on that transition. All three are set anyway:
    // a handler named "leave the detail" should read as leaving it without the
    // reader having to trace an effect to be sure, and it keeps this path
    // symmetrical with onBack and onDeleted, which clear explicitly.
    //
    // The ref is cleared for consistency, NOT because a bug is being fixed —
    // and the difference from handleAccountDeleted is worth being exact about.
    // This handler issues no refresh in the same tick, and the host it names has
    // not been removed, so even a refresh that raced the effect would fetch a
    // host that exists, get a 200, and write state the render branch is already
    // ignoring. handleAccountDeleted's ref is stale AND points at a host that is
    // gone AND is read by a refresh that handler itself starts.
    selectedAccountHostRef.current = null;
    setSelectedAccountHost(null);
    setAccountDetail(null);
    setAccountDetailError(null);
    navigate(next);
  };
  // A run holds the workspace lock and the browser profile, so only one can
  // exist. The start controls disable on this rather than on the panel's own
  // state, which is why it lives here and not in RunPanel.
  const runActive =
    run !== null && (run.status === "starting" || run.status === "running" || run.status === "waiting");
  // The queue is only known to be empty once it has actually loaded; before
  // that, let the click through and let the server's 409 sentence explain it.
  const queueEmpty = queueLoaded && queue.length === 0;
  /**
   * Starting a run always lands on the panel, whether or not it worked: that
   * is where both the transcript and the server's refusal sentence appear, and
   * a click that silently did nothing would be worse than either.
   */
  const beginRun = (body: RunStartBody) => {
    void runStart(body);
  };

  const agentSelection = connections?.data.agent;
  const chatSelection = effectiveChatSelection(connections?.data.chat, agentSelection);
  // Readiness checks the applying model; a separate chat model with its own credential can still chat.
  const separateChatUsable = Boolean(connections?.data.chat
    && connections.data.connections.find((c) => c.id === connections.data.chat?.connectionId)?.credential.configured);
  const connectionReady = (readiness?.steps.find((step) => step.id === "connection")?.complete ?? false) || separateChatUsable;
  const canSend = readiness === null || connectionReady;
  const providerLabel =
    chatSelection !== null
      ? connectionLabelFor(connections, chatSelection.connectionId)
      : "";
  const modelName = chatSelection?.modelId ?? "";
  const modelPill: ModelPillState = connectionReady
    ? { kind: "ok", provider: providerLabel || "Model", model: modelName || "ready" }
    : { kind: "needs", label: "No model connected" };

  const workspaceOpen = !route404 && view !== "chat" && view !== "run";
  const profileTab = view === "profile" ? new URLSearchParams(window.location.search).get("tab") ?? "identity" : "";

  /** A section link leaves any open application or account detail behind. */
  const workspaceNavigate = (href: string) => {
    setSelectedSlug(null);
    selectedSlugRef.current = null;
    setSelectedAccountHost(null);
    selectedAccountHostRef.current = null;
    navigateHref(href);
  };

  const closeWorkspace = () => {
    setSelectedSlug(null);
    selectedSlugRef.current = null;
    setSelectedAccountHost(null);
    selectedAccountHostRef.current = null;
    navigate("chat");
    requestAnimationFrame(() => workspaceButtonRef.current?.focus());
  };

  const openWorkspace = () => {
    if (view !== "chat") return;
    let section: WorkspaceSectionId = connectionReady ? "profile" : "setup";
    try {
      const stored = window.localStorage.getItem(WORKSPACE_SECTION_STORAGE);
      if (stored && ["profile", "searchPreferences", "instructions", "resumes", "discover", "queue", "applications", "accounts", "settings", "setup"].includes(stored)) {
        section = stored as WorkspaceSectionId;
      }
    } catch {
      /* ignore */
    }
    navigateHref(hrefForStoredSection(section));
  };

  const onSend = async (message: string): Promise<boolean> => {
    if (runActive) return runReply(message);
    const continueFrom = continueFromRef.current;
    const started = await runStart({
      kind: "chat",
      message,
      ...(continueFrom ? { continueFrom } : {}),
    });
    if (started && continueFrom) continueFromRef.current = null;
    return started !== null;
  };

  const onConnectionsChange = useCallback(
    async (next: ConnectionList) => {
      const plan = planChatModelSwitch(connections, next, run, runEntries, runHistory);
      setConnections(next);
      // A send can win the race and make the chat busy again; then the old run keeps going on its model.
      if (plan.finishFirst && !(await runFinish())) return;
      if (plan.continueFrom) {
        continueFromRef.current = plan.continueFrom;
        if (plan.note) {
          const noteText = plan.note;
          setChatNotes((notes) => [
            ...notes,
            { kind: "system", key: `chat-switch-${plan.continueFrom}-${notes.length}`, text: noteText },
          ]);
        }
      }
    },
    [connections, run, runEntries, runHistory, runFinish],
  );

  const chatIntro = (
    <FirstLaunch
      connectionReady={connectionReady}
      onReadinessChange={setReadiness}
      onConnectionsChange={setConnections}
    />
  );

  const workspacePanel = !workspaceOpen ? null : !selectedSlug && view === "discover" ? (
          <DiscoverView
            tab={parseRoute(window.location.href).tab}
            runActive={runActive}
            onPromoted={handleQueueMutated}
            onNavigate={navigateHref}
            discoverReady={readiness?.discoverReady ?? false}
            scoreReady={readiness?.scoreReady ?? false}
            discoverBlocker={readiness?.steps.find((step) => step.id === "targets")?.blockers[0] ?? null}
            scoreBlocker={readiness?.scoreBlockers[0] ?? null}
          />
        ) : !selectedSlug && view === "setup" ? (
          <><Topbar title="Setup" sub="Four steps from connection to application" /><SetupView navigate={navigateHref} onReadinessChange={setReadiness} /></>
        ) : !selectedSlug && view === "queue" ? (
          <>
            <Topbar title="Shortlist" sub={`${queue.length} roles to review`} />
            {queueLoaded ? (
              <QueueList
                items={queue}
                confirmSlug={confirmSlug}
                removing={removing}
                removeError={removeError}
                onConfirmChange={setConfirmSlug}
                onRemove={handleRemove}
                onApply={(slug) => beginRun({ kind: "apply", slug })}
                applyDisabled={runActive || !readiness?.applyReady}
                applyDisabledReason={
                  runActive
                    ? "A run is already active"
                    : !readiness?.applyReady
                      ? "Complete Setup to enable automatic submission"
                      : undefined
                }
                activeApplySlug={
                  run?.kind === "apply" || run?.kind === "apply-next" ? run.slug : null
                }
              />
            ) : (
              <Pending error={error} />
            )}
            <QueueAdd onMutated={handleQueueMutated} />
          </>
        ) : !selectedSlug && view === "accounts" ? (
          selectedAccountHost ? (
            <>
              <Topbar title={selectedAccountHost} sub="Account" />
              {accountDetailError ? (
                // The "the account vanished" case, and it is not hypothetical:
                // credentials.json can be deleted, or the open account removed
                // by the extension or a second tab, while the detail is on
                // screen. The next refetch 404s (or 500s if the file went
                // missing), the chain sets accountDetailError, and this renders
                // instead of AccountDetail — exactly as detailError takes
                // precedence below. The back control has to live HERE because
                // AccountDetail is not mounted in this branch, so without it a
                // failed fetch strands the user with no route back short of
                // reloading the page. Clicking it clears the selection, and the
                // selection effect clears the error with it.
                <>
                  <div>
                    <button type="button" className="btn" onClick={() => setSelectedAccountHost(null)}>
                      ← All accounts
                    </button>
                  </div>
                  <div className="state crit">
                    <span className="glyph" aria-hidden="true">
                      !
                    </span>
                    <p>{`Account error: ${accountDetailError}`}</p>
                  </div>
                </>
              ) : // Identity check, not just truthiness, for the same reason the
              // application detail below uses one: setAccountDetail(null)
              // happens in an effect, which runs AFTER the render that
              // committed the new host.
              accountDetail && accountDetail.account.host === selectedAccountHost ? (
                <AccountDetail
                  detail={accountDetail}
                  onBack={() => leaveDetailAnd("accounts")}
                  onSelectApplication={openApplication}
                  onSaved={handleAccountSaved}
                  onDeleted={handleAccountDeleted}
                />
              ) : (
                <Pending error={error} />
              )}
            </>
          ) : (
            <>
              <Topbar title="Accounts" sub={`${accounts.length} accounts`} />
              {accountsLoaded ? (
                <AccountsList
                  accounts={accounts}
                  filter={accountFilter}
                  onFilterChange={setAccountFilter}
                  onSelect={openAccount}
                />
              ) : (
                <Pending error={error} />
              )}
              <AccountAdd onMutated={handleAccountMutated} />
            </>
          )
        ) : !selectedSlug && view === "settings" ? (
          <>
            <Topbar title="Settings" sub="Connections and workspace controls" />
            <Settings />
          </>
        ) : !selectedSlug && view === "instructions" ? (
          <>
            <Topbar title="Agent instructions" sub="Plain-English rules the agents follow every time. You can also just tell the chat." />
            <InstructionsView />
          </>
        ) : !selectedSlug && view === "profile" ? (
          <>
            <Topbar title="Profile" sub="What the agent reads before it fills a form" />
            {profileLoaded && profile ? (
              // `profileError ?? error` for the same reason detailError takes
              // precedence over the global banner in its own branch: a failure
              // that belongs to this section is more specific than "the newest
              // whole refresh did not succeed", and the section-local one is the
              // only thing this view can act on.
              <ProfileView
                profile={profile}
                resumes={resumes}
                addresses={addresses}
                error={profileError ?? error}
                onMutated={handleProfileMutated}
                tabRequest={tabRequest}
                onTabChange={() => setTabRequest(n => n + 1)}
              />
            ) : (
              <Pending error={profileError ?? error} />
            )}
          </>
        ) : selectedSlug ? (
          detailError ? (
            // The back control has to live here, not only inside
            // ApplicationDetail: that component is not mounted in this branch, so
            // without its own way out a failed detail fetch (a 404 for a row the
            // applier just renamed, say) strands the user with no route back to
            // the list short of reloading the page.
            <>
              <div>
                <button type="button" className="btn" onClick={() => setSelectedSlug(null)}>
                  ← All applications
                </button>
              </div>
              <div className="state crit">
                <span className="glyph" aria-hidden="true">
                  !
                </span>
                <p>{`Detail error: ${detailError}`}</p>
              </div>
            </>
          ) : // Identity check, not just truthiness: setDetail(null) happens in an
          // effect, which runs AFTER the render that committed the new
          // selectedSlug, so a bare `detail ?` paints the previous row's payload
          // under the new row's heading for one frame.
          detail && detail.application.slug === selectedSlug ? (
            <ApplicationDetail detail={detail} onBack={() => leaveDetailAnd("applications")} onSaved={handleSaved} />
          ) : (
            <div className="state">
              <p>Loading…</p>
            </div>
          )
        ) : (
          <>
            {view !== "overview" ? (
              <Topbar title="Applications" sub={`${applications.length} applications`} />
            ) : null}
            {view === "overview" ? (
              overviewLoaded && overview ? (
                <TodayView
                  overview={overview}
                  queue={queue}
                  applications={applications}
                  readiness={readiness}
                  run={run}
                  runActive={runActive}
                  onRun={() => {}}
                  onApplyNext={() => beginRun({ kind: "apply-next" })}
                  onGather={() => beginRun({ kind: "gather" })}
                  onNavigate={navigateHref}
                  onOpenApplication={(slug, filter) => {
                    if (filter?.status) setStatusFilter(filter.status);
                    if (filter?.apply) setApplyStateFilter(filter.apply);
                    if (slug) openApplication(slug);
                    else navigate("applications", { status: filter?.status ?? statusFilter, applyState: filter?.apply ?? applyStateFilter });
                  }}
                />
              ) : (
                <Pending error={error} />
              )
            ) : applicationsLoaded ? (
              <ApplicationList
                applications={applications}
                search={search}
                status={statusFilter}
                applyState={applyStateFilter}
                from={fromDate}
                to={toDate}
                onSearchChange={setSearch}
                onStatusChange={setStatusFilter}
                onApplyStateChange={setApplyStateFilter}
                onFromChange={setFromDate}
                onToChange={setToDate}
                onSelect={openApplication}
              />
            ) : (
              <Pending error={error} />
            )}
          </>
        );

  const themeResolved = resolvedTheme(themeChoice);
  const onThemeToggle = () => {
    const next: ThemeChoice = themeResolved === "dark" ? "light" : "dark";
    applyTheme(next);
    setThemeChoice(next);
  };

  const composerPlaceholder = connectionReady
    ? "Message Rolebound…"
    : "Connect an AI account to begin";

  return (
    <ChatShell
      modelPill={modelPill}
      connection={connection}
      workspaceOpen={workspaceOpen}
      workspaceButtonRef={workspaceButtonRef}
      onHome={() => navigate("chat")}
      onWorkspace={openWorkspace}
      onThemeToggle={onThemeToggle}
      themeResolved={themeResolved}
      error={error}
      rail={<SearchRail overview={overview} readiness={readiness} onNavigate={workspaceNavigate} />}
    >
      {corruptFiles.length > 0 ? (
        <div role="alert" className="rb-repair-banner">
          Repair needed: {corruptFiles.join(", ")} are corrupt. Run <code>npm run restore -- --backup &lt;id&gt;</code> or replace from <code>templates/</code>.
        </div>
      ) : null}
      {route404 ? (
        <NotFound onHome={() => navigate("chat")} />
      ) : (
        <>
          <ChatPane
            run={run}
            entries={[...runHistory, ...runEntries]}
            busy={runBusy}
            error={runError}
            connections={connections}
            onConnectionsChange={onConnectionsChange}
            chatNotes={chatNotes}
            onSend={onSend}
            onInterrupt={async () => {
              await runAbort();
            }}
            onRespondUi={async (body) => {
              await runRespondUi(body);
            }}
            onFinish={async () => {
              await runFinish();
            }}
            intro={chatIntro}
            chips={connectionReady ? ["Import my resume", "Add a job link", "Find new roles", "Apply to the next one"] : []}
            placeholder={composerPlaceholder}
            canSend={canSend}
            overview={overview}
            readiness={readiness}
            onWorkspaceNavigate={workspaceNavigate}
          />
          <WorkspaceDrawer
            open={workspaceOpen}
            view={view}
            tab={profileTab}
            counts={{ queue: queue.length, applications: applications.length }}
            onNavigate={workspaceNavigate}
            onClose={closeWorkspace}
          >
            {(view === "discover" || view === "queue") && <nav className="rb-job-nav" aria-label="Job search"><a href="/discover" onClick={e => { e.preventDefault(); navigateHref("/discover"); }}>Found jobs</a><a href="/queue" onClick={e => { e.preventDefault(); navigateHref("/queue"); }}>Shortlist</a><a href="/discover?tab=companies" onClick={e => { e.preventDefault(); navigateHref("/discover?tab=companies"); }}>Companies to watch</a></nav>}
            {workspacePanel}
          </WorkspaceDrawer>
        </>
      )}
    </ChatShell>
  );
}

/**
 * Five views, one rail. Still not a router: history-view D3 deferred
 * deep-linkable URLs, and a fifth view is not the place to introduce that
 * dependency.
 *
 * Every entry is a real button rendered from VIEWS, including Profile — which
 * used to be a hand-written `.nav-row soon` after the Run button, carrying the
 * word "soon" instead of a count. That row is gone, and with it the one place
 * the rail said something the product no longer did.
 */
function NotFound({ onHome }: { onHome: () => void }) {
  return (
    <section className="not-found" aria-labelledby="not-found-title">
      <Topbar title="Page not found" sub="404" />
      <div className="state crit"><span className="glyph" aria-hidden="true">?</span><p id="not-found-title">That workspace route does not exist.</p><button type="button" className="btn primary" onClick={onHome}>Return to Today</button></div>
    </section>
  );
}
