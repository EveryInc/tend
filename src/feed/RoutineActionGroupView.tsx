import type { RoutineActionGroup } from "../types";

export function RoutineActionGroupView({ group, onApprove }: { group: RoutineActionGroup; onApprove: () => void }) {
  return (
    <article className={`routine-group routine-${group.status}`}>
      <header className="routine-group-head">
        <div>
          <div className="panel-kicker">{group.status === "proposed" ? "Suggested routine action" : `Routine action · ${group.status}`}</div>
          <h2>{group.label}</h2>
          <p>{group.summary}</p>
        </div>
        {group.status === "proposed" && <button className="button primary" onClick={onApprove}>{group.proposedAction.label}</button>}
      </header>
      <details>
        <summary>{group.items.length} item{group.items.length === 1 ? "" : "s"} <span>{group.status === "proposed" ? "Review before approving" : "Show details"}</span></summary>
        <ul className="routine-items">
          {group.items.map((item) => (
            <li key={item.id}>
              <div>
                <b>{item.title}</b>
                {item.detail && <span>{item.detail}</span>}
                <small>{item.reason}</small>
              </div>
              {item.sourceRefs?.map((ref) => <a key={ref.href} href={ref.href} target="_blank" rel="noreferrer">{ref.label}</a>)}
            </li>
          ))}
        </ul>
      </details>
      {group.error && <p className="routine-error">{group.error}</p>}
    </article>
  );
}
