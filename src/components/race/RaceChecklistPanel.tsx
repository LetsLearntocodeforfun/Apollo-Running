/**
 * Race-week checklist for the selected race (v1.0.6, L-13).
 *
 * One list per race via getOrCreateChecklistForRace (a generic list when no
 * race is selected). The list is created in an effect, never during render.
 * Default items can be hidden (excluded from progress); the athlete's own
 * items can be removed.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { RacePanelProps } from './types';
import { ConfirmDialog } from '../ui';
import {
  CATEGORY_LABELS,
  CHECKLIST_CATEGORIES,
  addCustomItem,
  computeChecklistProgress,
  getChecklistById,
  getOrCreateChecklistForRace,
  hideChecklistItem,
  removeChecklistItem,
  resetChecklist,
  toggleChecklistItem,
  unhideChecklistItem,
  type ChecklistCategory,
  type ChecklistItem,
  type RaceChecklist,
} from '../../services/raceChecklist';

type Drafts = Partial<Record<ChecklistCategory, string>>;

export default function RaceChecklistPanel({ ctx }: RacePanelProps) {
  const raceId = ctx.race?.id ?? null;
  const year = ctx.raceDate ? ctx.raceDate.slice(0, 4) : '';
  const listName = ctx.race ? `${ctx.race.name}${year ? ` ${year}` : ''}` : 'Race week checklist';

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const [list, setList] = useState<RaceChecklist | null>(null);
  const [open, setOpen] = useState<ReadonlySet<ChecklistCategory>>(() => new Set());
  const [drafts, setDrafts] = useState<Drafts>({});
  const [showHidden, setShowHidden] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Get-or-create in an effect so rendering never writes to storage.
  useEffect(() => {
    setList(getOrCreateChecklistForRace(raceId, listName));
  }, [raceId, listName]);

  if (!list) {
    return (
      <section className="race-week-section" aria-labelledby={titleId}>
        <h2 id={titleId} className="race-week-title">Race week checklist</h2>
        <p className="race-week-muted">Loading checklist…</p>
      </section>
    );
  }

  const listId = list.id;
  const refresh = () => {
    setList(getChecklistById(listId) ?? getOrCreateChecklistForRace(raceId, listName));
  };

  const toggleOpen = (cat: ChecklistCategory) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleToggle = (itemId: string) => {
    toggleChecklistItem(listId, itemId);
    refresh();
  };

  const handleHideToggle = (item: ChecklistItem) => {
    if (item.hidden) unhideChecklistItem(listId, item.id);
    else hideChecklistItem(listId, item.id);
    refresh();
  };

  const handleRemove = (itemId: string) => {
    removeChecklistItem(listId, itemId);
    refresh();
  };

  const handleAdd = (e: FormEvent<HTMLFormElement>, cat: ChecklistCategory) => {
    e.preventDefault();
    const text = (drafts[cat] ?? '').trim();
    if (!text) return;
    if (addCustomItem(listId, text, cat)) {
      setDrafts((d) => ({ ...d, [cat]: '' }));
      refresh();
    }
  };

  const handleReset = () => {
    resetChecklist(listId);
    setConfirmReset(false);
    refresh();
  };

  const progress = computeChecklistProgress(list);
  const hiddenCount = list.items.filter((i) => i.hidden).length;

  const renderItem = (item: ChecklistItem) => {
    const checkId = `${baseId}-item-${item.id}`;
    const classes = ['race-week-item'];
    if (item.checked) classes.push('is-checked');
    if (item.hidden) classes.push('is-hidden');
    return (
      <li key={item.id} className={classes.join(' ')}>
        <input
          id={checkId}
          type="checkbox"
          className="race-week-checkbox"
          checked={item.checked}
          disabled={item.hidden}
          onChange={() => handleToggle(item.id)}
        />
        <label htmlFor={checkId} className="race-week-item-text">{item.text}</label>
        {item.isCourse && <span className="race-week-tag">Course</span>}
        {item.isCustom && <span className="race-week-tag">Yours</span>}
        {item.hidden && <span className="race-week-tag">Hidden</span>}
        {item.isCustom ? (
          <button type="button" className="btn btn-ghost race-week-item-action" onClick={() => handleRemove(item.id)}>
            Remove<span className="sr-only">: {item.text}</span>
          </button>
        ) : (
          <button type="button" className="btn btn-ghost race-week-item-action" onClick={() => handleHideToggle(item)}>
            {item.hidden ? 'Unhide' : 'Hide'}<span className="sr-only">: {item.text}</span>
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="race-week-section" aria-labelledby={titleId}>
      <div className="race-week-header">
        <h2 id={titleId} className="race-week-title">Race week checklist</h2>
        <p className="race-week-muted">
          {ctx.race ? `For ${ctx.race.name}` : 'No race selected — showing a general race-week list.'}
        </p>
      </div>

      <p className="race-week-progress-text">
        {progress.checked} of {progress.total} done ({progress.pct}%)
      </p>
      <div
        className="race-week-bar"
        role="progressbar"
        aria-label="Checklist progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.pct}
      >
        <div className="race-week-bar-fill" style={{ width: `${progress.pct}%` }} />
      </div>

      <div className="race-week-cats">
        {CHECKLIST_CATEGORIES.map((cat) => {
          const all = list.items.filter((i) => i.category === cat);
          const visible = all.filter((i) => !i.hidden);
          const shown = showHidden ? all : visible;
          const done = visible.filter((i) => i.checked).length;
          const isOpen = open.has(cat);
          const panelId = `${baseId}-${cat}`;
          const inputId = `${baseId}-${cat}-new`;
          const draft = drafts[cat] ?? '';
          return (
            <div key={cat} className="race-week-cat">
              <h3 className="race-week-cat-heading">
                <button
                  type="button"
                  className="race-week-disclosure"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggleOpen(cat)}
                >
                  <span className="race-week-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="race-week-cat-label">{CATEGORY_LABELS[cat]}</span>
                  <span className="race-week-cat-count">
                    {done}/{visible.length}<span className="sr-only"> done</span>
                  </span>
                </button>
              </h3>
              <div id={panelId} className="race-week-cat-body" hidden={!isOpen}>
                {shown.length === 0 ? (
                  <p className="race-week-muted">No items yet.</p>
                ) : (
                  <ul className="race-week-items">{shown.map(renderItem)}</ul>
                )}
                <form className="race-week-add" onSubmit={(e) => handleAdd(e, cat)}>
                  <label htmlFor={inputId} className="sr-only">New item for {CATEGORY_LABELS[cat]}</label>
                  <input
                    id={inputId}
                    type="text"
                    className="race-week-input"
                    value={draft}
                    maxLength={200}
                    placeholder="Add your own item"
                    onChange={(e) => setDrafts((d) => ({ ...d, [cat]: e.target.value }))}
                  />
                  <button
                    type="submit"
                    className="btn btn-secondary race-week-btn"
                    disabled={!draft.trim()}
                    aria-label={`Add item to ${CATEGORY_LABELS[cat]}`}
                  >
                    <span aria-hidden="true">+</span> Add item
                  </button>
                </form>
              </div>
            </div>
          );
        })}
      </div>

      <div className="race-week-actions">
        {hiddenCount > 0 && (
          <button
            type="button"
            className="btn btn-ghost race-week-btn"
            aria-pressed={showHidden}
            onClick={() => setShowHidden((v) => !v)}
          >
            Show hidden ({hiddenCount})
          </button>
        )}
        <button type="button" className="btn btn-outline race-week-btn" onClick={() => setConfirmReset(true)}>
          Reset checklist
        </button>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Reset checklist?"
        message="This unchecks every item. Your own items and hidden items are kept."
        confirmLabel="Reset"
        tone="danger"
        onConfirm={handleReset}
        onCancel={() => setConfirmReset(false)}
      />
    </section>
  );
}
