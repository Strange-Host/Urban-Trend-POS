import PageHeader from '../components/shell/PageHeader';
import { CustomerPaymentDetails, SmsSection, WebFormLeadsSection } from './SettingsMessaging';
import { BranchesSection, SuppliersSection } from './SettingsBranches';
import { ServerAddressSection, EmailSection, KcbAdvancedSection } from './SettingsSystem';
import { useSearchParams } from 'react-router-dom';
import useModules from '../hooks/useModules';
import GeneralSettings from './settings/General';
import BackupsSection from './settings/Backups';
import OptionalModulesSection from './settings/OptionalModules';
import IncomeSourcesSection from './settings/IncomeSources';
import { PaymentGatewaysSection } from './settings/PaymentGateways';

// The Payments tab section is exported from here as well, for the tests that mount it on its own.
export { PaymentGatewaysSection };

const SETTINGS_TABS = [
  { key: 'business', label: 'Business' },
  { key: 'payments', label: 'Payments' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'stores', label: 'Stores' },
  { key: 'branches', label: 'Branches & suppliers' },
  { key: 'server', label: 'Server' },
];

export default function Settings() {
  // The open tab lives in the address (?tab=stores) so a refresh, the back button
  // and links from other pages (e.g. "turn on live sync") land on the right one.
  const [searchParams, setSearchParams] = useSearchParams();
  const modules = useModules();
  // Without multi-branch mode this tab is only about suppliers, so it is named for that.
  const tabs = SETTINGS_TABS.map((t) => (t.key === 'branches' && !modules.branches ? { ...t, label: 'Suppliers' } : t));
  const requested = searchParams.get('tab');
  const tab = tabs.some((t) => t.key === requested) ? requested : 'business';
  function selectTab(key) {
    setSearchParams(key === 'business' ? {} : { tab: key }, { replace: true });
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <PageHeader
        title="Settings"
        description="Business details, payments, messaging, your online stores, and the server."
        tabs={{ items: tabs, active: tab, onChange: selectTab, className: '-mx-4 px-4 md:mx-0 md:px-0' }}
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
          {modules.branches && <BranchesSection />}
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

      {tab === 'stores' && <IncomeSourcesSection />}
    </div>
  );
}
