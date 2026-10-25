// Type guarantees of <Image> — checked by `tsc` (pnpm build / typecheck), never run.
import { Image } from './image.tsx';

export const guarantees = [
  <Image src="/a.jpg" width={10} height={5} alt="A" />,
  <Image src="/a.jpg" width={10} height={5} alt="" />,
  <Image src={{ src: '/a.jpg', width: 10, height: 5 }} alt="A" />,
  // @ts-expect-error — a description is required (`''` for a decorative image)
  <Image src="/a.jpg" width={10} height={5} />,
  // @ts-expect-error — a plain URL needs its width
  <Image src="/a.jpg" height={5} alt="A" />,
  // @ts-expect-error — a plain URL needs its height
  <Image src="/a.jpg" width={10} alt="A" />,
  // @ts-expect-error — an image source carries its size
  <Image src={{ src: '/a.jpg', width: 10, height: 5 }} width={20} alt="A" />,
  // @ts-expect-error — `loading` is `priority`'s business
  <Image src="/a.jpg" width={10} height={5} alt="A" loading="lazy" />,
];
