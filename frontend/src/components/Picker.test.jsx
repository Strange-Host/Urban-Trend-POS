import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import Picker, { Segmented } from './Picker';

const opts = [{ value: 1, label: 'Kitchenware' }, { value: 2, label: 'Footwear' }, { value: 3, label: 'Apparel', hint: 'Clothes' }];

function Harness(props) {
  const [v, setV] = useState(props.initial ?? '');
  return <Picker value={v} onChange={(x) => { setV(x); props.onChange?.(x); }} options={props.options || opts} title="Category" {...props.extra} />;
}

describe('Picker', () => {
  it('shows the placeholder, opens a list, and choosing an option sets it and closes', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} extra={{ placeholder: 'Pick one…' }} />);
    expect(screen.getByRole('button', { name: /pick one/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pick one/i }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);

    fireEvent.click(screen.getByRole('option', { name: /footwear/i }));
    expect(onChange).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: /footwear/i })).toBeInTheDocument();
  });

  it('marks the current choice and shows hints', () => {
    render(<Harness initial={3} />);
    fireEvent.click(screen.getByRole('button', { name: /apparel/i }));
    expect(screen.getByRole('option', { name: /apparel/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Clothes')).toBeInTheDocument();
  });

  it('offers a "none" row when allowed, and clears the value', () => {
    const onChange = vi.fn();
    render(<Harness initial={1} onChange={onChange} extra={{ allowClear: true, clearLabel: 'No category' }} />);
    fireEvent.click(screen.getByRole('button', { name: /kitchenware/i }));
    fireEvent.click(screen.getByRole('option', { name: 'No category' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('adds a search box for long lists and filters by what is typed', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `Item ${i + 1}` }));
    render(<Harness options={many} />);
    fireEvent.click(screen.getByRole('button', { name: /select/i }));
    const search = screen.getByPlaceholderText('Search…');
    fireEvent.change(search, { target: { value: 'item 11' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No matches.')).toBeInTheDocument();
  });

  it('has no search box for short lists', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /select/i }));
    expect(screen.queryByPlaceholderText('Search…')).toBeNull();
  });

  it('lets you add a new option without leaving the list, then selects it', async () => {
    const onCreate = vi.fn().mockResolvedValue(99);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} extra={{ onCreate, createLabel: 'New category' }} />);
    fireEvent.click(screen.getByRole('button', { name: /select/i }));
    fireEvent.click(screen.getByRole('button', { name: /\+ new category/i }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Toys' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Toys'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(99));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the error when adding fails and stays open', async () => {
    const onCreate = vi.fn().mockRejectedValue({ response: { data: { error: { message: 'Name already used.' } } } });
    render(<Harness extra={{ onCreate }} />);
    fireEvent.click(screen.getByRole('button', { name: /select/i }));
    fireEvent.click(screen.getByRole('button', { name: /\+ add new/i }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Dup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/name already used/i)).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('can be marked invalid and disabled', () => {
    const { rerender } = render(<Picker value="" onChange={() => {}} options={opts} invalid />);
    expect(screen.getByRole('button').className).toMatch(/border-danger/);
    rerender(<Picker value="" onChange={() => {}} options={opts} disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('Segmented', () => {
  it('shows one selected option and reports changes', () => {
    const onChange = vi.fn();
    render(<Segmented value="add" onChange={onChange} aria-label="Mode" options={[{ value: 'add', label: 'Add' }, { value: 'remove', label: 'Remove' }]} />);
    expect(screen.getByRole('radio', { name: 'Add' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Remove' }));
    expect(onChange).toHaveBeenCalledWith('remove');
  });
});
