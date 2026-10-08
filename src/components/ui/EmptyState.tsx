import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

/** Consistent empty/zero-data state for cards and pages. */
export function EmptyState({ icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      {icon && <div className="ui-empty-icon" aria-hidden="true">{icon}</div>}
      <p className="ui-empty-title">{title}</p>
      {children && <div className="ui-empty-body">{children}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
