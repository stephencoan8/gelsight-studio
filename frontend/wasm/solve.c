/* Per-pixel Gauss-Newton normal solve. Same kernel the Scan055 benchmark timed
   at 86 s full resolution across 6 workers. Grid 31, 15 iterations. */
#define AX 4.31994301e-04
#define AY 4.36975362e-04
#define CX 1263.20411
#define CY 1045.98562
static double FC[961 * 10], NC[961 * 3];
static inline double cl(double v, double l) { return v < -l ? -l : v > l ? l : v; }
__attribute__((export_name("solve"))) void solve(const double* yt, const double* x, const double* y, const double* q, int n, double* out) {
  const int G = 961;
  for (int a = 0; a < 31; a++)
    for (int b = 0; b < 31; b++) {
      double pp = -2 + 4.0 * b / 30, qq = -2 + 4.0 * a / 30, nx = -pp, ny = -qq, nz = 1, nn = __builtin_sqrt(nx * nx + ny * ny + 1);
      nx /= nn;
      ny /= nn;
      nz /= nn;
      int g = a * 31 + b;
      NC[g * 3] = nx;
      NC[g * 3 + 1] = ny;
      NC[g * 3 + 2] = nz;
      double* f = FC + g * 10;
      f[0] = nx * nx;
      f[1] = nx * ny;
      f[2] = nx * nz;
      f[3] = ny * ny;
      f[4] = ny * nz;
      f[5] = nz * nz;
      f[6] = nx;
      f[7] = ny;
      f[8] = nz;
      f[9] = 1;
    }
  double cp[60];
  for (int i = 0; i < n; i++) {
    double u = (x[i] - CX) * AX, v = (y[i] - CY) * AY, m[6] = {u * u, u * v, v * v, u, v, 1};
    for (int kt = 0; kt < 60; kt++) {
      double s = 0;
      for (int k = 0; k < 6; k++) s += m[k] * q[k * 60 + kt];
      cp[kt] = s;
    }
    const double* yv = yt + i * 6;
    double best = 1e300;
    int bg = 0;
    for (int g = 0; g < G; g++) {
      const double* f = FC + g * 10;
      double e = 0;
      for (int k = 0; k < 6; k++) {
        const double* c = cp + k * 10;
        double s = -yv[k];
        for (int t = 0; t < 10; t++) s += c[t] * f[t];
        e += s * s;
        if (e >= best) break;
      }
      if (e < best) {
        best = e;
        bg = g;
      }
    }
    double p = -NC[bg * 3] / NC[bg * 3 + 2], qq = -NC[bg * 3 + 1] / NC[bg * 3 + 2];
    for (int it = 0; it < 15; it++) {
      double s = __builtin_sqrt(p * p + qq * qq + 1), X = -p / s, Y = -qq / s, Z = 1 / s, s3 = s * s * s, ph[10] = {X * X, X * Y, X * Z, Y * Y, Y * Z, Z * Z, X, Y, Z, 1};
      double dp[10][3] = {{2 * X, 0, 0}, {Y, X, 0}, {Z, 0, X}, {0, 2 * Y, 0}, {0, Z, Y}, {0, 0, 2 * Z}, {1, 0, 0}, {0, 1, 0}, {0, 0, 1}, {0, 0, 0}};
      double a0 = -(1 / s) + p * p / s3, a1 = p * qq / s3, a2 = -p / s3, b0 = p * qq / s3, b1 = -(1 / s) + qq * qq / s3, b2 = -qq / s3, A11 = 1e-6, A12 = 0, A22 = 1e-6, g1 = 0, g2 = 0;
      for (int k = 0; k < 6; k++) {
        const double* c = cp + k * 10;
        double r = -yv[k], j0 = 0, j1 = 0, j2 = 0;
        for (int t = 0; t < 10; t++) {
          r += c[t] * ph[t];
          j0 += c[t] * dp[t][0];
          j1 += c[t] * dp[t][1];
          j2 += c[t] * dp[t][2];
        }
        double jp = j0 * a0 + j1 * a1 + j2 * a2, jq = j0 * b0 + j1 * b1 + j2 * b2;
        A11 += jp * jp;
        A12 += jp * jq;
        A22 += jq * jq;
        g1 += jp * r;
        g2 += jq * r;
      }
      double det = A11 * A22 - A12 * A12;
      p = cl(p - cl((A22 * g1 - A12 * g2) / det, .3), 5);
      qq = cl(qq - cl((A11 * g2 - A12 * g1) / det, .3), 5);
    }
    double s = __builtin_sqrt(p * p + qq * qq + 1);
    out[i * 3] = -p / s;
    out[i * 3 + 1] = -qq / s;
    out[i * 3 + 2] = 1 / s;
  }
}
extern unsigned char __heap_base;
static unsigned long H = 0;
__attribute__((export_name("alloc"))) void* alloc(unsigned long nb) {
  if (!H) H = (unsigned long)&__heap_base;
  unsigned long p = (H + 15) & ~15UL;
  H = p + nb;
  unsigned long need = (H + 65535) / 65536, have = __builtin_wasm_memory_size(0);
  if (need > have) __builtin_wasm_memory_grow(0, need - have);
  return (void*)p;
}
__attribute__((export_name("reset"))) void reset(void) { H = 0; }
