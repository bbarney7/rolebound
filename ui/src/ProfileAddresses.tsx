import { useWorkspaceState, useUnsavedChanges } from "./WorkspaceDrafts";
import { useState } from "react";
import type { AddressUpdateBody, AddressesPayload, ProfileEditableSectionId } from "../shared/types";
import { addressStateLabel, addressStateTone } from "./profile";
import Stamp from "./Stamp";
import "./surfaces.css";

/**
 * The city → address rules joined against what the agent has actually
 * saved. Rules and user-provided addresses remain visibly separate, and edits
 * use revision checks so an application cannot be silently overwritten.
 *
 * `terms` IS NEVER RENDERED, and that is not an omission. The live table has
 * three columns rather than four, so `parseCityRules` reads `row[2]` for ZIPs
 * (`.pi/extensions/lib/profile.ts:280`) AND splits the same cell into terms
 * (`:277-278`), yielding `["seattle", "one of {98101", "98103", …]`. `zips` is
 * correct; `terms` is garbage on real data. The wire type omits the field
 * outright so this component could not render it even by accident — the honest
 * way to surface that drift is the unusable-row count below, not the garbage.
 */
export default function ProfileAddresses({
  addresses,
  cityRuleCount,
  cityRuleTableRows,
  hasNormalization,
  hasAddressPolicy,
  onSave,
  markdown, onMarkdownChange, onMarkdownSave, markdownDirty, saving,
}: {
  addresses: AddressesPayload | null;
  /** `profile.cityRules.length` — the rows `parseCityRules` could use. */
  cityRuleCount: number;
  /** Every non-separator row under the heading, header excluded. */
  cityRuleTableRows: number;
  hasNormalization: boolean;
  hasAddressPolicy: boolean;
  onSave: (key: string, address: AddressUpdateBody) => Promise<void>;
  markdown: Partial<Record<ProfileEditableSectionId, string>>; onMarkdownChange: (id: ProfileEditableSectionId, value: string) => void; onMarkdownSave: (id: ProfileEditableSectionId) => void; markdownDirty: (id: ProfileEditableSectionId) => boolean; saving: string | null;
}) {
  const [editing, setEditing] = useWorkspaceState<string | null>("address-editing", null); const [draft, setDraft] = useWorkspaceState<AddressUpdateBody>("address-draft", { revision: null, street: "", city: "", state: "", zip: "" }); const [error, setError] = useState<string | null>(null);
  const [baselineDraft,setBaselineDraft] = useWorkspaceState("address-baseline", "");
  useUnsavedChanges("address-draft", editing !== null && JSON.stringify(draft) !== baselineDraft);
  const [addressBusy,setAddressBusy] = useState(false);
  if (addresses === null) {
    return (
      <div className="state">
        <p>Loading…</p>
      </div>
    );
  }

  const unusable = Math.max(0, cityRuleTableRows - cityRuleCount);
  const orphans = addresses.rows.filter((r) => r.ruleState === "orphan").length;
  const pending = addresses.rows.filter((r) => r.ruleState === "pending").length;

  return (
    <div className="rb-surface rb-workspace">
      {!addresses.stateJsonReadable && (
        <div className="rb-banner crit state crit">
          <span className="glyph" aria-hidden="true">
            !
          </span>
          <p>
            <span className="mono">state.json</span> is on disk but its JSON could not be read.
          </p>
          <p>
            Every rule below is shown as pending because no generated address could be loaded. Fix
            the file by hand — the agent writes it during an application and will fail there too.
          </p>
        </div>
      )}

      <div className="rb-list-panel card">
        <div className="rb-list-panel-head head">
          <h2 className="rb-h-major">City → address rules</h2>
          <p className="note count">
            {addresses.rows.length} {addresses.rows.length === 1 ? "key" : "keys"}
            {orphans > 0 && ` · ${orphans} orphaned`}
            {pending > 0 && ` · ${pending} not configured`}
          </p>
        </div>
        {addresses.rows.length === 0 ? (
          <div className="state">
            <span className="glyph" aria-hidden="true">
              ∅
            </span>
            <p>No city rules and no generated addresses.</p>
            <p>
              Only remote roles resolve a location; anything else stops and asks when a form needs
              a real address.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>City</th>
                  <th>Declared ZIPs</th>
                  <th>Saved address</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {addresses.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="mono">{row.key}</td>
                    <td>
                      {row.displayCity ? (
                        `${row.displayCity}${row.state ? `, ${row.state}` : ""}`
                      ) : (
                        <span className="note">no rule row</span>
                      )}
                    </td>
                    <td><button type="button" className="btn" onClick={() => { setEditing(row.key); const next = { revision: addresses.revision, ...(row.address ?? { street: "", city: row.displayCity, state: row.state, zip: row.zips[0] ?? "" }) }; setDraft(next); setBaselineDraft(JSON.stringify(next)); setError(null); }}>Edit saved address</button></td>
                    <td className="mono">
                      {row.zips.length > 0 ? row.zips.join(", ") : <span className="note">—</span>}
                    </td>
                    <td>
                      {row.address ? (
                        <span className="mono">
                          {row.address.street}, {row.address.city}, {row.address.state}{" "}
                          {row.address.zip}
                        </span>
                      ) : (
                        <span className="note">not configured</span>
                      )}
                    </td>
                    <td>
                      <Stamp tone={addressStateTone(row.ruleState)}>
                        {addressStateLabel(row.ruleState)}
                      </Stamp>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!editing && <button type="button" className="btn" onClick={() => { setEditing("default"); setDraft({ revision: addresses.revision, street: "", city: "", state: "", zip: "" }); }}>Add default address</button>}
        {editing && <form className="rb-profile-form rb-settings-form" onSubmit={async (e) => { e.preventDefault(); if(addressBusy) return; setAddressBusy(true); setError(null); try { await onSave(editing, draft); setEditing(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setAddressBusy(false); } }}>
          <h3 className="rb-h-minor">Truthful saved address for <span className="mono">{editing}</span></h3><p className="note">Enter an address you are authorized to use. City matching rules above choose a saved key; they do not invent an address.</p>
          {(["street", "city", "state", "zip"] as const).map((field) => <div className="field" key={field}><label htmlFor={`address-${field}`}>{field === "zip" ? "ZIP / postal code" : field[0].toUpperCase() + field.slice(1)}</label><input id={`address-${field}`} className="control" required value={draft[field]} onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))} /></div>)}
          <div className="form-actions"><button className="btn primary" type="submit" disabled={addressBusy}>{addressBusy ? "Saving…" : "Save address"}</button><button className="btn" type="button" onClick={() => setEditing(null)}>Cancel</button></div>{error && <p className="note crit">{error}</p>}
        </form>}

        {unusable > 0 && (
          <p className="note count">
            {unusable} of {cityRuleTableRows} rows under this heading could not be used — a row
            needs a key and a display city, and the <span className="mono">default</span> row is
            skipped on purpose because remote postings are handled in code. Those rows are still in
            profile.md; the agent simply does not see them.
          </p>
        )}
        {orphans > 0 && (
          <p className="note count">
            An orphaned key has a generated address but no rule that can select it. The address
            stays in <span className="mono">state.json</span> and is never used.{" "}
            <span className="mono">default</span> is never one: the parser skips that row
            deliberately and every remote posting resolves to it.
          </p>
        )}
        {!addresses.stateJsonExists && (
          <p className="note count">
            There is no <span className="mono">state.json</span> yet, so nothing has been generated.
            The agent writes one on its first application.
          </p>
        )}
      </div>

      {(["cityRules", "cityNormalization", "addressPolicy"] as const).map((id) => <form className="rb-profile-form rb-settings-form" key={id} onSubmit={(e) => { e.preventDefault(); onMarkdownSave(id); }}><h3 className="rb-h-minor">{id === "cityRules" ? "City matching rules" : id === "cityNormalization" ? "City normalization" : "Address policy"}</h3><p className="note">Saved as Markdown without reformatting. These rules select among truthful saved addresses.</p><textarea aria-label={id === "cityRules" ? "City matching rules" : id === "cityNormalization" ? "City normalization" : "Address policy"} className="control tall wide" value={markdown[id] ?? ""} onChange={(e) => onMarkdownChange(id, e.target.value)} /><button className="btn primary" type="submit" disabled={!markdownDirty(id) || saving === id}>Save rules</button></form>)}

      <div className="card">
        <div className="head">
          <h2 className="rb-h-major">Supporting sections</h2>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Section</th>
                <th>Status</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">### City normalization rules</td>
                <td>
                  {hasNormalization ? (
                    <Stamp tone="good">present</Stamp>
                  ) : (
                    <Stamp tone="warn">absent</Stamp>
                  )}
                </td>
                <td className="note">
                  Tells the agent how to match a posting&rsquo;s city when it does not equal a row
                  exactly. Without it the agent applies its own normalization.
                </td>
              </tr>
              <tr>
                <td className="mono">## Address policy reminder</td>
                <td>
                  {hasAddressPolicy ? (
                    <Stamp tone="good">present</Stamp>
                  ) : (
                    <Stamp tone="warn">absent</Stamp>
                  )}
                </td>
                <td className="note">
                  The reminder that <span className="mono">generate_address</span> may use only the
                  ZIPs a rule declares. Without it that constraint is not in the prompt the agent
                  reads.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p className="note">Saved addresses are user-provided facts. Matching rules remain visible separately so a rule is never presented as proof of residence.</p>
    </div>
  );
}
