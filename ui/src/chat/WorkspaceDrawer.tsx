import { WorkspaceOverlayContext } from "./WorkspaceOverlayContext";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RouteView } from "../router";

export type WorkspaceSectionId =
  | "profile"
  | "searchPreferences"
  | "instructions"
  | "resumes"
  | "discover"
  | "queue"
  | "applications"
  | "accounts"
  | "settings"
  | "setup";

const SECTIONS: { id: WorkspaceSectionId; label: string; href: string; countKey?: "queue" | "applications" }[] = [
  { id: "profile", label: "Profile", href: "/profile?tab=identity" },
  { id: "discover", label: "Job search", href: "/discover" },
  { id: "instructions", label: "Agent instructions", href: "/instructions" },
  { id: "applications", label: "Applications", href: "/applications", countKey: "applications" },
  { id: "settings", label: "Settings", href: "/settings" },
  { id: "setup", label: "Setup", href: "/setup" },
];
const PROFILE_LINKS = [
  ["Identity", "identity"], ["Resumes", "resumes"], ["Addresses", "addresses"], ["Q&A bank", "qaBank"],
  ["Job preferences", "searchPreferences"], ["Work history", "workHistory"], ["Candidate summary", "candidateSummary"],
];
const MOBILE_GROUPS = [
  { label: "Profile", links: PROFILE_LINKS.map(([label, tab]) => ({ label, href: `/profile?tab=${tab}` })) },
  { label: "Job search", links: [{label:"Found jobs",href:"/discover"},{label:"Shortlist",href:"/queue"},{label:"Companies to watch",href:"/discover?tab=companies"}] },
  { label: "Workspace", links: [{label:"Applications",href:"/applications"},{label:"Agent instructions",href:"/instructions"},{label:"AI settings",href:"/settings"},{label:"Site logins",href:"/settings/accounts"},{label:"Setup checklist",href:"/setup"}] },
];

export function activeWorkspaceSection(view: RouteView, tab: string): WorkspaceSectionId | null {
  if (view === "profile") {
    if (tab === "searchPreferences") return "searchPreferences";
    if (tab === "resumes") return "resumes";
    return "profile";
  }
  if (view === "instructions") return "instructions";
  if (view === "discover") return "discover";
  if (view === "queue") return "queue";
  if (view === "overview") return null;
  if (view === "applications") return "applications";
  if (view === "accounts") return "accounts";
  if (view === "settings") return "settings";
  if (view === "setup") return "setup";
  return null;
}

export default function WorkspaceDrawer({ open, view, tab, counts, onNavigate, onClose, children }: {
  open: boolean; view: RouteView; tab: string; counts: { queue: number; applications: number };
  onNavigate: (href: string) => void; onClose: () => void; children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const chooserRef = useRef<HTMLDetailsElement>(null);
  const [popupHost, setPopupHost] = useState<HTMLDivElement | null>(null);
  const active = activeWorkspaceSection(view, tab);
  const canonical = view === "profile" ? "profile" : view === "queue" ? "discover" : view === "accounts" ? "settings" : active;
  const current = view === "profile" ? PROFILE_LINKS.find(([, id]) => id === tab)?.[0] ?? "Profile" : view === "queue" ? "Shortlist" : view === "accounts" ? "Site logins" : SECTIONS.find(s => s.id === canonical)?.label ?? "Workspace";
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    if (typeof dialog.showModal === "function") { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLButtonElement>('[aria-label="Close workspace"]')?.focus();
    return () => { if (dialog.open && typeof dialog.close === "function") dialog.close(); previous?.focus(); };
  }, [open]);
  if (!open) return null;
  function go(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); if (chooserRef.current) chooserRef.current.open = false; onNavigate(href);
  }
  return <dialog ref={dialogRef} className="rb-ws-dialog" aria-modal="true" aria-labelledby="ws-title"
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(el => el.getClientRects().length > 0 && !el.closest("[hidden]"));
      const first = controls[0], last = controls[controls.length-1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <WorkspaceOverlayContext.Provider value={popupHost}>
      <div className="rb-ws-panel">
        <div className="rb-ws-head"><div><h1 id="ws-title">Workspace</h1><p>Your details, job search, and AI settings.</p></div>
          <button type="button" className="rb-chat-btn rb-chat-btn--icon" aria-label="Close workspace" onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        <details className="rb-mobile-sections" ref={chooserRef} onKeyDown={event => { if (event.key === "Escape" && chooserRef.current?.open) { event.preventDefault(); event.stopPropagation(); chooserRef.current.open = false; chooserRef.current.querySelector("summary")?.focus(); } }}>
          <summary><span>Section</span><strong>{current}</strong><span aria-hidden="true">⌄</span></summary>
          <nav aria-label="Choose workspace section">{MOBILE_GROUPS.map(group => <div key={group.label}><p>{group.label}</p>{group.links.map(link => <a key={link.href} href={link.href} onClick={e => go(e, link.href)}>{link.label}</a>)}</div>)}</nav>
        </details>
        <div className="rb-ws-layout"><nav className="rb-ws-nav" aria-label="Workspace sections"><ul>
          {SECTIONS.map(section => <li key={section.id}><a href={section.href} aria-current={canonical === section.id ? "page" : undefined} onClick={e => go(e, section.href)}><span>{section.label}</span>{section.countKey && <span className="rb-ws-nav-count">{counts[section.countKey]}</span>}</a></li>)}
        </ul><p className="rb-ws-nav-note">Edits stay here until you save them.</p></nav>
          <div className="rb-ws-content">{children}</div>
        </div>
      </div>
      <div className="rb-ws-popup-host" ref={setPopupHost} />
    </WorkspaceOverlayContext.Provider>
  </dialog>;
}

export const WORKSPACE_SECTION_STORAGE = "rolebound-workspace-section";

export function hrefForStoredSection(id: WorkspaceSectionId): string {
  if (id === "resumes") return "/profile?tab=resumes";
  if (id === "searchPreferences") return "/profile?tab=searchPreferences";
  if (id === "queue") return "/queue";
  if (id === "accounts") return "/settings/accounts";
  const match = SECTIONS.find((s) => s.id === id);
  return match?.href ?? SECTIONS[0].href;
}
