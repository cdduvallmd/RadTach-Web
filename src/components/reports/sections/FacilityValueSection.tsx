// Facility value block (owner, 2026-11-09): sits right above the PVC block in
// the Daily, Weekly, Monthly and Quarterly reports. Self-hides when no session
// in the period carries technical-component RVU. Not part of PVC.
import { facilityValue } from '../../../utils/facilityValue';
import type { StoredSession } from '../../../types/reports';

interface Props {
  sessions: StoredSession[];
}

const usd = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function FacilityValueSection({ sessions }: Props) {
  const v = facilityValue(sessions);
  if (v.tcRvuStudies === 0) return null;
  const perHour = v.hours > 0 ? v.tcRvu / v.hours : null;
  const cells = [
    { label: 'Facility tcRVU', value: v.tcRvu.toFixed(2), cls: 'text-cyan-400' },
    { label: 'tcRVU / hr', value: perHour != null ? perHour.toFixed(2) : '—', cls: 'text-white' },
    { label: 'Est. value (Medicare)', value: v.dollars != null ? usd(v.dollars) : '—', cls: 'text-green-400' },
    { label: 'Value / hr', value: v.dollars != null && v.hours > 0 ? usd(v.dollars / v.hours) : '—', cls: 'text-green-400' },
  ];
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="text-white font-medium mb-3">Value to the Facility</h3>
      <div className="grid grid-cols-4 gap-3">
        {cells.map(c => (
          <div key={c.label} className="bg-gray-900/50 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-gray-400">{c.label}</div>
            <div className={`text-lg font-medium ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 mt-2">
        Technical-component RVU of {v.tcRvuStudies} of {v.totalStudies} studies (studies with CPT codes and a known
        technical value); per-hour figures use the full hours of those sessions. Dollars at the Medicare national rate
        {v.conversionFactor != null ? ` (${usd(v.conversionFactor)} per RVU)` : ''}, before multiple-procedure
        reduction; actual hospital payment differs. Not part of PVC.
      </p>
    </div>
  );
}
