// Which form fields live validation may check — checked by `tsc` (pnpm build / typecheck), never run.
import type { CheckLiveField, LiveField } from './page.ts';

interface Form {
  name: string;
  email: string;
  zip_code: string;
  password: string;
  passcode: string;
  cardNumber: string;
  cvc: string;
  otpCode: string;
  user_totp: string;
  userOTP: string;
  userTOTP: string;
  api_token: string;
  FOOTPRINT: string;
  ROOTPATH: string;
}

export const checked: [CheckLiveField<Form, 'name'>, CheckLiveField<Form, 'email'>, CheckLiveField<Form, 'zip_code'>] = ['name', 'email', 'zip_code'];
export const capitals: [CheckLiveField<Form, 'FOOTPRINT'>, CheckLiveField<Form, 'ROOTPATH'>] = ['FOOTPRINT', 'ROOTPATH'];
export const fields: LiveField<Form>[] = ['name', 'email', 'zip_code'];

// @ts-expect-error — a one-time code is not a field to check live
export const otp: LiveField<Form> = 'otpCode';
// @ts-expect-error — nor a password by another name
export const passcode: CheckLiveField<Form, 'passcode'> = 'passcode';
// @ts-expect-error — nor a card number
export const card: CheckLiveField<Form, 'cardNumber'> = 'cardNumber';
// @ts-expect-error — nor a card security code
export const cvc: CheckLiveField<Form, 'cvc'> = 'cvc';
// @ts-expect-error — nor an authenticator code
export const totp: CheckLiveField<Form, 'user_totp'> = 'user_totp';
// @ts-expect-error — nor the acronym in capitals
export const upperOtp: CheckLiveField<Form, 'userOTP'> = 'userOTP';
// @ts-expect-error — nor the acronym in capitals
export const upperTotp: CheckLiveField<Form, 'userTOTP'> = 'userTOTP';
// @ts-expect-error — nor a token
export const token: CheckLiveField<Form, 'api_token'> = 'api_token';
// @ts-expect-error — a field the form does not have
export const missing: CheckLiveField<Form, 'emial'> = 'emial';
