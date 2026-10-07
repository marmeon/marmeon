import type { PageProps } from '@marmeon/http';
import { Head, Link, usePage, useTranslation } from '@marmeon/react';
import type { ShowHomeController } from '../controllers/ShowHomeController.ts';
// The auth module's layout (make:auth): navigation, sign-out and flash messages around every page of the starter kit.
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';

type Props = PageProps<ShowHomeController>;

export default function Home({ appName }: Props) {
  const t = useTranslation('home');
  const user = usePage().props.auth?.user ?? null;
  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('heading', { app: appName })}</h1>
      <p>{t('intro')}</p>
      {user ? (
        <p>
          {t('signed_in', { name: user.name })} <Link route="dashboard">{t('dashboard')}</Link>
        </p>
      ) : (
        <p>
          {t('guest')} <Link route="auth.login">{t('sign_in')}</Link> · <Link route="auth.register">{t('register')}</Link>
        </p>
      )}
    </main>
  );
}

Home.layout = AppLayout;
