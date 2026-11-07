import type { PageProps } from '@marmeon/http';
import { AudienceSection } from '../components/landing/AudienceSection.tsx';
import { BatteriesSection } from '../components/landing/BatteriesSection.tsx';
import { ChainSection } from '../components/landing/ChainSection.tsx';
import { DevtoolsSection } from '../components/landing/DevtoolsSection.tsx';
import { HeroSection } from '../components/landing/HeroSection.tsx';
import { ModulesSection } from '../components/landing/ModulesSection.tsx';
import { PrinciplesSection } from '../components/landing/PrinciplesSection.tsx';
import { SecureSection } from '../components/landing/SecureSection.tsx';
import { StartSection } from '../components/landing/StartSection.tsx';
import { TestingSection } from '../components/landing/TestingSection.tsx';
import { SiteHead } from '../components/SiteHead.tsx';
import type { ShowLandingController } from '../controllers/ShowLandingController.ts';
import { DESCRIPTIONS } from '../descriptions.ts';

/** `/`: what Marmeon is, its principles, who it is for, one type followed from the database to the form, and the rest of the framework in six sections. */
export default function Landing({ snippets }: PageProps<ShowLandingController>) {
  return (
    <div className="landing">
      <SiteHead title="" description={DESCRIPTIONS.landing} path="/" />
      <HeroSection snippets={snippets} />
      <PrinciplesSection />
      <AudienceSection />
      <ChainSection snippets={snippets} />
      <ModulesSection />
      <BatteriesSection />
      <SecureSection />
      <TestingSection snippet={snippets.test} />
      <DevtoolsSection />
      <StartSection />
    </div>
  );
}
