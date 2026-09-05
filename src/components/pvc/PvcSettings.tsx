// Practice Value Customization — admin settings panel
// Plan: /Users/charlesduvall/.claude/plans/vast-snuggling-kernighan.md
//
// Visible to admin/president/globalAdmin. Edits systems/{system}.pvc and
// writes audit history to pvcConfigHistory subcollection.

import { useState, useEffect } from 'react';
import { firestoreService } from '../../services/firestore';
import type {
  PvcConfig,
  RotationOverlay,
  CptAdjustment,
  CptAdjustmentMatchType,
  ProductivityTier,
} from '../../types/pvc';
import { DEFAULT_PVC_CONFIG } from '../../types/pvc';
import { getDefaultRotationOverlay } from '../../utils/pvcConfig';
import RetroactiveClassificationSection from './RetroactiveClassificationSection';

interface PvcSettingsProps {
  system: string | null;
  userId: string;
  // True when the current user has edit rights (admin / president /
  // globalAdmin on this system). False = read-only view. Either way the
  // retroactive meeting-time backfill section is interactive — every rad
  // can backfill their own meeting hours regardless of edit rights.
  canEdit: boolean;
  onClose: () => void;
}

// Stable id generator for new adjustment rows (no uuid dep needed).
function makeId() {
  return `adj_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export default function PvcSettings({ system, userId, canEdit, onClose }: PvcSettingsProps) {
  const [config, setConfig] = useState<PvcConfig>(DEFAULT_PVC_CONFIG);
  const [originalConfig, setOriginalConfig] = useState<PvcConfig | null>(null);
  const [rotations, setRotations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!system) { setLoading(false); return; }
    let cancelled = false;
    Promise.all([
      firestoreService.getPvcConfig(system),
      firestoreService.getSystemRotations(system),
    ]).then(([pvc, rots]) => {
      if (cancelled) return;
      const loadedConfig = pvc ?? { ...DEFAULT_PVC_CONFIG };
      setConfig(loadedConfig);
      setOriginalConfig(pvc);
      setRotations(rots ?? []);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      console.error('PVC settings load failed:', err);
      setError('Could not load PVC config');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [system]);

  const updateConfig = (patch: Partial<PvcConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }));
  };

  const updateRotationOverlay = (name: string, patch: Partial<RotationOverlay>) => {
    setConfig(prev => {
      const current = prev.rotationConfig[name] ?? getDefaultRotationOverlay(name);
      return {
        ...prev,
        rotationConfig: { ...prev.rotationConfig, [name]: { ...current, ...patch } },
      };
    });
  };

  const updateAdjustment = (id: string, patch: Partial<CptAdjustment>) => {
    setConfig(prev => ({
      ...prev,
      cptAdjustments: prev.cptAdjustments.map(a => a.id === id ? { ...a, ...patch } : a),
    }));
  };

  const addAdjustment = () => {
    const next: CptAdjustment = {
      id: makeId(),
      label: 'New adjustment',
      matchType: 'modality',
      matchValue: 'XR',
      operation: 'add',
      amount: 0,
      appliedToWorkRvuOnly: true,
    };
    setConfig(prev => ({ ...prev, cptAdjustments: [...prev.cptAdjustments, next] }));
  };

  const deleteAdjustment = (id: string) => {
    setConfig(prev => ({
      ...prev,
      cptAdjustments: prev.cptAdjustments.filter(a => a.id !== id),
    }));
  };

  const updateTier = (idx: number, patch: Partial<ProductivityTier>) => {
    setConfig(prev => ({
      ...prev,
      productivityTiers: prev.productivityTiers.map((t, i) => i === idx ? { ...t, ...patch } : t),
    }));
  };

  const addTier = () => {
    setConfig(prev => ({
      ...prev,
      productivityTiers: [...prev.productivityTiers, { thresholdDailyWrvu: 50, multiplier: 0.05 }],
    }));
  };

  const deleteTier = (idx: number) => {
    setConfig(prev => ({
      ...prev,
      productivityTiers: prev.productivityTiers.filter((_, i) => i !== idx),
    }));
  };

  const handleSave = async () => {
    if (!system) return;
    setSaving(true);
    setError(null);
    try {
      await firestoreService.writePvcConfigHistory(system, originalConfig, config, userId);
      await firestoreService.setPvcConfig(system, config, userId);
      onClose();
    } catch (err) {
      console.error('PVC save failed:', err);
      const msg = (err as { code?: string; message?: string })?.code ?? '';
      if (msg.includes('permission-denied') || (err as Error)?.message?.includes('insufficient permissions')) {
        setError(
          'Save was denied by Firebase security rules. You need to be signed in as an admin, president, or globalAdmin on this system to edit PVC settings. ' +
          'Sign in first, then reopen this panel. (Press F12 to view full error in the browser console.)'
        );
      } else {
        setError(
          'Save failed. Press F12 to open the browser Developer Console — the full error message and stack trace will be there ' +
          'under "PVC save failed:". If this persists, send a screenshot to RadTach support.'
        );
      }
      setSaving(false);
    }
  };

  if (!system) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
        <p className="text-gray-400 text-sm">Select a system to configure PVC.</p>
        <button onClick={onClose} className="mt-2 px-3 py-1 text-sm bg-gray-700 text-white rounded">Close</button>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-baseline gap-3">
          <h3 className="text-white font-medium">Practice Value Customization — {system}</h3>
          {!canEdit && (
            <span className="text-[11px] text-amber-400 bg-amber-900/30 px-2 py-0.5 rounded border border-amber-700">
              View only — ask an admin or president to edit
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">✕</button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Loading...</p>
      ) : (
        <div className="space-y-5 text-sm">
          {/* Retroactive meeting time backfill — every rad sees this even in
              view-only mode, because they can backfill their OWN sessions
              regardless of edit rights. */}
          <RetroactiveClassificationSection userId={userId} />

          {/* Editable configuration — wrapped in fieldset so the read-only
              mode disables every input inside in one shot. Cancel/close
              button below stays clickable because it's outside the fieldset. */}
          <fieldset disabled={!canEdit} className="space-y-5 m-0 p-0 border-0 disabled:opacity-60">
          {/* ── Global ──────────────────────────────────────────── */}
          <section>
            <h4 className="text-gray-300 font-medium mb-2">Global</h4>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-white">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={e => updateConfig({ enabled: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-700"
                />
                PVC enabled
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-400">Shift value ($) — leave blank for none</span>
                <input
                  type="number"
                  step="100"
                  value={config.shiftValue ?? ''}
                  onChange={e => {
                    const v = e.target.value.trim();
                    updateConfig({ shiftValue: v === '' ? null : Number(v) });
                  }}
                  className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-400">Shift terminology</span>
                <select
                  value={config.shiftLabel}
                  onChange={e => updateConfig({ shiftLabel: e.target.value as 'shift' | 'workingDay' })}
                  className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600"
                >
                  <option value="workingDay">Working Day</option>
                  <option value="shift">Shift</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-400" title="Applies to every user on this system who doesn't have a personal override">Default meeting RVU/hr</span>
                <input
                  type="number"
                  step="0.1"
                  value={config.defaultMeetingRvuRate}
                  onChange={e => updateConfig({ defaultMeetingRvuRate: Number(e.target.value) || 0 })}
                  className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600"
                />
                <span className="text-[10px] text-gray-500 leading-snug">
                  Per-radiologist overrides (e.g., President = 11/hr) live at <code className="text-gray-400">users/&#123;uid&#125;/settings/current.pvc.meetingRvuRateOverride</code> — set them manually in Firebase Console for now. Per-rad UI panel is on the roadmap.
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-400">Fiscal year start (MM-DD) — blank = calendar quarters</span>
                <input
                  type="text"
                  placeholder="07-01"
                  value={config.fiscalYearStartMonthDay ?? ''}
                  onChange={e => {
                    const v = e.target.value.trim();
                    updateConfig({ fiscalYearStartMonthDay: v === '' ? null : v });
                  }}
                  className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600"
                />
              </label>
            </div>
          </section>

          {/* ── Rotation Overlays ────────────────────────────────── */}
          <section>
            <h4 className="text-gray-300 font-medium mb-2">Rotation Overlays</h4>
            {rotations.length === 0 ? (
              <p className="text-gray-500 text-xs">No rotations configured on this system.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-700 text-gray-400">
                      <th className="text-left py-1.5 pr-3">Rotation</th>
                      <th className="text-center py-1.5 px-2">Shift count</th>
                      <th className="text-center py-1.5 px-2" title="Bonus shifts awarded by rotation, in addition to Shift count. Adds to payout without inflating the RVU/shift denominator. Example: WEEKEND CALL 1/2 = shift count 1.0, bonus shifts 1.0. Halves on half-day.">Bonus shifts</th>
                      <th className="text-center py-1.5 px-2">Bonus RVU</th>
                      <th className="text-center py-1.5 px-2" title="Flat RVU replaces this session's accrued wRVU on the qualifying session (e.g., FLUORO = 60). Leave blank for normal accrual.">Flat RVU</th>
                      <th className="text-center py-1.5 px-2">Bonus halves on half-day</th>
                      <th className="text-center py-1.5 px-2">Counts toward shift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rotations.map(name => {
                      const overlay = config.rotationConfig[name] ?? getDefaultRotationOverlay(name);
                      return (
                        <tr key={name} className="border-b border-gray-700/50">
                          <td className="text-white py-1.5 pr-3">{name}</td>
                          <td className="text-center py-1.5 px-2">
                            <input
                              type="number"
                              step="0.5"
                              min={0}
                              value={overlay.shiftCount}
                              onChange={e => updateRotationOverlay(name, { shiftCount: Math.max(0, Number(e.target.value) || 0) })}
                              className="w-20 px-2 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-center"
                            />
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <input
                              type="number"
                              step="0.5"
                              min={0}
                              value={overlay.bonusShiftCredit ?? 0}
                              onChange={e => updateRotationOverlay(name, { bonusShiftCredit: Math.max(0, Number(e.target.value) || 0) })}
                              className="w-20 px-2 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-center"
                            />
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <input
                              type="number"
                              step="0.25"
                              min={0}
                              value={overlay.bonusRvu}
                              onChange={e => updateRotationOverlay(name, { bonusRvu: Math.max(0, Number(e.target.value) || 0) })}
                              className="w-20 px-2 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-center"
                            />
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <input
                              type="number"
                              step="1"
                              min={0}
                              placeholder="—"
                              value={overlay.flatRvuOverride ?? ''}
                              onChange={e => {
                                const v = e.target.value.trim();
                                updateRotationOverlay(name, { flatRvuOverride: v === '' ? null : Math.max(0, Number(v)) });
                              }}
                              className="w-20 px-2 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-center"
                            />
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <input
                              type="checkbox"
                              checked={overlay.bonusHalvesOnHalfDay}
                              onChange={e => updateRotationOverlay(name, { bonusHalvesOnHalfDay: e.target.checked })}
                              className="w-4 h-4 rounded border-gray-600 bg-gray-700"
                            />
                          </td>
                          <td className="text-center py-1.5 px-2">
                            <input
                              type="checkbox"
                              checked={overlay.contributesToShiftCount}
                              onChange={e => updateRotationOverlay(name, { contributesToShiftCount: e.target.checked })}
                              className="w-4 h-4 rounded border-gray-600 bg-gray-700"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── CPT Adjustments ─────────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-gray-300 font-medium">CPT / Modality Adjustments</h4>
              <button
                onClick={addAdjustment}
                className="px-2 py-0.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded"
              >
                + Add
              </button>
            </div>
            {config.cptAdjustments.length === 0 ? (
              <p className="text-gray-500 text-xs">No adjustments. Practice uses CMS wRVU values as-is.</p>
            ) : (
              <div className="space-y-2">
                {config.cptAdjustments.map(adj => (
                  <div key={adj.id} className="bg-gray-900/50 p-2 rounded space-y-1.5">
                  <div className="grid grid-cols-[1fr_120px_140px_100px_100px_70px_auto] gap-2 items-center">
                    <input
                      type="text"
                      value={adj.label}
                      onChange={e => updateAdjustment(adj.id, { label: e.target.value })}
                      placeholder="Label"
                      className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600 text-xs"
                    />
                    <select
                      value={adj.matchType}
                      onChange={e => updateAdjustment(adj.id, { matchType: e.target.value as CptAdjustmentMatchType })}
                      className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600 text-xs"
                    >
                      <option value="modality">Modality</option>
                      <option value="bodyPart">Body part</option>
                      <option value="cptPrefix">CPT prefix</option>
                      <option value="cptList">CPT list (csv)</option>
                      <option value="description">Description contains</option>
                    </select>
                    <input
                      type="text"
                      value={Array.isArray(adj.matchValue) ? adj.matchValue.join(',') : adj.matchValue}
                      onChange={e => {
                        const v = e.target.value;
                        const nextValue = adj.matchType === 'cptList'
                          ? v.split(',').map(s => s.trim()).filter(Boolean)
                          : v;
                        updateAdjustment(adj.id, { matchValue: nextValue });
                      }}
                      placeholder="Match value"
                      className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600 text-xs"
                    />
                    <select
                      value={adj.operation}
                      onChange={e => updateAdjustment(adj.id, { operation: e.target.value as 'add' | 'multiply' })}
                      className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600 text-xs"
                    >
                      <option value="add">Add</option>
                      <option value="multiply">Multiply</option>
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      value={adj.amount}
                      onChange={e => updateAdjustment(adj.id, { amount: Number(e.target.value) || 0 })}
                      className="px-2 py-1 bg-gray-700 text-white rounded border border-gray-600 text-xs text-right"
                    />
                    <label className="flex items-center justify-center gap-1 text-xs text-gray-400">
                      <input
                        type="checkbox"
                        checked={!adj.disabled}
                        onChange={e => updateAdjustment(adj.id, { disabled: !e.target.checked })}
                        className="w-3 h-3 rounded border-gray-600 bg-gray-700"
                      />
                      On
                    </label>
                    <button
                      onClick={() => deleteAdjustment(adj.id)}
                      className="px-2 py-1 text-xs bg-red-900 hover:bg-red-800 text-white rounded"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                  {/* Secondary row: rotation filter (checkboxes) + personally-performed gate */}
                  <div className="flex flex-col gap-1.5 text-[11px] text-gray-400 pl-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>Applicable rotations (none checked = applies to all):</span>
                      {rotations.length === 0 && <span className="text-gray-500 italic">no rotations configured</span>}
                      {rotations.map(rotName => {
                        const selected = Array.isArray(adj.applicableToRotations) && adj.applicableToRotations.includes(rotName);
                        return (
                          <label key={rotName} className="flex items-center gap-1 bg-gray-800 px-2 py-0.5 rounded border border-gray-700 hover:border-gray-500 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={e => {
                                const current = Array.isArray(adj.applicableToRotations) ? [...adj.applicableToRotations] : [];
                                const next = e.target.checked
                                  ? [...current, rotName]
                                  : current.filter(r => r !== rotName);
                                updateAdjustment(adj.id, { applicableToRotations: next.length > 0 ? next : null });
                              }}
                              className="w-3 h-3 rounded border-gray-600 bg-gray-700"
                            />
                            <span className="text-gray-300">{rotName}</span>
                          </label>
                        );
                      })}
                    </div>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!adj.requiresPersonallyPerformed}
                        onChange={e => updateAdjustment(adj.id, { requiresPersonallyPerformed: e.target.checked })}
                        className="w-3 h-3 rounded border-gray-600 bg-gray-700"
                      />
                      Requires "Personally Performed" toggle (rad must click the button at study time)
                    </label>
                  </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-gray-500 mt-2">
              Ordering: all Add ops fire first, then all Multiply ops, in row order. Adjustments apply at the wRVU chokepoint —
              radiologists see only the corrected value (raw CMS value stored for audit).
            </p>
          </section>

          {/* ── Productivity Tiers ──────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-gray-300 font-medium">Productivity Tiers</h4>
              <button
                onClick={addTier}
                className="px-2 py-0.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded"
              >
                + Add tier
              </button>
            </div>
            <details className="mb-2 text-[11px] text-gray-400 bg-gray-900/40 rounded p-2">
              <summary className="cursor-pointer hover:text-gray-200 select-none">What do these settings mean?</summary>
              <div className="mt-2 space-y-1.5 pl-3">
                <div><span className="text-gray-300">Active</span>: turn the bonus-shift math on or off without deleting the tier rows.</div>
                <div><span className="text-gray-300">Allow negative bonus</span>: months below the lowest tier threshold deduct shifts (the formula goes negative). Off = clamp to zero.</div>
                <div><span className="text-gray-300">Mode — Marginal</span> (recommended): each tier contributes only its own slice. Above 60, the 50→60 contribution is capped at its max. <em>User group's formula uses this.</em></div>
                <div><span className="text-gray-300">Mode — Stacked</span>: each tier above its threshold counts <em>everything</em> above the threshold, so the lower-tier rate keeps applying past its slice. Over-credits at the upper end.</div>
                <div><span className="text-gray-300">Period</span>: how the Adjusted wRVU average is computed for the tier formula. Monthly is typical.</div>
                <div className="text-gray-500 pt-1">Tier rows: <span className="text-gray-300">Threshold</span> = the wRVU/shift cutoff this tier starts at. <span className="text-gray-300">Multiplier</span> = bonus-shifts-per-RVU within this tier's slice. E.g. 50/0.02 and 60/0.01667 yields the user group's 50–60 full rate, 60+ at 80% rate.</div>
              </div>
            </details>
            <div className="flex gap-4 mb-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={config.productivityTiersActive}
                  onChange={e => updateConfig({ productivityTiersActive: e.target.checked })}
                  className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-700"
                />
                Active (compute bonus shifts in reports)
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={config.allowNegativeBonus}
                  onChange={e => updateConfig({ allowNegativeBonus: e.target.checked })}
                  className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-700"
                />
                Allow negative bonus (months below lowest threshold deduct shifts)
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                Mode:
                <select
                  value={config.productivityTierMode}
                  onChange={e => updateConfig({ productivityTierMode: e.target.value as 'stacked' | 'marginal' })}
                  className="px-1 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-xs"
                >
                  <option value="marginal">Marginal (recommended)</option>
                  <option value="stacked">Stacked</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                Period:
                <select
                  value={config.productivityTierPeriod}
                  onChange={e => updateConfig({ productivityTierPeriod: e.target.value as 'daily' | 'monthly' | 'quarterly' })}
                  className="px-1 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-xs"
                >
                  <option value="daily">Daily</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                </select>
              </label>
            </div>
            {config.productivityTiers.length === 0 ? (
              <p className="text-gray-500 text-xs">No tiers. Productivity bonus shift-equivalents not computed.</p>
            ) : (
              <div className="space-y-1">
                {config.productivityTiers.map((tier, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400 w-20">Threshold</span>
                    <input
                      type="number"
                      step="1"
                      value={tier.thresholdDailyWrvu}
                      onChange={e => updateTier(idx, { thresholdDailyWrvu: Number(e.target.value) || 0 })}
                      className="w-20 px-2 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-right"
                    />
                    <span className="text-gray-400 w-20">× multiplier</span>
                    <input
                      type="number"
                      step="0.01"
                      value={tier.multiplier}
                      onChange={e => updateTier(idx, { multiplier: Number(e.target.value) || 0 })}
                      className="w-20 px-2 py-0.5 bg-gray-700 text-white rounded border border-gray-600 text-right"
                    />
                    <button
                      onClick={() => deleteTier(idx)}
                      className="px-2 py-0.5 bg-red-900 hover:bg-red-800 text-white rounded"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          </fieldset>

          {error && <p className="text-red-400 text-xs">{error}</p>}

          <div className="flex gap-2 pt-2 border-t border-gray-700">
            {canEdit && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
            >
              {canEdit ? 'Cancel' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
