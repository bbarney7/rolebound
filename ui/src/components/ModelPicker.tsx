import { useWorkspaceOverlay } from "../chat/WorkspaceOverlayContext";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./modelPicker.css";

type ModelOption = { id: string; label?: string };

export default function ModelPicker({ id, value, models, onChange, required = false, disabled = false, loading = false }: {
  id: string;
  value: string;
  models: ModelOption[];
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const portalHost = useWorkspaceOverlay();
  const [queryText, setQueryText] = useState("");
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const query = searching ? queryText.trim().toLowerCase() : "";
  const catalogOptions = [...new Map(models.map(model => [model.id, model])).values()]
    .filter(model => `${model.id} ${model.label ?? ""}`.toLowerCase().includes(query));
  const customId = searching ? queryText.trim() : "";
  const options = customId && !models.some(model => model.id === customId)
    ? [...catalogOptions, { id: customId, label: `Use custom model ID “${customId}”` }]
    : catalogOptions;
  const listId = `${id}-options`;

  function close() { setOpen(false); setSearching(false); setQueryText(""); setActive(-1); }
  function choose(model: ModelOption) { onChange(model.id); close(); inputRef.current?.focus(); }

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < 220 && above > below;
      const next: CSSProperties = {
        position: "fixed", left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
        width: Math.min(rect.width, window.innerWidth - 16),
        maxHeight: Math.max(80, Math.min(320, upwards ? above : below)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      };
      setPosition(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    update();
    let frame = requestAnimationFrame(update);
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (anchorRef.current?.parentElement) observer?.observe(anchorRef.current.parentElement);
    observer?.observe(document.documentElement);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  useEffect(() => {
    if (!open || searching) return;
    const selected = options.findIndex(model => model.id === value);
    if (selected >= 0) document.getElementById(`${listId}-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, searching, value, models, listId, position]);

  const activeIndex = active >= 0 && active < options.length ? active : -1;
  return <div className="rb-model-picker" ref={anchorRef}>
    <input
      ref={inputRef} id={id} className="control" role="combobox" autoComplete="off" spellCheck={false}
      aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      value={searching ? queryText : value} required={required} disabled={disabled} placeholder="Search or enter a model…"
      onFocus={() => { setOpen(true); setSearching(false); setActive(-1); }}
      onBlur={close}
      onChange={event => { setQueryText(event.target.value); setSearching(true); setOpen(true); setActive(-1); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          setActive(index => {
            const current = index < 0 && !searching ? options.findIndex(model => model.id === value) : index;
            return options.length ? (event.key === "ArrowDown" ? (current + 1) % options.length : (current <= 0 ? options.length - 1 : current - 1)) : -1;
          });
        } else if (event.key === "Enter" && open && activeIndex >= 0) {
          event.preventDefault(); choose(options[activeIndex]!);
        } else if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); close();
        } else if (event.key === "Tab") close();
      }}
    />
    <button type="button" className="rb-model-picker-toggle" tabIndex={-1} disabled={disabled}
      aria-label="Show available models" aria-expanded={open} aria-controls={open ? listId : undefined}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { if (open) close(); else { inputRef.current?.focus(); setOpen(true); setSearching(false); } }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && createPortal(<div ref={menuRef} className="rb-model-menu" style={position}
      onMouseDown={event => event.preventDefault()}>
      <div className="rb-model-menu-head"><span>Available models</span><span>{loading ? "Loading…" : options.length}</span></div>
      <div role="listbox" id={listId} aria-label="Available models" className="rb-model-options" aria-busy={loading}>
        {options.map((model, index) => <div key={model.id} id={`${listId}-${index}`} role="option"
          aria-label={model.label && model.label !== model.id ? `${model.label} ${model.id}` : model.id}
          aria-selected={value === model.id} className={`rb-model-option${activeIndex === index ? " is-active" : ""}`}
          onMouseEnter={() => setActive(index)} onClick={() => choose(model)}>
          <span className="rb-model-option-copy"><span>{model.label || model.id}</span>
            {model.label && model.label !== model.id && <small>{model.id}</small>}</span>
          {value === model.id && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
        </div>)}
      </div>
      {options.length === 0 && <p className="rb-model-menu-empty" role="status">{loading ? "Loading available models…" : models.length ? "No matches. You can enter a custom model ID." : "Load the catalog or enter a model ID."}</p>}
    </div>, portalHost ?? document.body)}
  </div>;
}
