import { useState } from 'react';
import TabBar from '../components/TabBar';
import Products from './Products';
import Categories from './Categories';

// Merges the old separate Products / Inventory / Categories nav items into
// one page. The underlying data stays split across two backend tables
// (products vs. per-store inventory) — that's deliberate, see schema.sql —
// but there's no reason a reviewer needs three separate sidebar entries to
// manage what is, from their side, one catalog. "Adjust stock" now lives as
// a row action inside Products instead of its own tab.
const TABS = [
  { key: 'products', label: 'Products' },
  { key: 'categories', label: 'Categories' },
];

export default function Catalog() {
  const [tab, setTab] = useState('products');

  return (
    <div>
      <TabBar tabs={TABS} active={tab} onChange={setTab} className="px-4 md:px-8 pt-4 md:pt-6" />
      {tab === 'products' ? <Products /> : <Categories />}
    </div>
  );
}
