import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tabs, TabPanel, ConfirmDialog, EmptyState } from '../components/ui';

function TabsHarness() {
  const [tab, setTab] = useState('a');
  return (
    <>
      <Tabs
        label="Sections"
        idPrefix="t"
        value={tab}
        onChange={setTab}
        tabs={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', badge: 3 }, { id: 'c', label: 'Gamma' }]}
      />
      <TabPanel idPrefix="t" id={tab}>Panel {tab}</TabPanel>
    </>
  );
}

describe('ui primitives', () => {
  it('Tabs exposes ARIA roles and supports arrow-key navigation', () => {
    render(<TabsHarness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('Panel a');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(screen.getByRole('tabpanel').textContent).toBe('Panel b');
    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(screen.getByRole('tabpanel').textContent).toBe('Panel c');
    fireEvent.keyDown(tabs[2], { key: 'ArrowRight' });
    expect(screen.getByRole('tabpanel').textContent).toBe('Panel a');
    fireEvent.click(screen.getByText('Beta'));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('t-tab-b');
  });

  it('ConfirmDialog renders only when open and calls handlers', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog open={false} title="Delete?" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.queryByText('Delete?')).toBeNull();
    rerender(
      <ConfirmDialog open title="Delete?" message="This cannot be undone." tone="danger"
        confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.getByText('Delete?')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('EmptyState renders title, body and action', () => {
    render(<EmptyState title="No runs yet" action={<button>Import</button>}>Connect a source.</EmptyState>);
    expect(screen.getByText('No runs yet')).toBeTruthy();
    expect(screen.getByText('Connect a source.')).toBeTruthy();
    expect(screen.getByText('Import')).toBeTruthy();
  });
});
