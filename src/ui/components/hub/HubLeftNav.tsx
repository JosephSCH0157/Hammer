import type { ReactNode } from "react";

const NAV_ITEMS = [
  { id: "start", label: "Start" },
  { id: "templates", label: "Templates" },
  { id: "tools", label: "Tools" },
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

type Props = {
  active: NavId;
  onSelect?: (id: NavId) => void;
  header?: ReactNode;
};

export function HubLeftNav({ active, onSelect, header }: Props) {
  return (
    <aside className="hub-leftnav">
      <div className="hub-brand">
        <span className="hub-brand-mark">Hammer</span>
        <span className="hub-brand-subtitle">Project Hub</span>
      </div>
      {header}
      <nav className="hub-nav" aria-label="Project hub navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`hub-nav-item${active === item.id ? " active" : ""}`}
            onClick={() => onSelect?.(item.id)}
            disabled={item.id !== "start"}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
