/* Neumann DCT Poisson integration.
   Orthonormal DCT-II via a mixed-radix FFT (Cooley–Tukey, radix-2, Rader for 257).
   The divergence stencil and the DCT eigenvalues match the study's poisson_dct. */
#include <stddef.h>
#define PI 3.14159265358979323846
static void copyd(double* d, const double* s, int n) {
  for (int i = 0; i < n; i++) d[i] = s[i];
}
#define MAXN 4096
#define ARENA (MAXN * 48)

static double arena[ARENA];
static int arena_used;

static double* take(int n) {
  double* p = arena + arena_used;
  arena_used += n;
  return p;
}

/* Largest power of two dividing n, or the smallest odd factor when n is odd. */
static int split_factor(int n) {
  int p = 1;
  while ((n & 1) == 0) {
    n >>= 1;
    p <<= 1;
  }
  if (p > 1) return p;
  for (int d = 3; d * d <= n; d += 2)
    if (n % d == 0) return d;
  return n;
}

static void swapd(double* a, double* b) {
  double t = *a;
  *a = *b;
  *b = t;
}

static void radix2(int n, double* re, double* im) {
  int lg = 0;
  for (int x = n; x > 1; x >>= 1) lg++;
  for (int i = 0; i < n; i++) {
    int j = 0, x = i;
    for (int b = 0; b < lg; b++) {
      j = (j << 1) | (x & 1);
      x >>= 1;
    }
    if (j > i) {
      swapd(&re[i], &re[j]);
      swapd(&im[i], &im[j]);
    }
  }
  for (int s = 2; s <= n; s <<= 1) {
    int h = s >> 1;
    double base = -2 * PI / s;
    double dwr = __builtin_cos(base), dwi = __builtin_sin(base);
    for (int i = 0; i < n; i += s) {
      double wr = 1, wi = 0;
      for (int k = 0; k < h; k++) {
        int a = i + k, b = a + h;
        double tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        double nwr = wr * dwr - wi * dwi;
        wi = wr * dwi + wi * dwr;
        wr = nwr;
      }
    }
  }
}

/* Primitive root 3 modulo 257. a[i] = x[g^i], b[i] = exp(-2πi g^{-i}/p),
   X[g^{-k}] = x[0] + ifft(fft(a)*fft(b))[k]. */
static int rader_ok = 0;
static int IND[256], INVI[256];
static double BR[256], BI[256];

static void fft_rec(int n, const double* re, const double* im, double* ore, double* oim);

static void rader257(const double* re, const double* im, double* ore, double* oim) {
  const int n = 256, p = 257;
  double ar[256], ai[256];
  double sr = re[0], si = im[0];
  for (int i = 1; i < p; i++) {
    sr += re[i];
    si += im[i];
  }
  for (int i = 0; i < n; i++) {
    ar[i] = re[IND[i]];
    ai[i] = im[IND[i]];
  }
  radix2(n, ar, ai);
  for (int i = 0; i < n; i++) {
    double tr = ar[i] * BR[i] - ai[i] * BI[i];
    ai[i] = ar[i] * BI[i] + ai[i] * BR[i];
    ar[i] = tr;
  }
  for (int i = 0; i < n; i++) ai[i] = -ai[i];
  radix2(n, ar, ai);
  for (int i = 0; i < n; i++) {
    ar[i] /= n;
    ai[i] = -ai[i] / n;
  }
  ore[0] = sr;
  oim[0] = si;
  for (int k = 0; k < n; k++) {
    ore[INVI[k]] = re[0] + ar[k];
    oim[INVI[k]] = im[0] + ai[k];
  }
}

static void init_rader(void) {
  if (rader_ok) return;
  const int n = 256, p = 257, g = 3, ginv = 86; /* 3*86 = 258 ≡ 1 (mod 257) */
  IND[0] = 1;
  INVI[0] = 1;
  for (int i = 1; i < n; i++) {
    IND[i] = (int)((long)IND[i - 1] * g % p);
    INVI[i] = (int)((long)INVI[i - 1] * ginv % p);
  }
  double br[256], bi[256];
  for (int i = 0; i < n; i++) {
    double ang = -2 * PI * INVI[i] / p;
    br[i] = __builtin_cos(ang);
    bi[i] = __builtin_sin(ang);
  }
  radix2(n, br, bi);
  copyd(BR, br, 256);
  copyd(BI, bi, 256);
  rader_ok = 1;
}

static void direct(int n, const double* re, const double* im, double* ore, double* oim) {
  for (int k = 0; k < n; k++) {
    double sr = 0, si = 0;
    for (int t = 0; t < n; t++) {
      double ang = -2 * PI * k * t / n, c = __builtin_cos(ang), s = __builtin_sin(ang);
      sr += re[t] * c - im[t] * s;
      si += re[t] * s + im[t] * c;
    }
    ore[k] = sr;
    oim[k] = si;
  }
}

static void fft_rec(int n, const double* re, const double* im, double* ore, double* oim) {
  if (n == 1) {
    ore[0] = re[0];
    oim[0] = im[0];
    return;
  }
  if ((n & (n - 1)) == 0) {
    copyd(ore, re, n);
    copyd(oim, im, n);
    radix2(n, ore, oim);
    return;
  }
  if (n == 257) {
    init_rader();
    rader257(re, im, ore, oim);
    return;
  }
  int n1 = split_factor(n);
  if (n1 == n) {
    direct(n, re, im, ore, oim);
    return;
  }
  int n2 = n / n1;
  int mark = arena_used;
  double* tre = take(n);
  double* tim = take(n);
  double* colr = take(n1);
  double* coli = take(n1);
  double* cr = take(n1);
  double* ci = take(n1);
  for (int j = 0; j < n2; j++) {
    for (int i = 0; i < n1; i++) {
      colr[i] = re[i * n2 + j];
      coli[i] = im[i * n2 + j];
    }
    int before = arena_used;
    fft_rec(n1, colr, coli, cr, ci);
    arena_used = before;
    for (int i = 0; i < n1; i++) {
      tre[i * n2 + j] = cr[i];
      tim[i * n2 + j] = ci[i];
    }
  }
  double* rowr = take(n2);
  double* rowi = take(n2);
  double* rr = take(n2);
  double* ri = take(n2);
  for (int i = 0; i < n1; i++) {
    double ang = -2 * PI * i / n;
    double dwr = __builtin_cos(ang), dwi = __builtin_sin(ang);
    double wr = 1, wi = 0;
    for (int j = 0; j < n2; j++) {
      double ar = tre[i * n2 + j], ai = tim[i * n2 + j];
      rowr[j] = ar * wr - ai * wi;
      rowi[j] = ar * wi + ai * wr;
      double nwr = wr * dwr - wi * dwi;
      wi = wr * dwi + wi * dwr;
      wr = nwr;
    }
    int before = arena_used;
    fft_rec(n2, rowr, rowi, rr, ri);
    arena_used = before;
    for (int j = 0; j < n2; j++) {
      ore[i + n1 * j] = rr[j];
      oim[i + n1 * j] = ri[j];
    }
  }
  arena_used = mark;
  (void)mark;
}

/* Orthonormal DCT-II and its inverse, length n, in place. */
static void dct_fwd(int n, double* x) {
  int mark = arena_used;
  double* re = take(n);
  double* im = take(n);
  double* ore = take(n);
  double* oim = take(n);
  for (int i = 0; i < n / 2; i++) {
    re[i] = x[2 * i];
    re[n - 1 - i] = x[2 * i + 1];
  }
  if (n & 1) re[(n - 1) / 2] = x[n - 1];
  for (int i = 0; i < n; i++) im[i] = 0;
  fft_rec(n, re, im, ore, oim);
  double s0 = __builtin_sqrt(1.0 / n), s1 = __builtin_sqrt(2.0 / n);
  double dang = -PI / (2 * n);
  double dcr = __builtin_cos(dang), dci = __builtin_sin(dang);
  double cr = 1, ci = 0;
  for (int k = 0; k < n; k++) {
    x[k] = (ore[k] * cr - oim[k] * ci) * (k ? s1 : s0);
    double nr = cr * dcr - ci * dci;
    ci = cr * dci + ci * dcr;
    cr = nr;
  }
  arena_used = mark;
}

static void dct_inv(int n, double* x) {
  int mark = arena_used;
  double* re = take(n);
  double* im = take(n);
  double* ore = take(n);
  double* oim = take(n);
  double s0 = __builtin_sqrt(1.0 / n), s1 = __builtin_sqrt(2.0 / n);
  double dang = PI / (2 * n);
  double dcr = __builtin_cos(dang), dci = __builtin_sin(dang);
  double cr0 = 1, ci0 = 0;
  for (int k = 0; k < n; k++) {
    double xk = x[k] / (k ? s1 : s0);
    double xn = k ? x[n - k] / s1 : 0;
    re[k] = xk * cr0 + xn * ci0;
    im[k] = -(xk * ci0 - xn * cr0);
    double nr = cr0 * dcr - ci0 * dci;
    ci0 = cr0 * dci + ci0 * dcr;
    cr0 = nr;
  }
  fft_rec(n, re, im, ore, oim);
  for (int i = 0; i < n / 2; i++) {
    x[2 * i] = ore[i] / n;
    x[2 * i + 1] = ore[n - 1 - i] / n;
  }
  if (n & 1) x[n - 1] = ore[(n - 1) / 2] / n;
  arena_used = mark;
}

static void dct_rows(double* a, int r, int c, int inv) {
  double* row = take(c);
  for (int i = 0; i < r; i++) {
    copyd(row, a + (size_t)i * c, c);
    if (inv) dct_inv(c, row);
    else dct_fwd(c, row);
    copyd(a + (size_t)i * c, row, c);
  }
}

static void dct_cols(double* a, int r, int c, int inv) {
  double* col = take(r);
  for (int j = 0; j < c; j++) {
    for (int i = 0; i < r; i++) col[i] = a[(size_t)i * c + j];
    if (inv) dct_inv(r, col);
    else dct_fwd(r, col);
    for (int i = 0; i < r; i++) a[(size_t)i * c + j] = col[i];
  }
}

extern unsigned char __heap_base;
static unsigned long HP = 0;
__attribute__((export_name("alloc"))) void* palloc(unsigned long nb) {
  if (!HP) HP = (unsigned long)&__heap_base;
  unsigned long p = (HP + 15) & ~15UL;
  HP = p + nb;
  unsigned long need = (HP + 65535) / 65536, have = __builtin_wasm_memory_size(0);
  if (need > have) __builtin_wasm_memory_grow(0, need - have);
  return (void*)p;
}
__attribute__((export_name("preset"))) void preset(void) { HP = 0; }

__attribute__((export_name("dct_rows"))) void dct_rows_ex(double* a, int r, int c, int inv) {
  int mark = arena_used;
  dct_rows(a, r, c, inv);
  arena_used = mark;
}

__attribute__((export_name("transpose"))) void transpose(const double* a, int r, int c, double* b) {
  for (int i = 0; i < r; i++)
    for (int j = 0; j < c; j++) b[(size_t)j * r + i] = a[(size_t)i * c + j];
}

static void eigendiv(double* z, int r, int c) {
  for (int i = 0; i < r; i++) {
    double ci = __builtin_cos(PI * i / r);
    double dang = PI / c, dcr = __builtin_cos(dang), dci = __builtin_sin(dang), cr = 1, sr = 0;
    for (int j = 0; j < c; j++) {
      double d = (i || j) ? 2 * cr + 2 * ci - 4 : 1;
      z[(size_t)i * c + j] = (i || j) ? z[(size_t)i * c + j] / d : 0;
      double nr = cr * dcr - sr * dci;
      sr = cr * dci + sr * dcr;
      cr = nr;
    }
  }
}

__attribute__((export_name("eigendiv"))) void eigendiv_ex(double* z, int r, int c) { eigendiv(z, r, c); }

__attribute__((export_name("poisson"))) void poisson(const double* p, const double* q, int r, int c, double* z) {
  size_t n = (size_t)r * (size_t)c;
  for (size_t k = 0; k < n; k++) z[k] = 0;
  if (r < 2 || c < 2) return;
  for (int i = 0; i < r; i++) {
    size_t o = (size_t)i * c;
    for (int j = 1; j < c - 1; j++) z[o + j] = (p[o + j + 1] - p[o + j - 1]) / 2;
    z[o] = (p[o] + p[o + 1]) / 2;
    z[o + c - 1] = -(p[o + c - 1] + p[o + c - 2]) / 2;
  }
  for (int j = 0; j < c; j++) {
    for (int i = 1; i < r - 1; i++) z[(size_t)i * c + j] += (q[(size_t)(i + 1) * c + j] - q[(size_t)(i - 1) * c + j]) / 2;
    z[j] += (q[j] + q[c + j]) / 2;
    z[(size_t)(r - 1) * c + j] += -(q[(size_t)(r - 1) * c + j] + q[(size_t)(r - 2) * c + j]) / 2;
  }
  int mark = arena_used;
  dct_rows(z, r, c, 0);
  dct_cols(z, r, c, 0);
  arena_used = mark;
  eigendiv(z, r, c);
  dct_rows(z, r, c, 1);
  dct_cols(z, r, c, 1);
  arena_used = mark;
  double m = 0;
  for (size_t k = 0; k < n; k++) m += z[k];
  m /= (double)n;
  for (size_t k = 0; k < n; k++) z[k] -= m;
}
