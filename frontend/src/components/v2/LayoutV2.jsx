import Layout from '../Layout';

// Phase 0 placeholder for the redesigned shell. It renders today's layout unchanged so that turning the flag on
// is safe at every stage; Phases 1 and 2 replace the inside of this component with the new side rail, PageHeader
// and tabs. The small marker lets a tester see which UI they are on during role walk-throughs.
export default function LayoutV2() {
  return (
    <>
      <Layout />
      <div
        data-testid="ui-v2-marker"
        aria-hidden="true"
        className="pointer-events-none fixed bottom-1 left-1/2 z-[90] -translate-x-1/2 rounded-full bg-ink/80 px-2 py-0.5 text-[10px] font-medium text-white"
      >
        UI v2 preview
      </div>
    </>
  );
}
