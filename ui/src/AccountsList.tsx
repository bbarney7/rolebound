import type { ATSAccount } from "../shared/types";
import { filterAccounts, loginStatusLabel, loginStatusTone } from "./accounts";
import Stamp from "./Stamp";
import "./surfaces.css";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

export default function AccountsList({
  accounts,
  filter,
  onFilterChange,
  onSelect,
}: {
  accounts: ATSAccount[];
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (host: string) => void;
}) {
  const visible = filterAccounts(accounts, filter);

  return (
    <div className="rb-surface">
      <div className="rb-list-panel card">
        <div className="rb-list-panel-head head">
          <h2 className="rb-h-major">ATS accounts</h2>
          <p className="rb-section-note note count">
            {visible.length} of {accounts.length} accounts
          </p>
          <a href="#add-account" className="btn rb-toolbar-link">
            Add account
          </a>
        </div>

        <div className="rb-filter-bar toolbar">
          <div className="rb-field field">
            <label htmlFor="account-filter">Host, company or email</label>
            <input
              id="account-filter"
              className="control search"
              type="search"
              placeholder="Filter by host, company or email"
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
            />
          </div>
        </div>

        {accounts.length === 0 ? (
          <div className="rb-empty state">
            <span className="glyph" aria-hidden="true">∅</span>
            <p>No accounts yet.</p>
            <p>The agent records one whenever it creates a login on an ATS — or add one below.</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="rb-section-note note count" style={{ padding: "1rem 1.1rem" }}>No account matches that filter.</p>
        ) : (
          <div className="rb-list-panel-body table-scroll rb-record-list">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Host</th>
                  <th>Company</th>
                  <th>ATS</th>
                  <th>Login</th>
                  <th className="num">Last used</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.host} className="row" onClick={() => onSelect(a.host)}>
                    <td>
                      <Stamp tone={loginStatusTone(a.lastLoginStatus)}>
                        {loginStatusLabel(a.lastLoginStatus)}
                      </Stamp>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="row-open mono"
                        aria-label={`Open ${a.host}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(a.host);
                        }}
                      >
                        {a.host}
                      </button>
                    </td>
                    <td>{a.company ?? "—"}</td>
                    <td>{a.ats ?? "—"}</td>
                    <td>
                      <div>{a.username ?? "—"}</div>
                      {a.emailUsed && a.emailUsed !== a.username && (
                        <div className="rb-record-sub slug">{a.emailUsed}</div>
                      )}
                    </td>
                    <td className="num">{formatDate(a.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rb-footnotes">
        <p className="note">
          Ordered by last use, most recent first. Passwords are never included in this list — open an account to reveal one.
        </p>
      </div>
    </div>
  );
}
