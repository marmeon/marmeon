import { encode } from 'uqr';

/** A QR code as a module count and one SVG path (`<svg viewBox="0 0 size size"><path d>`), so a page needs neither `innerHTML` nor `style`. */
export interface QrPath {
  readonly size: number;
  readonly path: string;
}

/** Encodes `text` (error correction M, no quiet zone — the page adds its own margin) as horizontal runs of dark modules. */
export function qrPath(text: string): QrPath {
  const { size, data } = encode(text, { ecc: 'M', border: 0 });
  let path = '';
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      path += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  });
  return { size, path };
}
