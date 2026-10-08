import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' styles the confirm button for destructive actions. */
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional extra content (e.g. a checkbox) rendered under the message. */
  children?: ReactNode;
}

/**
 * Modal confirmation built on the native <dialog> element (focus trap and Esc
 * for free). Replaces window.confirm(). Falls back to a non-modal open dialog
 * where showModal() is unavailable (e.g. jsdom).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      if (typeof dlg.showModal === 'function') {
        try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
      } else {
        dlg.setAttribute('open', '');
      }
      // Destructive dialogs focus Cancel first so Enter doesn't destroy data.
      cancelRef.current?.focus();
    } else if (!open && dlg.open) {
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className="ui-dialog"
      aria-labelledby={titleId}
      aria-describedby={message ? descId : undefined}
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
    >
      <h2 id={titleId} className="ui-dialog-title">{title}</h2>
      {message && <div id={descId} className="ui-dialog-body">{message}</div>}
      {children}
      <div className="ui-dialog-actions">
        <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={tone === 'danger' ? 'btn ui-btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
