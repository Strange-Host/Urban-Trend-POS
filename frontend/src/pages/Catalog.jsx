import { useState } from 'react';
import PageHeader from '../components/shell/PageHeader';
import PageSection from '../components/shell/PageSection';
import Products from './Products';
import Categories from './Categories';
import { useAuth } from '../context/AuthContext';

// Merges the old separate Products / Inventory / Categories nav items into
// one page. The underlying data stays split across two backend tables
// (products vs. per-store inventory) — that's deliberate, see schema.sql —
// but there's no reason a reviewer needs three separate sidebar entries to
// manage what is, from their side, one catalog. "Adjust stock" now lives as
// a row action inside Products instead of its own tab.
// Two catalogues, kept apart on purpose: "Products" is what the shop stocks and sells at the till (the only stock the
// shop tracks); "Online products" lists the Shopify/WooCommerce listings, whose stock is held elsewhere and not tracked.
const TABS = [
  { key: 'products', label: 'Products' },
  { key: 'online', label: 'Online products' },
  { key: 'categories', label: 'Categories' },
];

export default function Catalog() {
  const [tab, setTab] = useState('products');
  const { can } = useAuth();
  // A storekeeper can only propose products; managing categories needs the full products permission.
  const canManage = can('products.manage');

  const body = tab === 'categories' && canManage ? <Categories />
    : tab === 'online' && canManage ? <Products key="online" catalogue="online" />
      : <Products key="shop" catalogue="shop" />;

  // Only people who manage the catalog get the tabs (and so a header of their own). Everyone else sees Products on its own,
  // which then draws its own page header.
  return (
    <div>
      {canManage ? (
        <>
          <PageHeader title="Catalog" padding="px-4 md:px-8 pt-4 md:pt-6" tabs={{ items: TABS, active: tab, onChange: setTab }} />
          <PageSection>{body}</PageSection>
        </>
      ) : body}
    </div>
  );
}
