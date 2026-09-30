export interface Mailer {
  send(to: string): string;
}
export const Mailer: { readonly key: symbol; readonly name: string; readonly __type?: Mailer } = {
  key: Symbol('Mailer'),
  name: 'Mailer',
};
