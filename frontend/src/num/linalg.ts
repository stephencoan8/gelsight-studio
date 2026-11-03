/** Least squares. Well-conditioned systems (the plate transfer) match a normal-equation solve.
 * Rank-deficient ones (the quadratic photometric fit, which has nx²+ny²+nz² = 1) get a tiny ridge so a solution exists; predictions, not coefficients, are what the tests lock. */

export function lstsq(A: number[][], b: number[], ridge = 0): number[] {
  const m = A.length;
  const n = A[0]?.length ?? 0;
  const ata = Array.from({ length: n }, () => new Array(n).fill(0));
  const atb = new Array(n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      atb[j] += A[i][j] * b[i];
      for (let k = j; k < n; k++) ata[j][k] += A[i][j] * A[i][k];
    }
  }
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j; k++) ata[j][k] = ata[k][j];
    ata[j][j] += ridge;
  }
  return solve(ata, atb);
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const M = a.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    [M[k], M[piv]] = [M[piv], M[k]];
    const div = M[k][k] || 1e-18;
    for (let j = k; j <= n; j++) M[k][j] /= div;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = M[i][k];
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  return M.map((row) => row[n]);
}

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i])) {
      s += xs[i];
      n++;
    }
  }
  return n ? s / n : NaN;
}

export function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}
