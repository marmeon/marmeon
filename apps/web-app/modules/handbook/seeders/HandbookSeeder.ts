import type { SeedContext } from '@marmeon/database';
import { HandbookRepository } from '../HandbookRepository.ts';

/**
 * A few articles and questions in English and German, saved through the repository so that
 * their search documents are written with them (at once on the `database` driver, through the queue on Meilisearch).
 */
export class HandbookSeeder {
  readonly #handbook: HandbookRepository;

  constructor(handbook: HandbookRepository) {
    this.#handbook = handbook;
  }

  async handle({ output }: SeedContext) {
    const published = new Date().toISOString();
    const articles = [
      { locale: 'en', title: 'Moving house', summary: 'What to change in your account when you move.', body: 'Update your address before the houses change hands.', audience: 'public', published_at: published },
      { locale: 'de', title: 'Umzug', summary: 'Was du im Konto änderst, wenn du umziehst.', body: 'Ändere deine Adresse, bevor die Häuser den Besitzer wechseln.', audience: 'public', published_at: published },
      { locale: 'en', title: 'Member rates', summary: 'The prices members pay.', body: 'Members pay less for every booking.', audience: 'members', published_at: published },
      { locale: 'en', title: 'Next season', summary: 'Not ready yet.', body: 'A draft that search does not find.', audience: 'public', published_at: null },
    ] as const;
    const faqs = [
      { locale: 'en', question: 'How do I change my address?', answer: 'Open your profile and edit the address.', audience: 'public', published_at: published },
      { locale: 'de', question: 'Wie ändere ich meine Adresse?', answer: 'Öffne dein Profil und bearbeite die Adresse.', audience: 'public', published_at: published },
      { locale: 'en', question: 'Where are the member rates?', answer: 'Signed in, the rates show on every booking.', audience: 'members', published_at: published },
    ] as const;
    for (const article of articles) await this.#handbook.saveArticle(article);
    for (const faq of faqs) await this.#handbook.saveFaq(faq);
    output?.info(`Made ${articles.length} handbook articles and ${faqs.length} questions.`);
  }
}
