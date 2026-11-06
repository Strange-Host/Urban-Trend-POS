import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { incomeSourcesApi } from '../api/endpoints';
import PageHeader from '../components/shell/PageHeader';
import { BranchesSection, SuppliersSection } from './SettingsBranches';
import { CustomerPaymentDetails, SmsSection, WebFormLeadsSection } from './SettingsMessaging';
import { ServerAddressSection, EmailSection, KcbAdvancedSection } from './SettingsSystem';
import GeneralSettings from './settings/GeneralSettings';
import BackupsSection from './settings/BackupsSection';
import OptionalModulesSection from './settings/OptionalModulesSection';
import { StoresTab } from './settings/IncomeSources';
import { PaymentGatewaysSection } from './settings/PaymentGatewaysSection';

// Kept here so existing imports of PaymentGatewaysSection from this file keep working.
export { PaymentGatewaysSection };

/* -------------------------------- Main page -------------------------------- */

const SETTINGS_TABS = [
  { key: 'business', label: 'Business' },
  { key: 'payments', label: 'Payments' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'stores', label: 'Stores' },
  { key: 'branches', label: 'Branches & suppliers' },
  { key: 'server', label: 'Server' },
];

export default function Settings() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  // The open tab lives in the address (?tab=stores) so a refresh, the back button
  // and links from other pages (e.g. "turn on live sync") land on the right one.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab = SETTINGS_TABS.some((t) => t.key === requested) ? requested : 'business';
  function selectTab(key) {
    setSearchParams(key === 'business' ? {} : { tab: key }, { replace: true });
  }

  const { data: sources, isLoading } = useQuery({
    queryKey: ['income-sources'],
    queryFn: () => incomeSourcesApi.list().then((r) => r.data.data),
  });

  function closeForm() {
    setShowAdd(false);
    setEditing(null);
  }
  function handleSaved() {
    closeForm();
    queryClient.invalidateQueries({ queryKey: ['income-sources'] });
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <PageHeader
        title="Settings"
        description="Business details, payments, messaging, your online stores, and the server."
        tabs={{ items: SETTINGS_TABS, active: tab, onChange: selectTab, className: '-mx-4 px-4 md:mx-0 md:px-0' }}
      />

      {tab === 'business' && (
        <>
          <OptionalModulesSection />
          <GeneralSettings />
          <CustomerPaymentDetails />
        </>
      )}

      {tab === 'payments' && (
        <>
          <PaymentGatewaysSection />
          <KcbAdvancedSection />
        </>
      )}

      {tab === 'messaging' && (
        <>
          <SmsSection />
          <WebFormLeadsSection />
        </>
      )}

      {tab === 'branches' && (
        <>
          <BranchesSection />
          <SuppliersSection />
        </>
      )}

      {tab === 'server' && (
        <>
          <ServerAddressSection />
          <EmailSection />
          <BackupsSection />
        </>
      )}

      {tab === 'stores' && (
        <StoresTab sources={sources} isLoading={isLoading} showAdd={showAdd} setShowAdd={setShowAdd}
          editing={editing} setEditing={setEditing} closeForm={closeForm} handleSaved={handleSaved} />
      )}
    </div>
  );
}
