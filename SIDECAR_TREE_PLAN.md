# Sidecar CPT Tree Restructuring Plan

The current tree is auto-generated from the flat `bodyPart` field on each CPT entry via `buildCptTree.ts`. This plan replaces it with a hand-curated category hierarchy per modality with custom ordering, grouping overrides, and multi-level sub-navigation.

## CT

1. HEAD
2. NECK (includes sinus/face CTs)
3. CHEST
4. ABDOMEN
5. PELVIS
6. SPINE → CERVICAL / THORACIC / LUMBAR / COMBO
7. EXTREMITY-UPPER
8. EXTREMITY-LOWER
9. COMBO (known combinations + build-your-own)

## MR

1. HEAD → WITH / WITHOUT / WO+W
2. NECK → WITH / WITHOUT / WO+W
3. CHEST → WITH / WITHOUT / WO+W
4. ABDOMEN → WITH / WITHOUT / WO+W
5. PELVIS → WITH / WITHOUT / WO+W
6. BREAST (MRI breast codes moved from MA)
7. MSK → UPPER / LOWER
   - UPPER
     - JOINT: Shoulder, Elbow, Wrist
     - SEGMENT: Arm, Forearm, Hand
   - LOWER
     - JOINT: Hip, Knee, Ankle
     - SEGMENT: Thigh, Leg, Foot and Toes
8. SPINE → CERVICAL / THORACIC / LUMBAR → WITH / WITHOUT / WO+W
9. COMBO — known combinations as quick picks, plus select segment → add additional segments
10. MRA — list available MRA exams, WITH / WITHOUT options

## XR

1. SKULL/HEAD/NECK
2. CHEST
3. ABDOMEN
4. PELVIS
5. SPINE → CERVICAL / THORACIC / LUMBAR / COMBO
6. EXTREMITY → UPPER / LOWER

## US

1. HEAD/NECK
2. CHEST
3. ABDOMEN
4. PELVIS
5. OBSTETRICAL — all CPTs with "fetus", "fetal", or "ob" in description, EXCEPT 76830 ("Transvaginal us non-ob" → stays in PELVIS)
6. SCROTAL
7. EXTREMITY
8. VASCULAR → ARTERIAL / VENOUS / MESENTERIC / CAROTID

## FL

1. SKULL/HEAD/NECK
2. CHEST
3. ABDOMEN → BILIARY / URETEROGRAM / UPPER GI / LOWER GI
4. PELVIS
5. SPINE → CERVICAL / THORACIC / LUMBAR / COMBO
6. EXTREMITY → UPPER / LOWER

## NM

Keep current auto-generated tree.

## MA

Keep current auto-generated tree. MRI breast codes move to MR BREAST category.

## PET-CT

Keep current auto-generated tree.

## Implementation Notes

- Replace the generic `buildCptTree.ts` auto-grouping with a per-modality category map that defines the display order, grouping overrides (e.g., sinus/face → NECK), and sub-navigation levels.
- CPT entries need a mapping from their current `bodyPart` field to the new category hierarchy. This could be a static lookup table in `buildCptTree.ts` or a new field on `CptEntry`.
- COMBO screens should show known common combos (CT chest/abd/pel, MR c-spine + t-spine, etc.) as quick picks above the build-your-own flow that already exists in `ComboBuilder.tsx`.
- The MSK sub-tree (JOINT vs SEGMENT) is the deepest nesting: Modality → MSK → UPPER/LOWER → JOINT/SEGMENT → specific body part → CPT leaves.
