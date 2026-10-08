import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional small badge rendered after the label (e.g. a count). */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  /** Accessible name for the tab list, e.g. "Race Day sections". */
  label: string;
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Stable prefix for tab/panel ids. Defaults to a React useId(). */
  idPrefix?: string;
  className?: string;
}

/** Element ids shared by <Tabs> and <TabPanel>. */
export function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}
export function panelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

/**
 * Accessible tab list (WAI-ARIA tabs pattern, automatic activation).
 * Arrow keys / Home / End move between tabs. Pair with <TabPanel>.
 */
export function Tabs({ label, tabs, value, onChange, idPrefix, className }: TabsProps) {
  const autoId = useId();
  const prefix = idPrefix ?? autoId.replace(/:/g, '');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = tabs.filter((t) => !t.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = enabled.findIndex((t) => t.id === value);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next === null || enabled.length === 0) return;
    e.preventDefault();
    const target = enabled[next];
    onChange(target.id);
    refs.current[target.id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={`ui-tabs${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el; }}
            type="button"
            role="tab"
            id={tabId(prefix, t.id)}
            aria-controls={panelId(prefix, t.id)}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className="ui-tab"
            onClick={() => onChange(t.id)}
          >
            <span>{t.label}</span>
            {t.badge != null && <span className="ui-tab-badge">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix: string;
  id: string;
  children: ReactNode;
  className?: string;
}

/** Panel for the selected tab. Render only the active panel. */
export function TabPanel({ idPrefix, id, children, className }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      tabIndex={0}
      className={`ui-tabpanel${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
