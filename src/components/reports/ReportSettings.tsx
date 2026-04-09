// Report Settings — president/globalAdmin only
// Checkbox grid: roles × report types. Reads/writes reportAccess from Firestore.

import { useState, useEffect } from 'react';
import { firestoreService } from '../../services/firestore';
import type { ReportType } from './ReportControlPanel';

const CONFIGURABLE_ROLES = ['radiologist', 'admin', 'hospitalAdmin', 'it'] as const;
const ROLE_LABELS: Record<typeof CONFIGURABLE_ROLES[number], string> = {
  radiologist: 'Radiologist',
  admin: 'Admin',
  hospitalAdmin: 'Hospital Admin',
  it: 'IT',
};

const ALL_TYPES: ReportType[] = ['session', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];
const TYPE_LABELS: Record<ReportType, string> = {
  session: 'Session',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom',
};

interface ReportSettingsProps {
  system: string | null;
  onClose: () => void;
}

export default function ReportSettings({ system, onClose }: ReportSettingsProps) {
  const [access, setAccess] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load existing config
  useEffect(() => {
    if (!system) { setLoading(false); return; }
    firestoreService.getReportAccess(system)
      .then(result => {
        if (result) {
          setAccess(result);
        } else {
          // Default: all roles get all types
          const defaults: Record<string, string[]> = {};
          for (const role of CONFIGURABLE_ROLES) {
            defaults[role] = [...ALL_TYPES];
          }
          setAccess(defaults);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [system]);

  const toggleType = (role: string, type: ReportType) => {
    setAccess(prev => {
      const roleTypes = prev[role] || [...ALL_TYPES];
      const next = roleTypes.includes(type)
        ? roleTypes.filter(t => t !== type)
        : [...roleTypes, type];
      return { ...prev, [role]: next };
    });
  };

  const handleSave = async () => {
    if (!system) return;
    setSaving(true);
    try {
      await firestoreService.setReportAccess(system, access);
      onClose();
    } catch (err) {
      console.error('Failed to save report access:', err);
      setSaving(false);
    }
  };

  if (!system) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
        <p className="text-gray-400 text-sm">Select a system to configure report access.</p>
        <button onClick={onClose} className="mt-2 px-3 py-1 text-sm bg-gray-700 text-white rounded">Close</button>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-medium">Report Access Settings — {system}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">✕</button>
      </div>

      <p className="text-xs text-gray-500 mb-3">
        Configure which report types each role can access. President and globalAdmin always have full access.
      </p>

      {loading ? (
        <p className="text-gray-400 text-sm">Loading...</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left text-gray-400 py-1.5 pr-4">Role</th>
                  {ALL_TYPES.map(type => (
                    <th key={type} className="text-center text-gray-400 py-1.5 px-2">
                      {TYPE_LABELS[type]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CONFIGURABLE_ROLES.map(role => {
                  const roleTypes = access[role] || [...ALL_TYPES];
                  return (
                    <tr key={role} className="border-b border-gray-700/50">
                      <td className="text-white py-1.5 pr-4">{ROLE_LABELS[role]}</td>
                      {ALL_TYPES.map(type => (
                        <td key={type} className="text-center py-1.5 px-2">
                          <input
                            type="checkbox"
                            checked={roleTypes.includes(type)}
                            onChange={() => toggleType(role, type)}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap-2 mt-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
