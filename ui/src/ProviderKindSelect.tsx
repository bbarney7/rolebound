import type { ProviderKind } from "../shared/providers";
import {
  catalogEntryFor,
  CURSOR_PROVIDER_ENTRY,
  OPENAI_COMPATIBLE_ENTRY,
  POPULAR_PROVIDER_IDS,
  PROVIDER_CATALOG,
  providerSupportsApiKey,
} from "../shared/providerCatalog";

function envHint(providerId: string): string {
  const entry = catalogEntryFor(providerId);
  if (!entry?.auth.apiKey) return "";
  return entry.auth.apiKey.env ?? entry.apiKeyEnv ?? "";
}

export default function ProviderKindSelect({
  id,
  value,
  onChange,
  only,
}: {
  id: string;
  value: ProviderKind;
  onChange: (value: ProviderKind) => void;
  only?: "apiKey";
}) {
  const catalog = only === "apiKey" ? PROVIDER_CATALOG.filter((entry) => providerSupportsApiKey(entry.id)) : PROVIDER_CATALOG;
  const popular = POPULAR_PROVIDER_IDS.map((providerId) => {
    if (providerId === "cursor") return CURSOR_PROVIDER_ENTRY;
    return catalog.find((entry) => entry.id === providerId);
  }).filter(Boolean) as Array<{ id: string; name: string }>;
  const popularSet = new Set(popular.map((entry) => entry.id));
  const rest = catalog.filter((entry) => !popularSet.has(entry.id));

  const option = (providerId: string, label: string) => {
    const hint = envHint(providerId);
    const text = hint ? `${label} (${hint})` : label;
    return (
      <option key={providerId} value={providerId}>
        {text}
      </option>
    );
  };

  return (
    <select id={id} className="control" value={value} onChange={(e) => onChange(e.target.value as ProviderKind)}>
      <optgroup label="Popular">
        {popular.map((entry) => option(entry.id, entry.name))}
      </optgroup>
      <optgroup label="All providers (A–Z)">
        {rest.map((entry) => option(entry.id, entry.name))}
      </optgroup>
      {only !== "apiKey" && (
        <optgroup label="Custom">
          {option(OPENAI_COMPATIBLE_ENTRY.id, OPENAI_COMPATIBLE_ENTRY.name)}
        </optgroup>
      )}
      {only === "apiKey" && providerSupportsApiKey(OPENAI_COMPATIBLE_ENTRY.id) && (
        <optgroup label="Custom">
          {option(OPENAI_COMPATIBLE_ENTRY.id, OPENAI_COMPATIBLE_ENTRY.name)}
        </optgroup>
      )}
    </select>
  );
}
