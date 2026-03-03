// Hook: Resolve user role from Firestore config documents
// Priority: globalAdmin > admin > president > hospitalAdmin > it > radiologist
// Now reads only 2 documents: config/admins (global) + config/systemSettings/{system} (per-system roles + toggles)

import { useState, useEffect } from 'react';
import { firestoreService } from '../services/firestore';
import type { UserRole } from '../types/reports';

interface UseUserRoleResult {
  role: UserRole;
  hospitalAdminIndividualAccess: boolean;
  adminIndividualAccess: boolean;
  loading: boolean;
}

export function useUserRole(userId: string | null, system?: string | null): UseUserRoleResult {
  const [role, setRole] = useState<UserRole>('radiologist');
  const [hospitalAdminIndividualAccess, setHospitalAdminIndividualAccess] = useState(false);
  const [adminIndividualAccess, setAdminIndividualAccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) {
      setRole('radiologist');
      setHospitalAdminIndividualAccess(false);
      setAdminIndividualAccess(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    // 2 Firestore reads: global admin check + per-system settings
    const settingsPromise = system
      ? firestoreService.getSystemSettings(system)
      : Promise.resolve({
          admins: {} as Record<string, boolean>, presidents: {} as Record<string, boolean>,
          hospitalAdmins: {} as Record<string, boolean>, itAccess: {} as Record<string, boolean>,
          hospitalAdminIndividualAccess: false, adminIndividualAccess: false,
        });

    Promise.all([
      firestoreService.checkIsAdmin(userId),
      settingsPromise,
    ])
      .then(([isGlobalAdmin, settings]) => {
        if (cancelled) return;

        // Priority: globalAdmin > admin > president > hospitalAdmin > it > radiologist
        if (isGlobalAdmin) setRole('globalAdmin');
        else if (settings.admins[userId] === true) setRole('admin');
        else if (settings.presidents[userId] === true) setRole('president');
        else if (settings.hospitalAdmins[userId] === true) setRole('hospitalAdmin');
        else if (settings.itAccess[userId] === true) setRole('it');
        else setRole('radiologist');

        setHospitalAdminIndividualAccess(settings.hospitalAdminIndividualAccess);
        setAdminIndividualAccess(settings.adminIndividualAccess);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setRole('radiologist');
        setHospitalAdminIndividualAccess(false);
        setAdminIndividualAccess(false);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [userId, system]);

  return { role, hospitalAdminIndividualAccess, adminIndividualAccess, loading };
}
