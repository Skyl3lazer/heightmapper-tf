"""Waterline roughness: each crossing's distance from a quadratic fitted to the crossings within 6 px. usage: roughness.py <png>..."""
import sys, json, struct
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree
Image.MAX_IMAGE_PIXELS = None

def read(path):
    data = open(path, 'rb').read(); pos, meta = 8, None
    while pos < len(data):
        n, k = struct.unpack('>I4s', data[pos:pos + 8])
        if k == b'tEXt':
            key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
            if key == b'Description': meta = json.loads(v)
        if k == b'IDAT': break
        pos += 12 + n
    return np.asarray(Image.open(path)).astype(np.float64), meta

LEVEL = float(__import__("os").environ.get("LEVEL", "0"))
for path in sys.argv[1:]:
    raw, m = read(path)
    g = (m['blackMeters'] + raw / 65535 * (m['whiteMeters'] - m['blackMeters'])) * m["heightScale"] - m["waterLevel"] - LEVEL
    pts = []
    for ax in (1, 0):
        a, b = (g[:, :-1], g[:, 1:]) if ax else (g[:-1, :], g[1:, :])
        c = (a < 0) != (b < 0); t = a[c] / (a[c] - b[c]); y, x = np.nonzero(c)
        pts.append(np.stack([y, x + t], 1) if ax else np.stack([y + t, x], 1))
    p = np.concatenate(pts)
    tree = cKDTree(p)
    rng = np.random.default_rng(1)
    idx = rng.choice(len(p), min(30000, len(p)), replace=False)
    res = []
    for i in idx:
        nb = tree.query_ball_point(p[i], 6.0)
        if len(nb) < 10: continue
        q = p[nb] - p[i]
        cov = q.T @ q / len(q)
        w, v = np.linalg.eigh(cov)
        if w[0] > 0.25 * w[1]: continue            # not a single line, a corner or a junction
        tan, nor = v[:, 1], v[:, 0]
        s, d = q @ tan, q @ nor
        A = np.stack([np.ones_like(s), s, s * s], 1)
        coef, *_ = np.linalg.lstsq(A, d, rcond=None)
        res.append(abs(coef[0]))                     # the crossing's own offset from the fitted curve
    res = np.array(res)
    print('%-40s crossings %6d  offset from local curve px: p50 %.3f p90 %.3f p99 %.3f' % (path.split('/')[-1], len(p), *np.percentile(res, [50, 90, 99])))
