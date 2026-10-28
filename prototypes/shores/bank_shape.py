"""Ledge, slope and variety measures across the shore, in game m and px, for exports sharing one waterline.

usage: bank_shape.py <wide_sd.npy> name=export.png ...
ledge: convex bend along the shore normal, g(p - n) - 2 g(p) + g(p + n) negated, on land 0.5 to 12 px out.
peak: each land pixel 1 to 2 px out reads the steepest step along its normal out to 12 px. Its spread is the variety of banks.
"""
import sys, json, struct
import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None


def game(path):
    data = open(path, 'rb').read()
    pos = 8
    while True:
        n, k = struct.unpack('>I4s', data[pos:pos + 8])
        if k == b'tEXt':
            key, _, v = data[pos + 8:pos + 8 + n].partition(b'\0')
            if key == b'Description':
                m = json.loads(v)
                break
        pos += 12 + n
    raw = np.asarray(Image.open(path)).astype(np.float64)
    return (m['blackMeters'] + raw / 65535 * (m['whiteMeters'] - m['blackMeters'])) * m['heightScale'] - m['waterLevel']


sd = np.load(sys.argv[1]).astype(np.float64)
ny, nx = np.gradient(ndimage.gaussian_filter(sd, 1.0))
norm = np.maximum(np.hypot(ny, nx), 1e-6)
ny, nx = ny / norm, nx / norm
band = (sd > 0.5) & (sd < 12)
yy, xx = np.nonzero(band)
by, bx = ny[band], nx[band]
start = (sd >= 1) & (sd < 2)
sy, sx = np.nonzero(start)
qy, qx = ny[start], nx[start]
print('%-6s %-28s %-28s %-24s %s' % ('', 'ledge p50/p90/p99', 'land grade p50/p90/p99', 'peak step p10/p50/p90', 'height at 2/4/8 px p25-p75'))
for name, path in (a.split('=', 1) for a in sys.argv[2:]):
    g = game(path)
    at = lambda y, x: ndimage.map_coordinates(g, [y, x], order=1, mode='nearest')
    bend = -(at(yy - by, xx - bx) - 2 * g[band] + at(yy + by, xx + bx))
    grade = at(yy + 0.5 * by, xx + 0.5 * bx) - at(yy - 0.5 * by, xx - 0.5 * bx)
    steps = [at(sy + (i + 1) * qy, sx + (i + 1) * qx) - at(sy + i * qy, sx + i * qx) for i in range(-2, 11)]
    peak = np.max(steps, 0)
    spread = []
    for d in (2, 4, 8):
        sel = (sd > d - 0.25) & (sd < d + 0.25)
        a, c = np.percentile(g[sel], [25, 75])
        spread.append('%.2f-%.2f' % (a, c))
    print('%-6s %-28s %-28s %-24s %s' % (name, '/'.join('%.2f' % x for x in np.percentile(bend, [50, 90, 99])),
                                         '/'.join('%.2f' % x for x in np.percentile(grade, [50, 90, 99])),
                                         '/'.join('%.2f' % x for x in np.percentile(peak, [10, 50, 90])), '  '.join(spread)))
