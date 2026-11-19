/** The links one user may start in a day (`oauth.link`). */
export const LINK_STARTS_PER_DAY = 20;

/**
 * The mails about linked accounts one account gets in a day. A link is mailed when its callback completes, up to ten minutes after its start,
 * so the starts of three daily windows can complete inside one day of mails; one more window of room keeps the cap above anything starts can
 * reach. Tied to the limit of the starts: raise one and the other follows.
 */
export const LINK_MAILS_PER_DAY = 4 * LINK_STARTS_PER_DAY;
