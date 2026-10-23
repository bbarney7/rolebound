export function LoadingState() {
  return (
    <div className="state rb-state" role="status" aria-label="Loading">
      <div className="skeleton rb-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p>Loading…</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state crit rb-state" role="alert">
      <span className="glyph" aria-hidden="true">!</span>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  copy,
  action,
  onAction,
}: {
  title: string;
  copy: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="state empty rb-state">
      <h3>{title}</h3>
      <p>{copy}</p>
      {action && onAction ? (
        <button type="button" className="btn primary" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}
