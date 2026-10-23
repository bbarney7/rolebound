import type { ReactNode } from "react";

export type TopbarProps = {
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
};

/** Page title for routes still composed with surfaces-owned content below. */
export default function Topbar({ title, sub, action }: TopbarProps) {
  return (
    <header className="topbar rb-page-head">
      <div className="rb-page-head-copy">
        <h1 className="rb-page-title">{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {action ? <div className="topbar-actions">{action}</div> : null}
    </header>
  );
}
