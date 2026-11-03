/** Complex DFT. Power-of-two lengths use radix-2; other lengths use Bluestein's algorithm. */

function radix2(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function bluestein(reIn: Float64Array, imIn: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = reIn.length;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  const br = new Float64Array(m);
  const bi = new Float64Array(m);
  // a_n = x_n exp(-i π n² / N), b_n = exp(+i π n² / N), X_k = exp(-i π k² / N) (a ∗ b)_k.
  const chirp = (k: number) => {
    const ang = (Math.PI * k * k) / n;
    return [Math.cos(ang), -Math.sin(ang)] as const;
  };
  for (let k = 0; k < n; k++) {
    const [cr, ci] = chirp(k);
    re[k] = reIn[k] * cr - imIn[k] * ci;
    im[k] = reIn[k] * ci + imIn[k] * cr;
    br[k] = cr;
    bi[k] = -ci;
    if (k) {
      br[m - k] = cr;
      bi[m - k] = -ci;
    }
  }
  radix2(re, im, false);
  radix2(br, bi, false);
  for (let i = 0; i < m; i++) {
    const tr = re[i] * br[i] - im[i] * bi[i];
    const ti = re[i] * bi[i] + im[i] * br[i];
    re[i] = tr;
    im[i] = ti;
  }
  radix2(re, im, true);
  const outR = new Float64Array(n);
  const outI = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const [cr, ci] = chirp(k);
    outR[k] = re[k] * cr - im[k] * ci;
    outI[k] = re[k] * ci + im[k] * cr;
  }
  return { re: outR, im: outI };
}

export function dft(reIn: Float64Array, imIn: Float64Array, inverse = false): { re: Float64Array; im: Float64Array } {
  if (!inverse) {
    const n = reIn.length;
    if (n && (n & (n - 1)) === 0) {
      const re = reIn.slice();
      const im = imIn.slice();
      radix2(re, im, false);
      return { re, im };
    }
    return bluestein(reIn, imIn);
  }
  const re = reIn.slice();
  const im = Float64Array.from(imIn, (v) => -v);
  const f = dft(re, im, false);
  const n = reIn.length;
  return { re: Float64Array.from(f.re, (v) => v / n), im: Float64Array.from(f.im, (v) => -v / n) };
}

export function fft2(reIn: Float64Array, imIn: Float64Array, rows: number, cols: number, inverse = false): { re: Float64Array; im: Float64Array } {
  const re = reIn.slice();
  const im = imIn.slice();
  const rowR = new Float64Array(cols);
  const rowI = new Float64Array(cols);
  for (let y = 0; y < rows; y++) {
    rowR.set(re.subarray(y * cols, (y + 1) * cols));
    rowI.set(im.subarray(y * cols, (y + 1) * cols));
    const f = dft(rowR, rowI, inverse);
    re.set(f.re, y * cols);
    im.set(f.im, y * cols);
  }
  const colR = new Float64Array(rows);
  const colI = new Float64Array(rows);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      colR[y] = re[y * cols + x];
      colI[y] = im[y * cols + x];
    }
    const f = dft(colR, colI, inverse);
    for (let y = 0; y < rows; y++) {
      re[y * cols + x] = f.re[y];
      im[y * cols + x] = f.im[y];
    }
  }
  return { re, im };
}
