/**
 * Turn a human task name into a git-branch-friendly slug (DESIGN §5.4). Pure, so
 * the New-Task modal can prefill the (editable) branch field without a round-trip.
 *
 * Rules: lowercase; keep `[a-z0-9]` and `/` (branches are commonly namespaced,
 * e.g. `feature/…`); collapse every other run (including typed `-`/`_`) into a
 * single `_`; trim stray separators. `'Feature / Add Feature 1'` →
 * `'feature/add_feature_1'`, `'Add Feature 1'` → `'add_feature_1'`.
 */
export function taskNameToBranchSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, '_') // non-slug runs → single underscore
    .replace(/_*\/_*/g, '/') // drop underscores hugging a slash (may create `//`)
    .replace(/\/+/g, '/') // then collapse repeated slashes
    .replace(/^[_/]+|[_/]+$/g, '') // trim leading/trailing separators
}
