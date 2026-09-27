import { useDeferredValue, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileUp,
  Inbox,
  LoaderCircle,
  LogOut,
  Mail,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
const RATE_LIMIT_WINDOW_MS = Number(import.meta.env.VITE_RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000;
const RATE_LIMIT_LABEL = RATE_LIMIT_WINDOW_MS === 60 * 60 * 1000
  ? "Emails per hour"
  : `Emails per ${Math.round(RATE_LIMIT_WINDOW_MS / 60_000)} minutes`;

type User = { id: string; email: string; name: string; avatar: string | null };
type Sender = { id: string; email: string; name: string; maxPerHour: number };
type Email = {
  id: string;
  to: string;
  subject: string;
  status: "SCHEDULED" | "SENDING" | "SENT" | "FAILED";
  scheduledAt: string;
  sentAt: string | null;
  sender: { email: string; name: string };
  error?: string | null;
};
type SlackState = { connected: boolean; teamName: string | null };
type Toast = { kind: "success" | "error"; message: string };

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function localDateTimeValue(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"scheduled" | "sent">("scheduled");
  const [emails, setEmails] = useState<Email[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [slack, setSlack] = useState<SlackState>({ connected: false, teamName: null });
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const deferredSearch = useDeferredValue(searchText.trim());

  const refreshEmails = async (folder: "scheduled" | "sent" = activeTab) => {
    const data = await api<{ emails: Email[]; total: number }>(`/api/emails?folder=${folder}`);
    setEmails(data.emails);
  };

  useEffect(() => {
    let alive = true;
    api<User>("/api/me")
      .then(async (currentUser) => {
        if (!alive) return;
        setUser(currentUser);
        const [senderList, slackState] = await Promise.all([
          api<Sender[]>("/api/senders"),
          api<SlackState>("/api/slack"),
        ]);
        if (!alive) return;
        setSenders(senderList);
        setSlack(slackState);
        await refreshEmails("scheduled");
      })
      .catch(() => {
        if (alive) setUser(null);
      })
      .finally(() => {
        if (alive) setAuthLoading(false);
      });

    const params = new URLSearchParams(window.location.search);
    if (params.has("slack")) {
      setToast(params.get("slack") === "connected"
        ? { kind: "success", message: "Slack workspace connected." }
        : { kind: "error", message: "Slack connection could not be completed." });
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("login") === "failed") {
      setToast({ kind: "error", message: "Google sign-in could not be completed." });
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!user) return;
    const interval = window.setInterval(() => {
      void refreshEmails().catch(() => undefined);
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [user, activeTab]);

  useEffect(() => {
    if (!user || !deferredSearch) {
      if (!deferredSearch && user) void refreshEmails().catch(() => undefined);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<Array<Email & { id: string }>>(`/api/emails/search?q=${encodeURIComponent(deferredSearch)}`)
        .then((results) => {
          if (!cancelled) setEmails(results as Email[]);
        })
        .catch((error: Error) => {
          if (!cancelled) setToast({ kind: "error", message: error.message });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deferredSearch, user]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  if (authLoading) {
    return <div className="screen-loading"><LoaderCircle className="spin" size={25} /><span>Opening your workspace</span></div>;
  }

  if (!user) {
    return (
      <main className="login-page">
        <div className="login-topline"><Brand /><span className="login-top-note">OUTBOX LABS · EMAIL OPERATIONS</span></div>
        <section className="login-content">
          <div className="login-copy">
            <div className="eyebrow"><span className="eyebrow-mark" /> DELIVERY CONTROL ROOM</div>
            <h1>Make every<br />send count.</h1>
            <p>Schedule outbound email with visibility into every send, every queue, and every sender.</p>
            <div className="login-signals">
              <div><ShieldCheck size={18} /><span>Persistent scheduling</span></div>
              <div><Clock3 size={18} /><span>Rate-aware delivery</span></div>
              <div><Search size={18} /><span>Searchable activity</span></div>
            </div>
          </div>
          <div className="login-panel">
            <div className="login-panel-icon"><Inbox size={23} /></div>
            <span className="panel-kicker">WORKSPACE ACCESS</span>
            <h2>Welcome back</h2>
            <p>Sign in with your Google account to open your email workspace.</p>
            <a className="google-button" href={`${API_URL}/auth/google`}>
              <GoogleMark />
              <span>Continue with Google</span>
              <ArrowUpRight size={16} />
            </a>
            <div className="login-footnote"><ShieldCheck size={14} /> Secure Google OAuth sign-in</div>
          </div>
        </section>
        <div className="login-footer"><span>REACHINBOX SCHEDULER</span><span>BUILDING BETTER OUTBOUND, ONE SEND AT A TIME</span></div>
        {toast && <ToastView toast={toast} onClose={() => setToast(null)} />}
      </main>
    );
  }

  const isSent = activeTab === "sent";
  const sentCount = emails.filter((email) => email.status === "SENT").length;
  const failedCount = emails.filter((email) => email.status === "FAILED").length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          <button className="nav-item selected" type="button"><Mail size={18} /><span>Email</span><span className="nav-dot" /></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="health-label"><span className="health-pulse" /> SYSTEM STATUS</div>
          <div className="health-state"><CheckCircle2 size={15} /><span>All systems operational</span></div>
          <a className="queue-link" href={`${API_URL}/admin/queues`} target="_blank" rel="noreferrer">
            <Settings2 size={16} /><span>Queue dashboard</span><ArrowUpRight size={14} />
          </a>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>Email</strong></div>
          <div className="topbar-actions">
            <button className={`slack-control ${slack.connected ? "is-connected" : ""}`} type="button" onClick={() => {
              if (slack.connected) {
                void api<void>("/api/slack", { method: "DELETE" }).then(() => {
                  setSlack({ connected: false, teamName: null });
                  setToast({ kind: "success", message: "Slack workspace disconnected." });
                }).catch((error: Error) => setToast({ kind: "error", message: error.message }));
              } else {
                window.location.assign(`${API_URL}/auth/slack`);
              }
            }}>
              <span className="slack-glyph">#</span>
              <span>{slack.connected ? slack.teamName || "Slack connected" : "Connect Slack"}</span>
              <ChevronDown size={13} />
            </button>
            <div className="user-menu">
              {user.avatar ? <img className="avatar" src={user.avatar} alt="" /> : <span className="avatar avatar-fallback">{initials(user.name)}</span>}
              <span className="user-identity"><strong>{user.name}</strong><small>{user.email}</small></span>
              <a className="logout-button" href={`${API_URL}/auth/logout`} aria-label="Log out" title="Log out"><LogOut size={16} /></a>
            </div>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow page-eyebrow"><Sparkles size={13} /> OUTBOUND WORKSPACE</div>
              <h1>Email activity</h1>
              <p>Schedule and track delivery across your sender accounts.</p>
            </div>
            <button className="primary-button compose-button" type="button" onClick={() => setDialogOpen(true)}>
              <Plus size={17} strokeWidth={2.3} /> Compose new email
            </button>
          </div>

          <div className="summary-strip">
            <div className="summary-stat"><span className="summary-icon scheduled-icon"><CalendarClock size={17} /></span><div><strong>{isSent ? emails.length : emails.length}</strong><span>{isSent ? "Activity in view" : "Scheduled in view"}</span></div></div>
            <div className="summary-divider" />
            <div className="summary-stat"><span className="summary-icon sent-icon"><Check size={17} /></span><div><strong>{isSent ? sentCount : senders.length}</strong><span>{isSent ? "Delivered" : "Active senders"}</span></div></div>
            <div className="summary-divider" />
            <div className="summary-stat"><span className="summary-icon failed-icon"><AlertCircle size={17} /></span><div><strong>{isSent ? failedCount : (slack.connected ? "On" : "Off")}</strong><span>{isSent ? "Failed" : "Slack alerts"}</span></div></div>
            <div className="summary-note"><span className="health-pulse" /> Updated automatically</div>
          </div>

          <section className="activity-panel">
            <div className="activity-toolbar">
              <div className="tab-list" role="tablist" aria-label="Email activity">
                <button className={`activity-tab ${!isSent ? "active" : ""}`} type="button" role="tab" aria-selected={!isSent} onClick={() => { setActiveTab("scheduled"); void refreshEmails("scheduled").catch((error: Error) => setToast({ kind: "error", message: error.message })); }}>
                  <CalendarClock size={16} /> Scheduled <span className="tab-count">{!isSent ? emails.length : ""}</span>
                </button>
                <button className={`activity-tab ${isSent ? "active" : ""}`} type="button" role="tab" aria-selected={isSent} onClick={() => { setActiveTab("sent"); void refreshEmails("sent").catch((error: Error) => setToast({ kind: "error", message: error.message })); }}>
                  <Send size={15} /> Sent <span className="tab-count">{isSent ? emails.length : ""}</span>
                </button>
              </div>
              <label className="search-field">
                <Search size={16} />
                <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search email activity" aria-label="Search email activity" />
                <kbd>⌘ K</kbd>
              </label>
            </div>

            <div className="table-scroll">
              <table className="email-table">
                <thead><tr>
                  <th>RECIPIENT</th><th>SUBJECT</th><th>{isSent ? "SENT AT" : "SCHEDULED FOR"}</th><th>SENDER</th><th>STATUS</th>
                </tr></thead>
                <tbody>
                  {loading ? <tr><td className="table-state" colSpan={5}><LoaderCircle className="spin" size={18} /> Loading email activity</td></tr>
                    : emails.length === 0 ? <tr><td className="table-state" colSpan={5}>
                      <div className="empty-state"><span className="empty-icon"><Inbox size={21} /></span><strong>{deferredSearch ? "No matching emails" : isSent ? "Nothing sent yet" : "Your schedule is clear"}</strong><span>{deferredSearch ? "Try another email address or subject." : isSent ? "Completed and failed sends will appear here." : "Compose an email to add your first scheduled send."}</span>
                        {!isSent && !deferredSearch && <button className="text-action" type="button" onClick={() => setDialogOpen(true)}><Plus size={15} /> Compose an email</button>}
                      </div>
                    </td></tr>
                    : emails.map((email) => <EmailRow key={email.id} email={email} sent={isSent} />)}
                </tbody>
              </table>
            </div>
            <div className="table-foot"><span>Showing {emails.length} {isSent ? "sent emails" : "scheduled emails"}</span><button className="refresh-button" type="button" onClick={() => {
              setLoading(true);
              refreshEmails().catch((error: Error) => setToast({ kind: "error", message: error.message })).finally(() => setLoading(false));
            }}><ArrowDownToLine size={14} /> Refresh</button></div>
          </section>

          <div className="workspace-footnote"><ShieldCheck size={14} /><span>Queue state is persisted across restarts</span><span className="footnote-separator">·</span><span>{senders.length} configured sender{senders.length === 1 ? "" : "s"}</span></div>
        </div>
      </main>

      {dialogOpen && <ComposeDialog
        senders={senders}
        onClose={() => setDialogOpen(false)}
        onScheduled={(count) => {
          setDialogOpen(false);
          setActiveTab("scheduled");
          setSearchText("");
          setToast({ kind: "success", message: `${count} email${count === 1 ? "" : "s"} added to the schedule.` });
          void refreshEmails("scheduled").catch((error: Error) => setToast({ kind: "error", message: error.message }));
        }}
        onError={(message) => setToast({ kind: "error", message })}
      />}
      {toast && <ToastView toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function Brand() {
  return <a className="brand" href="/" aria-label="ReachInbox Scheduler home"><span className="brand-mark"><span /><span /><span /></span><span className="brand-name">reachinbox<span className="brand-period">.</span></span></a>;
}

function GoogleMark() {
  return <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.88c-.58 2.96-2.26 5.48-4.71 7.18l7.19 5.59c4.19-3.87 6.62-9.57 6.62-17.24Z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.75 24c0-1.59.27-3.13.75-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.88.93 7.55 2.57 10.78l7.96-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.79l-7.19-5.59c-1.99 1.33-4.54 2.12-8.71 2.12-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>;
}

function EmailRow({ email, sent }: { email: Email; sent: boolean }) {
  const sentStatus = email.status === "SENT";
  return <tr>
    <td><div className="recipient-cell"><span className="recipient-avatar">{email.to.slice(0, 1).toUpperCase()}</span><span>{email.to}</span></div></td>
    <td><span className="subject-cell" title={email.subject}>{email.subject}</span></td>
    <td><span className="date-cell">{formatDate(sent ? email.sentAt : email.scheduledAt)}</span></td>
    <td><span className="sender-cell">{email.sender?.email || "—"}</span></td>
    <td><span className={`status-pill ${sent ? sentStatus ? "status-sent" : "status-failed" : email.status === "SENDING" ? "status-sending" : "status-scheduled"}`}>
      <span className="status-dot" />{sent ? sentStatus ? "Sent" : "Failed" : email.status === "SENDING" ? "Sending" : "Scheduled"}
    </span></td>
  </tr>;
}

function ComposeDialog({
  senders,
  onClose,
  onScheduled,
  onError,
}: {
  senders: Sender[];
  onClose: () => void;
  onScheduled: (count: number) => void;
  onError: (message: string) => void;
}) {
  const [senderId, setSenderId] = useState(senders[0]?.id || "");
  const [hourlyLimit, setHourlyLimit] = useState(senders[0]?.maxPerHour || 200);
  const [scheduledAt, setScheduledAt] = useState(() => localDateTimeValue(new Date(Date.now() + 5 * 60_000)));
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fileError, setFileError] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const acceptFile = async (file?: File) => {
    if (!file) return;
    setFileError("");
    setFileName(file.name);
    try {
      const text = await file.text();
      const found = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      const unique = [...new Set(found.map((address) => address.toLowerCase()))];
      if (!unique.length) {
        setRecipients([]);
        setFileError("No email addresses were found in this file.");
        return;
      }
      setRecipients(unique);
    } catch {
      setFileError("This file could not be read. Choose a CSV or text file.");
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!recipients.length) {
      setFileError("Upload a CSV or text file with at least one email address.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api<{ scheduled: number }>("/api/emails", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          recipients,
          senderId,
          subject,
          body,
          scheduledAt: new Date(scheduledAt).toISOString(),
          delayMs: Math.round(delaySeconds * 1000),
          hourlyLimit,
        }),
      });
      onScheduled(result.scheduled);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Emails could not be scheduled.");
      setSubmitting(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-title">
      <div className="modal-header"><div><span className="panel-kicker">NEW OUTBOUND</span><h2 id="compose-title">Compose email</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close compose"><X size={18} /></button></div>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field-label" htmlFor="sender">Sending account</label>
        <div className="select-wrap"><select id="sender" value={senderId} onChange={(event) => {
          setSenderId(event.target.value);
          setHourlyLimit(senders.find((sender) => sender.id === event.target.value)?.maxPerHour || 200);
        }} required disabled={!senders.length}>
          {senders.length ? senders.map((sender) => <option key={sender.id} value={sender.id}>{sender.name} · {sender.email}</option>) : <option value="">No configured senders</option>}
        </select><ChevronDown size={15} /></div>

        <div className="form-grid form-grid-two">
          <div><label className="field-label" htmlFor="start-time">Start time</label><input id="start-time" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required /></div>
          <div><label className="field-label" htmlFor="hourly-limit">{RATE_LIMIT_LABEL}</label><input id="hourly-limit" type="number" min={1} max={10000} value={hourlyLimit} onChange={(event) => setHourlyLimit(Number(event.target.value))} required /></div>
        </div>
        <div className="form-grid form-grid-two form-grid-last">
          <div><label className="field-label" htmlFor="send-delay">Delay between emails</label><div className="input-suffix"><input id="send-delay" type="number" min={0} step={0.5} value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} required /><span>seconds</span></div></div>
          <div><span className="field-label">Lead list</span><label className="file-drop" htmlFor="lead-file"><FileUp size={17} /><span>{fileName || "Upload CSV or text file"}</span><input id="lead-file" type="file" accept=".csv,.txt,text/plain,text/csv" onChange={(event) => void acceptFile(event.target.files?.[0])} /></label></div>
        </div>
        {fileError && <div className="field-error"><AlertCircle size={14} /> {fileError}</div>}
        <div className={`recipient-count ${recipients.length ? "has-recipients" : ""}`}><span>{recipients.length ? <CheckCircle2 size={15} /> : <Inbox size={15} />}</span><strong>{recipients.length}</strong> email address{recipients.length === 1 ? "" : "es"} detected {fileName && <small>in {fileName}</small>}</div>

        <label className="field-label" htmlFor="subject">Subject</label>
        <input id="subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="A clear, personal subject line" maxLength={998} required />
        <label className="field-label" htmlFor="body">Email body</label>
        <textarea id="body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write your message…" rows={5} maxLength={100000} required />

        <div className="compose-note"><Clock3 size={14} /><span>Queued emails persist if the service restarts. Your configured minimum send gap still applies.</span></div>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={submitting || !senders.length}>{submitting ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />}{submitting ? "Scheduling…" : `Schedule ${recipients.length || "emails"}`}</button></div>
      </form>
    </section>
  </div>;
}

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  return <div className={`toast toast-${toast.kind}`} role="status"><span className="toast-icon">{toast.kind === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}</span><span>{toast.message}</span><button type="button" onClick={onClose} aria-label="Dismiss notification"><X size={15} /></button></div>;
}

export default App;