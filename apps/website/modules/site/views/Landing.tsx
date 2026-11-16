import type { PageProps } from '@marmeon/http';
import { HOME_TITLE } from '../../../bootstrap/head.ts';
import { AgentsSection } from '../components/landing/AgentsSection.tsx';
import { AudienceSection } from '../components/landing/AudienceSection.tsx';
import { BatteriesSection } from '../components/landing/BatteriesSection.tsx';
import { ChainSection } from '../components/landing/ChainSection.tsx';
import { DevtoolsSection } from '../components/landing/DevtoolsSection.tsx';
import { HeroSection } from '../components/landing/HeroSection.tsx';
import { IslandSection } from '../components/landing/IslandSection.tsx';
import { PackagesSection } from '../components/landing/PackagesSection.tsx';
import { PrinciplesSection } from '../components/landing/PrinciplesSection.tsx';
import { SecureSection } from '../components/landing/SecureSection.tsx';
import { StartSection } from '../components/landing/StartSection.tsx';
import { TestingSection } from '../components/landing/TestingSection.tsx';
import { SiteHead } from '../components/SiteHead.tsx';
import type { ShowLandingController } from '../controllers/ShowLandingController.ts';
import { DESCRIPTIONS } from '../descriptions.ts';
import { landingNodes } from '../structured-data.ts';

/** `/`: what Marmeon is, its principles, who it is for, one type followed from the database to the form, the devtools and agents band, and the rest of the framework. */
export default function Landing({ snippets, chain, packages, packageGroups, moduleFiles }: PageProps<ShowLandingController>) {
  return (
    <div className="landing">
      <SiteHead title={HOME_TITLE} description={DESCRIPTIONS.landing} path="/" nodes={(site) => landingNodes(site, DESCRIPTIONS.landing)} />
      <HeroSection snippets={snippets} chain={chain} packages={packages} />
      <PrinciplesSection />
      <AudienceSection />
      <ChainSection snippets={snippets} chain={chain} />
      <BatteriesSection snippets={snippets} moduleFiles={moduleFiles} />
      <div className="landing-band stage">
        <DevtoolsSection />
        <AgentsSection />
      </div>
      <SecureSection />
      <div className="landing-tail">
        <div className="landing-inner landing-tail-frame">
          <TestingSection snippet={snippets.test} />
          <IslandSection snippets={snippets} />
        </div>
      </div>
      <PackagesSection packages={packages} packageGroups={packageGroups} />
      <StartSection />
    </div>
  );
}
