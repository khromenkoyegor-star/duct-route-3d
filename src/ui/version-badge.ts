/** Текст версії: «версія 7b4f70f · 08.11.2026, 10:06» (дата збірки за місцевим часом). */
export function versionText(version: string, buildDateIso: string): string {
  const date = new Date(buildDateIso);
  const when = Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
  return when ? `версія ${version} · ${when}` : `версія ${version}`;
}

/** Дрібний підпис з версією: видно, що відкрилась свіжа версія (Safari любить кешувати). */
export function createVersionBadge(floating = false): HTMLElement {
  const badge = document.createElement('p');
  badge.className = floating ? 'version-badge version-badge--floating' : 'version-badge';
  badge.dataset.testid = 'version';
  badge.textContent = versionText(__APP_VERSION__, __BUILD_DATE__);
  return badge;
}
