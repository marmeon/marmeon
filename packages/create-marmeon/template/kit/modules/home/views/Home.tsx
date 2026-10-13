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
    <main className="app-main">
      <Head title={t('title')} />
      <header className="hero">
        <h1>{t('heading', { app: appName })}</h1>
        <p>{t('intro')}</p>
        {user ? (
          <>
            <p>{t('signed_in', { name: user.name })}</p>
            <div className="cluster">
              <Link route="dashboard" className="button">
                {t('dashboard')}
              </Link>
            </div>
          </>
        ) : (
          <>
            <p>{t('guest')}</p>
            <div className="cluster">
              <Link route="auth.register" className="button">
                {t('register')}
              </Link>
              <Link route="auth.login" className="button-secondary">
                {t('sign_in')}
              </Link>
            </div>
          </>
        )}
      </header>
      <section aria-labelledby="next-steps">
        <h2 id="next-steps">{t('next_steps')}</h2>
        <ul className="cards">
          <li className="card">
            <h3>{t('edit_title')}</h3>
            <p className="muted">
              {t('edit_page')} <code>modules/home/views/Home.tsx</code>
            </p>
            <p className="muted">
              {t('edit_look')} <code>styles/app.css</code>
            </p>
            <p className="muted">{t('edit_module')}</p>
            <pre>
              <code>pnpm marmeon make:module notes</code>
            </pre>
          </li>
          <li className="card">
            <h3>{t('docs_title')}</h3>
            <p className="muted">{t('docs_text')}</p>
            <p>
              <a href="https://marmeon.com/docs/installation#creating-an-app" rel="noreferrer">
                {t('docs_installation')}
              </a>
              {' · '}
              <a href="https://marmeon.com/docs/structure#the-root-directory" rel="noreferrer">
                {t('docs_structure')}
              </a>
            </p>
          </li>
          <li className="card">
            <h3>{t('kit_title')}</h3>
            <p className="muted">{t('kit_text')}</p>
            <p>
              <a href="https://marmeon.com/docs/starter-kit#the-look" rel="noreferrer">
                {t('kit_link')}
              </a>
            </p>
          </li>
        </ul>
      </section>
    </main>
  );
}

Home.layout = AppLayout;
