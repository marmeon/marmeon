import { Pagination as Pages, useTranslation, type PaginationProps } from '@bespokecore/react';

/**
 * The framework's page links (`<Pagination>`, its links from the page's parsed query) with the app's words — in every language the
 * app has (`lang/<locale>.ts`, key `pagination`). Without `labels` it would speak English.
 */
export function Pagination(props: Omit<PaginationProps, 'labels'>) {
  const t = useTranslation('app');
  return (
    <Pages
      {...props}
      labels={{ navigation: t('pagination.navigation'), previous: t('pagination.previous'), next: t('pagination.next'), page: (page) => t('pagination.page', { page }) }}
    />
  );
}
